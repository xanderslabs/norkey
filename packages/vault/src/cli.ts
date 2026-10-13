import { parseArgs } from "node:util";
import { buildVault } from "./build.js";
import { serveVault } from "./serve-static.js";

/** Uniswap's Calibur. Same value as CALIBUR_ADDRESS in @norkey/client/calibur; the CLI runs from dist
 *  and cannot import that TypeScript source. */
const DEFAULT_CALIBUR = "0x000000005c84F8Fd50b21CAC312528A64437030e";

const USAGE = `Usage:
  norkey-vault build --rp-id <id> --api <url> --app-origin <origin>[,<origin>] --chains <id>[,<id>]
                     [--calibur <id>=<address>]... [--rp-name <name>] [--out dist-vault]
  norkey-vault serve [--dir dist-vault] [--port 5174]`;

export function parseChains(chains: string | undefined, overrides: string[] = []) {
  if (!chains) throw new Error(USAGE);
  const map = new Map<number, `0x${string}`>();
  for (const part of chains.split(",")) {
    const id = Number(part.trim());
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`--chains: "${part}" is not a chain id`);
    map.set(id, DEFAULT_CALIBUR);
  }
  for (const o of overrides) {
    const [id, address] = o.split("=");
    if (!map.has(Number(id))) throw new Error(`--calibur ${o}: chain ${id} is not in --chains`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error(`--calibur ${o}: "${address}" is not an address`);
    map.set(Number(id), address as `0x${string}`);
  }
  return [...map].map(([id, calibur]) => ({ id, calibur }));
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "rp-id": { type: "string" },
      "rp-name": { type: "string" },
      api: { type: "string" },
      "app-origin": { type: "string" },
      chains: { type: "string" },
      calibur: { type: "string", multiple: true },
      out: { type: "string", default: "dist-vault" },
      dir: { type: "string", default: "dist-vault" },
      port: { type: "string", default: "5174" },
    },
  });
  if (command === "build") {
    const rpId = values["rp-id"];
    const apiUrl = values.api;
    const appOrigins = values["app-origin"]?.split(",").map((s) => s.trim());
    if (!rpId || !apiUrl || !appOrigins?.length) throw new Error(USAGE);
    for (const o of appOrigins) {
      if (new URL(o).origin !== o) throw new Error(`--app-origin "${o}" must be a bare origin`);
    }
    const chains = parseChains(values.chains, values.calibur);
    const built = await buildVault({ rpId, rpName: values["rp-name"] ?? rpId, apiUrl, appOrigins, chains }, values.out);
    console.log(`norkey-vault: wrote ${values.out}/index.html and _headers`);
    console.log(`chains: ${chains.map((c) => `${c.id} -> ${c.calibur}`).join(", ")}`);
    console.log(`CSP: ${built.csp}`);
    return;
  }
  if (command === "serve") return serveVault(values.dir, Number(values.port));
  throw new Error(USAGE);
}
