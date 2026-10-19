// Slice 5 journey (spec section 8, test 4): custom auth mode on Postgres. The app's own sign-in
// decides who the user is. Steps: signed out, connect rejects with 4100; app user alice creates a
// wallet, sends, and adds a second passkey; alice signs out and bob signs in, and connect opens the
// popup instead of returning alice's address; bob's app cookie with alice's NorKey cookie opens
// nothing; alice signs back in and unlocks the same wallet.
//
// Why it matters: this is the only test that runs custom mode end to end (getUserId on the app's
// cookie, the Postgres adapter, the page's custom-mode screens, and the provider forgetting the
// address on sign-out). Low unit coverage elsewhere is safe only while this passes.
//
// Test-only transport: Chrome's virtual authenticator is scoped to one tab, and a popup is a new tab,
// so a credential made in one popup cannot be used (with its PRF) in the next. The journey swaps
// window.open for a same-tab iframe and lets the boundary page treat its parent as its opener. The
// page, the provider, and the server are the shipped code; only frame-ancestors is relaxed, here.
//
// Needs Postgres: `pnpm db:up`, then DATABASE_URL=postgres://norkey:norkey@localhost:54329/norkey.
import assert from "node:assert/strict";
import postgres from "postgres";
import { createHarness, latestTx, rpcAt, waitFor } from "./harness.mjs";

if (!process.env.DATABASE_URL) {
  console.error("JOURNEY FAIL: set DATABASE_URL to a Postgres database (run `pnpm db:up` first).");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 5, onnotice: () => {} });
try {
  await sql`SELECT 1`;
} catch (e) {
  // The message names no URL: DATABASE_URL never reaches a log.
  console.error(`JOURNEY FAIL: Postgres at DATABASE_URL does not answer (${e.code ?? e.name}). Run \`pnpm db:up\`.`);
  await sql.end({ timeout: 1 });
  process.exit(1);
}

const h = createHarness();
const forkUrl = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const rpc = rpcAt(8545);

/** Rows that belong to app user `externalId`, from `table` (norkey_credentials, _wallets or _wraps). */
const rowsOf = (table, externalId) =>
  sql`SELECT t.* FROM ${sql(table)} t JOIN norkey_users u ON u.id = t.user_id WHERE u.external_id = ${externalId}`;

