// Shared by the journeys: child processes, the boundary page build, and the demo in Chrome with a
// PRF-capable virtual authenticator. journey.mjs explains why the popup becomes an iframe.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const root = new URL("../../../", import.meta.url).pathname;
export const CALIBUR = "0x000000005c84F8Fd50b21CAC312528A64437030e";
export const DESIGNATOR = `0xef0100${CALIBUR.slice(2)}`.toLowerCase();

export async function waitFor(url, init) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url, init);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}
export const rpcAt = (port) => (method, params) =>
  fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
export const latestTx = async (call) => (await call("eth_getBlockByNumber", ["latest", true])).result.transactions[0];

export function createHarness() {
  const tmp = mkdtempSync(join(tmpdir(), "norkey-e2e-"));
  const procs = [];
  let browser;
  let debug = async () => {};

  function start(cmd, args, env = {}) {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.output = "";
    p.stdout.on("data", (d) => (p.output += d));
    p.stderr.on("data", (d) => (p.output += d));
    procs.push(p);
    return p;
  }

  /** Builds the boundary page for `chains` (comma-separated ids) and serves it on :5174. */
  async function vault(chains) {
    const dir = join(tmp, "vault");
    const build = start("node", [
      "packages/vault/dist/bin.js",
      "build",
      "--rp-id",
      "localhost",
      "--api",
      "http://localhost:8787/norkey",
      "--app-origin",
      "http://localhost:5173",
      "--chains",
      chains,
      "--out",
      dir,
    ]);
    await new Promise((r, j) => build.on("exit", (c) => (c === 0 ? r() : j(new Error(build.output)))));
    start("node", ["packages/vault/dist/bin.js", "serve", "--dir", dir, "--port", "5174"]);
  }

  async function openApp() {
    // Local Network Access would block the iframe's loopback fetches (a prompt headless cannot answer).
    // Test-only: in the product the boundary page is a top-level popup and LNA does not apply.
    browser = await chromium.launch({
      channel: process.env.CH || undefined,
      args: ["--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC"],
    });
    const ctx = await browser.newContext();
    await ctx.route("http://localhost:5174/**", async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["x-frame-options"];
      headers["content-security-policy"] = headers["content-security-policy"].replace(
        "frame-ancestors 'none'",
        "frame-ancestors http://localhost:5173",
      );
      await route.fulfill({ response, headers });
    });
    await ctx.addInitScript(() => {
      if (location.port === "5173") {
        window.open = (url) => {
          const f = document.createElement("iframe");
          f.src = url;
          f.allow = "publickey-credentials-create *; publickey-credentials-get *";
          f.style.cssText = "width:420px;height:640px";
          document.body.append(f);
          return f.contentWindow;
        };
      }
      if (location.port === "5174" && window.parent !== window) {
        Object.defineProperty(window, "opener", { get: () => window.parent });
      }
    });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
      },
    });
    const consoleLines = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
    debug = async () => {
      console.error("demo log:", await page.locator("#log").textContent().catch(() => "?"));
      for (const f of page.frames())
        console.error(`frame ${f.url()}:`, (await f.locator("body").textContent().catch(() => "?"))?.slice(0, 300));
      console.error(`console:\n${consoleLines.join("\n")}`);
    };
    await page.goto("http://localhost:5173/");
    return {
      page,
      cdp,
      authenticatorId,
      wallet: () => page.frameLocator("iframe").last(),
      logText: () => page.locator("#log").textContent(),
    };
  }

  async function report(e) {
    console.error("JOURNEY FAIL:", e);
    await debug();
    for (const p of procs) console.error(`--- ${p.spawnargs.slice(0, 2).join(" ")}\n${p.output.slice(-1500)}`);
    process.exitCode = 1;
  }

  async function close() {
    await browser?.close();
    for (const p of procs) p.kill();
    rmSync(tmp, { recursive: true, force: true });
  }

  return { tmp, start, vault, openApp, report, close };
}
