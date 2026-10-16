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
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHarness, DESIGNATOR, latestTx, rpcAt, waitFor } from "./harness.mjs";

const h = createHarness();
const db = join(h.tmp, "e2e.db");
const forkUrl = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const rpc = rpcAt(8545);
const rpcU = rpcAt(8546);

try {
  h.start("anvil", ["--fork-url", forkUrl, "--port", "8545", "--silent"]);
  h.start("anvil", [
    "--fork-url",
    process.env.UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org",
    "--port",
    "8546",
    "--silent",
  ]);
  h.start("node", ["packages/server/dist/serve.js"], {
    NORKEY_RP_ID: "localhost",
    NORKEY_ORIGINS: "http://localhost:5174",
    NORKEY_DB: db,
  });
  await h.vault("11155111,1301");
  h.start("pnpm", ["--filter", "demo", "dev"], {
    VITE_SEPOLIA_RPC: "http://127.0.0.1:8545",
    VITE_UNICHAIN_SEPOLIA_RPC: "http://127.0.0.1:8546",
  });
  await Promise.all([
    waitFor("http://127.0.0.1:8545", { method: "POST", body: "{}" }),
    waitFor("http://127.0.0.1:8546", { method: "POST", body: "{}" }),
    waitFor("http://localhost:8787/norkey/wallet"),
    waitFor("http://localhost:5174/"),
    waitFor("http://localhost:5173/"),
  ]);
  const { page, wallet, logText } = await h.openApp();

  // 1. Create a wallet.
  await page.click("#connect");
  await wallet().getByText("Create a new wallet").click();
  // Slice 4: the backup offer comes before the popup replies. Skipped here; step 9 adds a passkey.
  await wallet().getByRole("button", { name: "Skip" }).click();
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
  assert.equal((await latestTx(rpc)).type, "0x4");
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
  const batchTx = await latestTx(rpc);
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

  // 7. Unichain Sepolia: switch, fund, and the first batch there delegates in the same transaction.
  await rpcU("anvil_setBalance", [address, "0xde0b6b3a7640000"]);
  await page.selectOption("#chain", "1301");
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("switched to Unichain Sepolia"));
  await page.fill("#to", to);
  await page.fill("#to2", to2);
  await page.click("#batch");
  await wallet().getByText("upgrades your wallet").waitFor();
  await wallet().getByText("Approve with passkey").click();
  // Step 6 reloaded the page, so this is the log's first "batch success".
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("batch success"), null, {
    timeout: 60000,
  });
  assert.equal((await rpcU("eth_getCode", [address, "latest"])).result.toLowerCase(), DESIGNATOR);
  assert.equal((await latestTx(rpcU)).type, "0x4");
  console.log("7. Unichain Sepolia: first batch delegated (type 4), status success");

  // 8. A blocked popup: window.open returns null, and the app gets 4001 and stays usable.
  // The iframes standing in for earlier popups stay in the page (a real popup closes) and shift the
  // layout under the click, so remove them first.
  await page.evaluate(() => {
    for (const f of document.querySelectorAll("iframe")) f.remove();
    window.open = () => null;
  });
  await page.click("#send");
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("popup was blocked"));
  assert.match(await logText(), /error 4001/);
  console.log("8. blocked popup: 4001");
  console.log("JOURNEY PASS");
} catch (e) {
  await h.report(e);
} finally {
  await h.close();
}