try {
  // The tables are created on first use, so a fresh database has none to empty.
  const tables = await sql`SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename LIKE 'norkey\_%'`;
  if (tables.length) await sql`TRUNCATE ${sql(tables.map((t) => t.tablename))} CASCADE`;

  h.start("anvil", ["--fork-url", forkUrl, "--port", "8545", "--silent"]);
  h.start("node", ["examples/demo/custom-server.mjs"], { DATABASE_URL: process.env.DATABASE_URL });
  await h.vault("11155111");
  h.start("pnpm", ["--filter", "demo", "dev"], {
    VITE_SEPOLIA_RPC: "http://127.0.0.1:8545",
    VITE_CUSTOM_AUTH: "1",
  });
  await Promise.all([
    waitFor("http://127.0.0.1:8545", { method: "POST", body: "{}" }),
    waitFor("http://localhost:8787/norkey/status"),
    waitFor("http://localhost:5174/"),
    waitFor("http://localhost:5173/"),
  ]);
  const { page, cdp, authenticatorId: firstAuthenticator, wallet, logText } = await h.openApp();

  // The iframes standing in for popups stay in the page and shift the layout under a pointer click,
  // so the app's sign-in buttons are clicked from script.
  const appSignIn = async (name) => {
    await page.fill("#app-user", name);
    await page.evaluate(() => document.getElementById("app-sign-in").click());
    await page.waitForFunction((n) => document.getElementById("app-current")?.textContent === n, name);
  };
  // Sign-out revokes NorKey before it clears the cookie: wait for it to finish.
  const appSignOut = async () => {
    await page.evaluate(() => document.getElementById("app-sign-out").click());
    await page.waitForFunction(() => document.getElementById("app-current")?.textContent === "signed out");
  };
  const waitForAddress = () =>
    page.waitForFunction(() => document.getElementById("address")?.textContent?.startsWith("0x"), null, {
      timeout: 30000,
    });

  // 1. Signed out of the app: connect rejects with 4100, and the page never offers a NorKey sign-in.
  await page.click("#connect");
  await wallet().getByText("Sign in to the app first.").waitFor();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("error 4100"), null, {
    timeout: 15000,
  });
  console.log("1. signed out of the app: connect rejected with 4100");

  // 2. alice creates a wallet. Postgres holds one user mapped to alice, one wallet, one wrap.
  await appSignIn("alice");
  await page.click("#connect");
  await wallet().getByText("Create your wallet").waitFor();
  await wallet().getByRole("button", { name: "Create wallet" }).click();
  await wallet().getByRole("button", { name: "Skip" }).click();
  await waitForAddress();
  const address = await page.locator("#address").textContent();
  const users = await sql`SELECT id, external_id FROM norkey_users`;
  assert.equal(users.length, 1);
  assert.equal(users[0].external_id, "alice");
  const wallets = await rowsOf("norkey_wallets", "alice");
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].address.toLowerCase(), address.toLowerCase());
  assert.equal((await rowsOf("norkey_wraps", "alice")).length, 1);
  console.log(`2. alice created ${address}. Postgres: 1 user (external_id alice), 1 wallet, 1 wrap`);

  // 3. Fund it on the fork and send 0.001 ETH, approved with the passkey.
  await rpc("anvil_setBalance", [address, "0xde0b6b3a7640000"]);
  const to = "0x000000000000000000000000000000000000bEEF";
  const bal = async (x) => BigInt((await rpc("eth_getBalance", [x, "latest"])).result);
  const before = await bal(to);
  await page.fill("#to", to);
  await page.fill("#amount", "0.001");
  await page.click("#send");
  await wallet().getByText("upgrades your wallet").waitFor();
  await wallet().getByText("Approve with passkey").click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("confirmed"), null, {
    timeout: 60000,
  });
  assert.match(await logText(), /\(success\)/);
  assert.equal((await bal(to)) - before, 1000000000000000n);
  assert.equal((await latestTx(rpc)).type, "0x4");
  console.log("3. sent 0.001 ETH, receipt success, recipient balance +0.001");

  // 4. Add a second passkey on the settings page, on a second virtual authenticator (a USB key with
  // PRF), as journey.mjs step 9 does. Test-only: two authenticators would both answer a prompt.
  // Before each prompt on the boundary page, the hook leaves user presence on only for the
  // authenticator that holds an allowed credential, or for `active` when the prompt allows any.
  const { authenticatorId: secondAuthenticator } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
    },
  });
  const authenticators = [firstAuthenticator, secondAuthenticator];
  const credentialsOf = async (authenticatorId) =>
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.map((c) =>
      c.credentialId.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    );
  let active = firstAuthenticator;
  await page.exposeBinding("__e2ePasskey", async (_source, allowed) => {
    let use = active;
    for (const id of authenticators) if ((await credentialsOf(id)).some((c) => allowed.includes(c))) use = id;
    for (const id of authenticators) {
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: id, enabled: id === use });
    }
  });
  await page.addInitScript(() => {
    if (location.port !== "5174") return;
    const b64url = (buffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const container = navigator.credentials;
    for (const kind of ["create", "get"]) {
      const original = container[kind].bind(container);
      container[kind] = async (options) => {
        await window.__e2ePasskey((options.publicKey.allowCredentials ?? []).map((d) => b64url(d.id)));
        return original(options);
      };
    }
  });
  // The settings page, in this tab: the virtual authenticators belong to it. alice is still the app user.
  await page.goto("http://localhost:5174/");
  await page.getByRole("button", { name: "Sign in with your passkey" }).click();
  await page.getByRole("heading", { name: "Your wallet" }).waitFor();
  assert.equal((await page.locator(".row .value").textContent()).toLowerCase(), address.toLowerCase());
  active = secondAuthenticator;
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByText("Added. Test it").waitFor({ timeout: 30000 });
  const [secondCredential] = await credentialsOf(secondAuthenticator);
  const credentials = await rowsOf("norkey_credentials", "alice");
  const wrapRows = await rowsOf("norkey_wraps", "alice");
  assert.equal(credentials.length, 2);
  assert.equal(wrapRows.length, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM norkey_credentials`)[0].n, 2, "no other user's rows");
  assert.ok(credentials.some((c) => c.credential_id === secondCredential));
  console.log("4. settings page: added a passkey on a USB authenticator; Postgres: 2 credentials and 2 wraps for alice");

  // 5. alice signs out of the app (the demo revokes NorKey), bob signs in. Connect must open the
  // popup and offer bob a new wallet, not return alice's remembered address.
  await page.goto("http://localhost:5173/");
  await page.waitForFunction(() => document.getElementById("app-current")?.textContent === "alice");
  await appSignOut();
  // Signed out again: connect rejects with 4100. The page reloaded above, so its log starts empty and
  // this is the first one; counting keeps a stale 4100 from passing the check.
  await page.click("#connect");
  await wallet().getByText("Sign in to the app first.").waitFor();
  await page.waitForFunction(
    () => (document.getElementById("log")?.textContent?.match(/error 4100/g) ?? []).length === 1,
    null,
    { timeout: 15000 },
  );
  // The window.open stub's iframe outlives window.close(), so remove it by hand.
  await page.evaluate(() => document.querySelectorAll("iframe").forEach((f) => f.remove()));
  console.log("5a. signed out of the app: connect rejected with 4100");
  await appSignIn("bob");
  assert.equal(await page.locator("iframe").count(), 0);
  await page.click("#connect");
  await wallet().getByText("Create your wallet").waitFor();
  assert.equal(await page.locator("iframe").count(), 1, "connect opened the popup");
  assert.equal(await page.locator("#address").textContent(), "not connected");
  await wallet().getByRole("button", { name: "Cancel" }).click();
  await page.waitForFunction(() => document.getElementById("log")?.textContent?.includes("error 4001"));
  console.log("5. app user bob: connect opened the popup with \"Create your wallet\"; cancelled (4001)");

  // 6. bob's app cookie with alice's NorKey cookie. Step 5's sign-out deleted alice's NorKey session,
  // so alice signs in on the settings page first. The app user is then switched by setting the
  // cookie directly, which revokes nothing.
  await page.goto("http://localhost:5174/");
  await page.evaluate(() => {
    document.cookie = "demo_user=alice; Path=/; SameSite=Lax";
  });
  await page.getByRole("button", { name: "Sign in with your passkey" }).click();
  await page.getByRole("heading", { name: "Your wallet" }).waitFor();
  const getWallet = () =>
    page.evaluate(async () => {
      const r = await fetch("http://localhost:8787/norkey/wallet", { credentials: "include" });
      return { status: r.status, body: await r.text() };
    });
  const asAlice = await getWallet();
  assert.equal(asAlice.status, 200, "alice's NorKey session is live");
  assert.ok(asAlice.body.toLowerCase().includes(address.slice(2).toLowerCase()));
  await page.evaluate(() => {
    document.cookie = "demo_user=bob; Path=/; SameSite=Lax";
  });
  const asBob = await getWallet();
  assert.equal(asBob.status, 401);
  assert.ok(!asBob.body.toLowerCase().includes(address.slice(2).toLowerCase()), "no trace of alice's wallet");
  console.log(`6. app user bob with alice's NorKey cookie: GET /wallet answers 401 ${asBob.body} (alice alone: 200)`);

  // 7. Sign out, sign in as alice, and unlock: the same wallet as step 2.
  await page.goto("http://localhost:5173/");
  await page.waitForFunction(() => document.getElementById("app-current")?.textContent === "bob");
  await appSignOut();
  await appSignIn("alice");
  await page.click("#connect");
  await wallet().getByText("Unlock your wallet").waitFor();
  await wallet().getByRole("button", { name: "Use my passkey" }).click();
  await waitForAddress();
  assert.equal(await page.locator("#address").textContent(), address);
  console.log("7. alice signed back in and unlocked the same address", address);
  console.log("JOURNEY PASS");
} catch (e) {
  await h.report(e);
} finally {
  await h.close();
  await sql.end({ timeout: 5 });
}
