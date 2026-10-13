// Slice 1 journey: create a wallet, check the server holds only ciphertext, fund it on a Sepolia
// fork, send ETH with a passkey approval, then reconnect with the existing passkey.
//
// Why it matters: this is the only test that runs the real flow end to end (server WebAuthn
// verification, PRF, wrap, boundary page under its CSP, provider, signing, broadcast). Low unit
// coverage elsewhere is safe only while this passes.
//
// Test-only transport: Chrome's virtual authenticator is scoped to one tab, and a popup is a new tab,
// so a credential made in one popup cannot be used (with its PRF) in the next. The journey swaps
// window.open for a same-tab iframe and lets the boundary page treat its parent as its opener. The
// page, the provider, and the server are the shipped code; only frame-ancestors is relaxed, here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";

const root = new URL("../../../", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "norkey-e2e-"));
const db = join(tmp, "e2e.db");
const forkUrl = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const procs = [];

function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.output = "";
  p.stdout.on("data", (d) => (p.output += d));
  p.stderr.on("data", (d) => (p.output += d));
  procs.push(p);
  return p;
}
async function waitFor(url, init) {
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
const rpc = (method, params) =>
  fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
const latestTx = async () => (await rpc("eth_getBlockByNumber", ["latest", true])).result.transactions[0];
const CALIBUR = "0x000000005c84F8Fd50b21CAC312528A64437030e";
const DESIGNATOR = `0xef0100${CALIBUR.slice(2)}`.toLowerCase();

let browser;
try {
  start("anvil", ["--fork-url", forkUrl, "--port", "8545", "--silent"]);
  start("node", ["packages/server/dist/serve.js"], {
    NORKEY_RP_ID: "localhost",
    NORKEY_ORIGINS: "http://localhost:5174",
    NORKEY_DB: db,
  });
  const vaultDir = join(tmp, "vault");
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
    "11155111",
    "--out",
    vaultDir,
  ]);
  await new Promise((r, j) => build.on("exit", (c) => (c === 0 ? r() : j(new Error(build.output)))));
  start("node", ["packages/vault/dist/bin.js", "serve", "--dir", vaultDir, "--port", "5174"]);
  start("pnpm", ["--filter", "demo", "dev"], { VITE_SEPOLIA_RPC: "http://127.0.0.1:8545" });
  await Promise.all([
    waitFor("http://127.0.0.1:8545", { method: "POST", body: "{}" }),
    waitFor("http://localhost:8787/norkey/wallet"),
    waitFor("http://localhost:5174/"),
    waitFor("http://localhost:5173/"),
  ]);

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
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
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
  globalThis.__debug = async () => {
    console.error("demo log:", await page.locator("#log").textContent().catch(() => "?"));
    for (const f of page.frames()) console.error(`frame ${f.url()}:`, (await f.locator("body").textContent().catch(() => "?"))?.slice(0, 300));
    console.error("console:\n" + consoleLines.join("\n"));
  };
  await page.goto("http://localhost:5173/");
  const wallet = () => page.frameLocator("iframe").last();
  const logText = () => page.locator("#log").textContent();

  // 1. Create a wallet.
  await page.click("#connect");
  await wallet().getByText("Create a new wallet").click();
  await page.waitForFunction(() => document.getElementById("address")?.textContent?.startsWith("0x"), null, {
    timeout: 30000,
  });
  const address = await page.locator("#address").textContent();
  console.log("1. created", address);

  // 2. The server holds one wallet and one wrap, and no plaintext.
  const sql = new DatabaseSync(db);
  const wallets = sql.prepare("SELECT address FROM wallets").all();
  const wraps = sql.prepare("SELECT kind, ciphertext FROM wraps").all();
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].address.toLowerCase(), address.toLowerCase());
  assert.equal(wraps.length, 1);
  assert.equal(wraps[0].kind, "passkey");
  assert.equal(Buffer.from(wraps[0].ciphertext, "base64url").length, 32 + 16, "AES-GCM of a 32-byte key");
  sql.close();
  console.log("2. server holds 1 wallet, 1 passkey wrap (48 bytes ciphertext)");

  // 3. Fund it on the fork.
  await rpc("anvil_setBalance", [address, "0xde0b6b3a7640000"]);
  console.log("3. funded 1 ETH on the fork");

  // 4. Send ETH, approved with the passkey.
  const to = "0x000000000000000000000000000000000000bEEF";
  const before = BigInt((await rpc("eth_getBalance", [to, "latest"])).result);
  await page.fill("#to", to);
  await page.fill("#amount", "0.0001");
  await page.click("#send");
  await wallet().getByText("upgrades your wallet").waitFor();
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("confirmed"), null, {
    timeout: 60000,
  });
  const after = BigInt((await rpc("eth_getBalance", [to, "latest"])).result);
  assert.equal(after - before, 100000000000000n);
  assert.match(await logText(), /\(success\)/);
  console.log("4. sent 0.0001 ETH, receipt success, recipient balance +0.0001");
  assert.equal((await rpc("eth_getCode", [address, "latest"])).result.toLowerCase(), DESIGNATOR);
  assert.equal((await latestTx()).type, "0x4");
  console.log("4b. first send delegated the EOA to Calibur (type 4)");

  // 5. A two-call batch on the now-delegated account: one gesture, a type-2 self-call, both paid.
  const to2 = "0x000000000000000000000000000000000000cafE";
  const bal = async (x) => BigInt((await rpc("eth_getBalance", [x, "latest"])).result);
  const [b1, b2] = [await bal(to), await bal(to2)];
  await page.fill("#to2", to2);
  await page.click("#batch");
  await wallet().getByText("Approve 2 calls").waitFor();
  assert.equal(await wallet().getByText("upgrades your wallet").count(), 0);
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("batch success"), null, {
    timeout: 60000,
  });
  assert.equal((await bal(to)) - b1, 100000000000000n);
  assert.equal((await bal(to2)) - b2, 100000000000000n);
  const batchTx = await latestTx();
  assert.equal(batchTx.type, "0x2");
  assert.equal(batchTx.to.toLowerCase(), address.toLowerCase());
  console.log("5. batch of 2 on a delegated account: type 2 self-call, both recipients paid, status success");

  // 6. Forget the address in the app, reconnect with the existing passkey.
  await page.evaluate(() => localStorage.removeItem("norkey:address"));
  await page.reload();
  await page.click("#connect");
  await wallet().getByText("Use my passkey").click();
  await page.waitForFunction(() => document.getElementById("address")?.textContent?.startsWith("0x"), null, {
    timeout: 30000,
  });
  assert.equal(await page.locator("#address").textContent(), address);
  console.log("6. reconnected to the same address");
  console.log("JOURNEY PASS");
} catch (e) {
  console.error("JOURNEY FAIL:", e);
  await globalThis.__debug?.();
  for (const p of procs) console.error(`--- ${p.spawnargs.slice(0, 2).join(" ")}\n${p.output.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
