import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { buildCsp, headersFileContent, securityHeaders } from "./headers.js";

export type BuildConfig = {
  rpId: string;
  rpName: string;
  apiUrl: string;
  appOrigins: string[];
  chains: { id: number; calibur: `0x${string}` }[];
};
export type BuiltPage = { html: string; csp: string; headers: Record<string, string> };

const MODULE_OPEN = '<script type="module">';
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

function takeAsset(assets: Map<string, string>, ref: string): string {
  const key = ref.replace(/^\.?\//, "");
  const body = assets.get(key);
  if (body === undefined) throw new Error(`norkey-vault: the page references "${ref}" but no such asset was built`);
  return body;
}

/** Inline every script and stylesheet, bake the config, then hash the final bytes into the CSP.
 *  Config is baked BEFORE hashing; a hash over pre-config bytes would describe a different page. */
export function inlinePage(html: string, assets: Map<string, string>, config: BuildConfig): BuiltPage {
  let out = html.replace(/<script[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_m, src: string) => {
    return `${MODULE_OPEN}${takeAsset(assets, src)}</script>`;
  });
  out = out.replace(/<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g, (_m, href: string) => {
    return `<style>${takeAsset(assets, href)}</style>`;
  });
  // Escape `<` so no config value can close the script tag early.
  const cfg = JSON.stringify(config).replace(/</g, "\\u003c");
  const marker = out.indexOf(MODULE_OPEN);
  if (marker === -1) throw new Error("norkey-vault: the page has no module script");
  out = `${out.slice(0, marker)}<script>window.__NORKEY_CONFIG__=${cfg}</script>${out.slice(marker)}`;

  const inline = [
    ...[...out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]),
    ...[...out.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]),
  ];
  const csp = buildCsp([...new Set(inline.map(sha256))], config.apiUrl);
  if (/\b(?:src|href)=["'][^"']+\.(?:js|css|mjs)["']/.test(out)) {
    throw new Error("norkey-vault: the page still references an un-inlined asset; the CSP would block it");
  }
  return { html: out, csp, headers: securityHeaders(csp, new URL(config.apiUrl).protocol === "https:") };
}

async function collect(dir: string, base = dir): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) for (const [k, v] of await collect(full, base)) out.set(k, v);
    else if (/\.(js|css)$/.test(entry.name))
      out.set(relative(base, full).split(sep).join("/"), await readFile(full, "utf8"));
  }
  return out;
}

/** Bundle the packaged page, inline it, and write `index.html` and `_headers` to `outDir`. */
export async function buildVault(config: BuildConfig, outDir: string): Promise<BuiltPage> {
  const staging = join(tmpdir(), `norkey-vault-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await viteBuild({
    root: fileURLToPath(new URL("../page", import.meta.url)),
    base: "./",
    logLevel: "warn",
    build: {
      outDir: staging,
      emptyOutDir: true,
      // One chunk: split output leaves modulepreload links the inliner does not fold in.
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
  const built = inlinePage(await readFile(join(staging, "index.html"), "utf8"), await collect(staging), config);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.html"), built.html);
  await writeFile(join(outDir, "_headers"), headersFileContent(built.headers));
  await writeFile(join(outDir, "headers.json"), `${JSON.stringify(built.headers, null, 2)}\n`);
  await rm(staging, { recursive: true, force: true });
  return built;
}
