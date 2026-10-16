// Slice 3 journey: sponsored gas. A fresh wallet sends through the NorKey paymaster proxy to a local
// ERC-4337 stack (Alto and Pimlico's mock paymaster) on a Sepolia fork, and pays no gas.
//
// Why it matters: it is the only test of the whole sponsored path (provider, proxy, paymaster,
// bundler, boundary page signing, Calibur validating on chain). The balance checks are the point:
// the wallet's balance drops by exactly the value it sent, so the paymaster paid all the gas.
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHarness, DESIGNATOR, latestTx, rpcAt, waitFor } from "./harness.mjs";

const h = createHarness();
const rpc = rpcAt(8545);
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const EXECUTOR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // anvil key 0, Alto's executor
const bal = async (x) => BigInt((await rpc("eth_getBalance", [x, "latest"])).result);
const epNonce = async (x) =>
  BigInt(
    (await rpc("eth_call", [{ to: EP, data: `0x35567e1a${x.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}` }, "latest"]))
      .result,
  );

try {
  h.start("anvil", [
    "--fork-url",
    process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
    "--port",
    "8545",
    "--silent",
  ]);
  await waitFor("http://127.0.0.1:8545", { method: "POST", body: "{}" });
  h.start("pnpm", [
    "--filter",
    "demo",
    "exec",
    "alto",
    "--entrypoints",
    EP,
    "--executor-private-keys",
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "--utility-private-key",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "--rpc-url",
    "http://127.0.0.1:8545",
    "--port",
    "4337",
    "--safe-mode",
    "false",
  ]);
  // Alto waits for a block after each contract it deploys at startup, and an automining anvil makes a
  // block only for a new transaction. Mine empty blocks until Alto listens, then stop, so every later
  // "latest" block holds the transaction under test.
  const miner = setInterval(() => rpc("evm_mine", []).catch(() => {}), 1000);
  try {
    await waitFor("http://127.0.0.1:4337", { method: "POST", body: "{}" });
  } finally {
    clearInterval(miner);
  }
  h.start("node", ["examples/demo/e2e/mock-paymaster.mjs"]);
  h.start("node", ["packages/server/dist/serve.js"], {
    NORKEY_RP_ID: "localhost",
    NORKEY_ORIGINS: "http://localhost:5174",
    NORKEY_APP_ORIGINS: "http://localhost:5173",
    NORKEY_DB: join(h.tmp, "e2e.db"),
    NORKEY_PAYMASTER_11155111: "http://127.0.0.1:3333",
    NORKEY_PAYMASTER_ALLOW: "all",
  });
  await h.vault("11155111");
  h.start("pnpm", ["--filter", "demo", "dev"], {
    VITE_SEPOLIA_RPC: "http://127.0.0.1:8545",
    VITE_SPONSORED: "11155111",
    VITE_API: "http://localhost:8787/norkey",
  });
  await Promise.all([
    waitFor("http://127.0.0.1:3333/ping"),
    waitFor("http://localhost:8787/norkey/wallet"),
    waitFor("http://localhost:5174/"),
    waitFor("http://localhost:5173/"),
  ]);
  const { page, wallet, logText } = await h.openApp();
  // The iframes standing in for finished popups stay in the page (a real popup closes). They grow the
  // page and left a later click on Send unanswered, so each step after the first removes them.
  const dropOldPopups = () => page.evaluate(() => document.querySelectorAll("iframe").forEach((f) => f.remove()));

  // 1. Create a wallet and give it 0.001 ETH, for the values it sends. Gas is the paymaster's.
  await page.click("#connect");
  await wallet().getByText("Create a new wallet").click();
  // Slice 4: the backup offer comes before the popup replies.
  await wallet().getByRole("button", { name: "Skip" }).click();
  await page.waitForFunction(() => document.getElementById("address")?.textContent?.startsWith("0x"), null, {
    timeout: 30000,
  });
  const address = await page.locator("#address").textContent();
  await rpc("anvil_setBalance", [address, "0x38d7ea4c68000"]);
  console.log("1. created", address, "with 0.001 ETH");

  // 2. A sponsored first send: delegates in the bundle, and the wallet pays only the value.
  const to = "0x000000000000000000000000000000000000bEEF";
  const toBefore = await bal(to);
  await page.fill("#to", to);
  await page.fill("#amount", "0.0001");
  await page.click("#send");
  await wallet().getByText("upgrades your wallet").waitFor();
  await wallet().getByText("Your wallet pays no ETH for gas").waitFor();
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("ETH spent on gas"), null, {
    timeout: 90000,
  });
  assert.match(await logText(), /\(success\)/);
  assert.match(await logText(), /ETH spent on gas: 0\n/);
  assert.equal((await rpc("eth_getCode", [address, "latest"])).result.toLowerCase(), DESIGNATOR);
  const bundle = await latestTx(rpc);
  assert.equal(bundle.type, "0x4");
  assert.equal(bundle.from.toLowerCase(), EXECUTOR);
  assert.equal(await bal(address), 900000000000000n);
  assert.equal((await bal(to)) - toBefore, 100000000000000n);
  console.log("2. sponsored first send: type 4 bundle from the executor, delegated, wallet paid only the value");

  // 2b. The operation reverts inside a bundle that lands: the wallet is emptied while the consent
  // screen is open, after the estimate and the sponsorship (probe, section 10). eth_sendTransaction
  // must throw, not return a bundle hash whose receipt says success (plan change 4).
  await dropOldPopups();
  await page.click("#send");
  await wallet().getByText("Your wallet pays no ETH for gas").waitFor();
  await rpc("anvil_setBalance", [address, "0x0"]);
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("error -32603"), null, {
    timeout: 90000,
  });
  assert.match(await logText(), /reverted on chain/);
  const landed = await latestTx(rpc);
  assert.equal((await rpc("eth_getTransactionReceipt", [landed.hash])).result.status, "0x1");
  assert.equal(await bal(address), 0n);
  await rpc("anvil_setBalance", [address, "0x3328b944c4000"]); // back to 0.0009 ETH: step 3 sends 0.0002 of it
  console.log("2b. reverted inside a landed bundle: eth_sendTransaction threw -32603");

  // 3. A sponsored batch of two on the now-delegated wallet: no authorization, both paid, status 200.
  const to2 = "0x000000000000000000000000000000000000cafE";
  const [b1, b2] = [await bal(to), await bal(to2)];
  await dropOldPopups();
  await page.fill("#to2", to2);
  await page.click("#batch");
  await wallet().getByText("Approve 2 calls").waitFor();
  assert.equal(await wallet().getByText("upgrades your wallet").count(), 0);
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("batch success"), null, {
    timeout: 90000,
  });
  assert.match(await logText(), /batch 0xaa36a7:op:0x[0-9a-f]{64}/);
  assert.equal((await latestTx(rpc)).type, "0x2");
  assert.equal((await bal(to)) - b1, 100000000000000n);
  assert.equal((await bal(to2)) - b2, 100000000000000n);
  assert.equal(await bal(address), 700000000000000n);
  console.log("3. sponsored batch: no authorization, both recipients paid, status 200, wallet paid only the values");

  // 3b. A batch that reverts inside a landed bundle must report 500 (viem: "failure"), not 200.
  await dropOldPopups();
  await page.click("#batch");
  await wallet().getByText("Approve 2 calls").waitFor();
  await rpc("anvil_setBalance", [address, "0x0"]);
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("batch failure"), null, {
    timeout: 90000,
  });
  await rpc("anvil_setBalance", [address, "0x27ca57357c000"]); // back to 0.0007 ETH for step 4
  console.log("3b. reverted batch inside a landed bundle: status 500");

  // 4. Reject on the consent screen: 4001, and the EntryPoint nonce does not move.
  const nonceBefore = await epNonce(address);
  await dropOldPopups();
  await page.click("#send");
  await wallet().getByText("Your wallet pays no ETH for gas").waitFor();
  await wallet().getByText("Reject").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("error 4001"));
  assert.equal(await epNonce(address), nonceBefore);
  console.log("4. reject: 4001, EntryPoint nonce unchanged");
  console.log("SPONSORED JOURNEY PASS");
} catch (e) {
  await h.report(e);
} finally {
  await h.close();
}
