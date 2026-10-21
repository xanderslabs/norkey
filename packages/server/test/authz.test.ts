// Why: the server must never hand one user's wrap or wallet slot to another user, and must refuse
// writes without a session. A wrap is ciphertext, but serving it to the
// wrong user still breaks the "only your passkey opens your wallet" boundary and enables row swaps.
import { createHash, randomBytes } from "node:crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginVerify } from "../src/auth/passkey.js";
import { createNorKeyHandler, type NorKeyHandlerConfig } from "../src/index.js";
import { makeStorage, type TestStorage } from "./adapters.js";

// Only the test below drives POST /login/verify; WebAuthn itself cannot run here, so its result is
// supplied. The handler's own wallet and wrap lookups run for real.
vi.mock("../src/auth/passkey.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/passkey.js")>()),
  loginVerify: vi.fn(),
}));
// The same for a new passkey's registration, which only the add-a-passkey test drives.
vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: vi.fn(),
}));

const origin = "http://localhost:5174";
const app = "http://localhost:5173";
const TTL_SECONDS = 3600;
const opened: TestStorage[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});
async function setup(extra: Partial<NorKeyHandlerConfig> = {}) {
  const test = await makeStorage();
  opened.push(test);
  const storage = test.storage;
  const handler = createNorKeyHandler({
    rpId: "localhost",
    origins: [origin],
    appOrigins: [app],
    storage,
    sessionTtlSeconds: TTL_SECONDS,
    ...extra,
  });
  /** A session cookie for `userId`, issued `ageMs` ago. Storage keeps only the expiry. */
  async function session(userId: string, ageMs = 0) {
    const token = `tok-${userId}-${ageMs}`;
    await storage.createSession({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      expiresAt: Date.now() - ageMs + TTL_SECONDS * 1000,
    });
    return `norkey_session=${Buffer.from(token).toString("base64url")}`;
  }
  async function login(userId: string, credentialId: string) {
    await storage.createUser(userId);
    await storage.addCredential({ credentialId, userId, publicKey: new Uint8Array([1]), signCount: 0, transports: [] });
    return session(userId);
  }
  const call = (path: string, init: RequestInit & { cookie?: string; origin?: string } = {}) =>
    handler(
      new Request(`http://localhost:8787/norkey${path}`, {
        ...init,
        headers: {
          origin: init.origin ?? origin,
          "content-type": "application/json",
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
      }),
    );
  return { storage, call, login, session, rows: test.rows };
}
const wrapFor = (credentialId: string) => ({
  id: crypto.randomUUID(),
  kind: "passkey",
  credentialId,
  salt: "s",
  iv: "i",
  ciphertext: "c",
});
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("server authorization", () => {
  it("refuses wallet writes without a session", async () => {
    const { call } = await setup();
    const res = await call("/wallet", {
      method: "POST",
      body: JSON.stringify({ address: addr(1), wrap: wrapFor("c1") }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a wrap whose credential belongs to another user", async () => {
    const { call, login } = await setup();
    await login("alice", "cred-alice");
    const bob = await login("bob", "cred-bob");
    const res = await call("/wallet", {
      method: "POST",
      cookie: bob,
      body: JSON.stringify({ address: addr(2), wrap: wrapFor("cred-alice") }),
    });
    expect(res.status).toBe(403);
  });

  it("never returns another user's wallet", async () => {
    const { call, login } = await setup();
    const alice = await login("alice", "cred-alice");
    const bob = await login("bob", "cred-bob");
    await call("/wallet", {
      method: "POST",
      cookie: alice,
      body: JSON.stringify({ address: addr(3), wrap: wrapFor("cred-alice") }),
    });
    const res = await call("/wallet", { method: "GET", cookie: bob });
    expect(res.status).toBe(404);
  });

  it("does not return the first user's wrap when a second user logs in with that credential id", async () => {
    const { call, login } = await setup();
    const alice = await login("alice", "cred-alice");
    const bob = await login("bob", "cred-bob");
    for (const [cookie, cred, n] of [
      [alice, "cred-alice", 4],
      [bob, "cred-bob", 7],
    ] as const) {
      await call("/wallet", {
        method: "POST",
        cookie,
        body: JSON.stringify({ address: addr(n), wrap: wrapFor(cred) }),
      });
    }
    vi.mocked(loginVerify).mockResolvedValueOnce({ userId: "bob", credentialId: "cred-alice" });
    const res = await call("/login/verify", {
      method: "POST",
      body: JSON.stringify({ challengeId: "x", response: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wallet: { address: string } | null; wrap: unknown };
    expect(body.wallet?.address).toBe(addr(7));
    expect(body.wrap).toBeNull();
  });

  it("allows one wallet per user", async () => {
    const { call, login } = await setup();
    const alice = await login("alice", "cred-alice");
    const body = () => JSON.stringify({ address: addr(5), wrap: wrapFor("cred-alice") });
    expect((await call("/wallet", { method: "POST", cookie: alice, body: body() })).status).toBe(201);
    expect((await call("/wallet", { method: "POST", cookie: alice, body: body() })).status).toBe(409);
  });

  it("rejects writes from an origin that is not configured", async () => {
    const { login, storage } = await setup();
    const alice = await login("alice", "cred-alice");
    const handler = createNorKeyHandler({ rpId: "localhost", origins: [origin], storage });
    const res = await handler(
      new Request("http://localhost:8787/norkey/wallet", {
        method: "POST",
        headers: { origin: "https://evil.example", cookie: alice, "content-type": "application/json" },
        body: JSON.stringify({ address: addr(6), wrap: wrapFor("cred-alice") }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("adding a passkey", () => {
  it("adds a passkey only for the signed-in user", async () => {
    // Why: a new passkey is one more way into the account. If a challenge issued to one user worked
    // with another user's session, an attacker could attach their passkey to someone else's account.
    // If an old cookie were enough, a stolen one could do the same for 7 days. And a wrap that names
    // any credential but the new one is a backup that opens nothing, which the user would trust.
    const { call, login, session, storage } = await setup();
    const alice = await login("alice", "cred-alice");
    const bob = await login("bob", "cred-bob");
    for (const [cookie, cred, n] of [
      [alice, "cred-alice", 1],
      [bob, "cred-bob", 2],
    ] as const) {
      await call("/wallet", {
        method: "POST",
        cookie,
        body: JSON.stringify({ address: addr(n), wrap: wrapFor(cred) }),
      });
    }
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-alice-2", publicKey: new Uint8Array([2]), counter: 0, transports: ["usb"] },
      },
    } as never);
    const options = async (cookie: string, from = origin) => {
      const res = await call("/passkeys/options", { method: "POST", cookie, origin: from, body: "{}" });
      const body = (await res.json()) as { challengeId: string; options?: { excludeCredentials?: { id: string }[] } };
      return { status: res.status, challengeId: body.challengeId, exclude: body.options?.excludeCredentials };
    };
    const add = (cookie: string, challengeId: string, wrap = wrapFor("cred-alice-2"), from = origin) =>
      call("/passkeys", {
        method: "POST",
        cookie,
        origin: from,
        body: JSON.stringify({ challengeId, response: { id: "cred-alice-2" }, wrap }),
      });

    // A challenge issued to alice, used with bob's session.
    const first = await options(alice);
    expect(first.status).toBe(200);
    expect(first.exclude?.map((c) => c.id)).toEqual(["cred-alice"]);
    expect((await add(bob, first.challengeId)).status).toBe(403);

    // A live session issued more than 5 minutes ago.
    const stale = await session("alice", 6 * 60_000);
    expect((await options(stale)).status).toBe(401);
    expect((await add(stale, (await options(alice)).challengeId)).status).toBe(401);

    // A wrap for a credential other than the new one.
    expect((await add(alice, (await options(alice)).challengeId, wrapFor("cred-alice"))).status).toBe(400);

    // An app origin, on both routes.
    expect((await options(alice, app)).status).toBe(403);
    expect((await add(alice, (await options(alice)).challengeId, undefined, app)).status).toBe(403);
    expect(await storage.getCredential("cred-alice-2")).toBeNull();

    // The signed-in user's own challenge, a fresh session and a wrap for the new passkey: added.
    expect((await add(alice, (await options(alice)).challengeId)).status).toBe(201);
    expect((await storage.getCredential("cred-alice-2"))?.userId).toBe("alice");
    expect((await storage.getWrap("alice", "cred-alice-2"))?.credentialId).toBe("cred-alice-2");
  });
});

describe("custom auth mode", () => {
  // Why: in custom mode the app's session says who the user is. If NorKey answered without it, or with
  // a NorKey session of another app user, one app account would reach another's wallet. A passkey is
  // still checked for every key operation, so a stolen app session alone opens nothing that exists.
  const SIGNED_OUT = { error: "sign in to the app first" };
  /** The app's own session, a cookie the app sets on its registrable domain. */
  const appUser = (req: Request) =>
    req.headers
      .get("cookie")
      ?.split(/;\s*/)
      .find((p) => p.startsWith("app_user="))
      ?.slice("app_user=".length) ?? null;
  async function customSetup(extra: Partial<NorKeyHandlerConfig> = {}) {
    const t = await setup({ auth: { mode: "custom", getUserId: appUser }, ...extra });
    const credential = (userId: string, credentialId: string) => ({
      credentialId,
      userId,
      publicKey: new Uint8Array([1]),
      signCount: 0,
      transports: [],
    });
    /** A NorKey user mapped to the app user `externalId`, and cookies for both sessions. */
    async function appLogin(externalId: string, userId: string, credentialId: string) {
      await t.storage.createUserWithCredential(credential(userId, credentialId), externalId);
      return `${await t.session(userId)}; app_user=${externalId}`;
    }
    return { ...t, credential, appLogin };
  }
  const json = async (res: Response) => ({ status: res.status, body: await res.json() });

  it("refuses every gated route without an app user", async () => {
    const { call, credential, session, storage } = await customSetup();
    await storage.createUserWithCredential(credential("a", "cred-a"), "A");
    const cookie = await session("a");
    for (const [method, path] of [
      ["GET", "/wallet"],
      ["POST", "/wallet"],
      ["POST", "/passkeys/options"],
      ["POST", "/passkeys"],
      ["POST", "/login/options"],
      ["POST", "/register/options"],
    ]) {
      const res = await call(path, { method, cookie, body: method === "POST" ? "{}" : undefined });
      expect(await json(res), `${method} ${path}`).toEqual({ status: 401, body: SIGNED_OUT });
    }
  });

  it("treats a blank app user as signed out", async () => {
    for (const value of ["", "  ", 42, undefined]) {
      const { call, credential, session, storage } = await customSetup({
        auth: { mode: "custom", getUserId: () => value as never },
      });
      await storage.createUserWithCredential(credential("a", "cred-a"), "A");
      const res = await call("/wallet", { method: "GET", cookie: await session("a") });
      expect(await json(res), String(value)).toEqual({ status: 401, body: SIGNED_OUT });
    }
  });

  it("refuses a NorKey session that disagrees with the app user", async () => {
    const { call, appLogin, storage } = await customSetup();
    await appLogin("A", "a", "cred-a");
    const asB = await appLogin("B", "b", "cred-b");
    await storage.createWallet("a", addr(1), { ...wrapFor("cred-a"), kind: "passkey" });
    await storage.createWallet("b", addr(2), { ...wrapFor("cred-b"), kind: "passkey" });
    const cookie = asB.replace("app_user=B", "app_user=A");
    const wallet = await call("/wallet", { method: "GET", cookie });
    const text = await wallet.text();
    expect({ status: wallet.status, body: JSON.parse(text) }).toEqual({
      status: 401,
      body: { error: "not signed in" },
    });
    const add = await call("/passkeys/options", { method: "POST", cookie, body: "{}" });
    const addText = await add.text();
    expect(add.status).toBe(401);
    for (const body of [text, addText]) {
      expect(body).not.toContain(addr(1));
      expect(body).not.toContain(addr(2));
    }
  });

  it("reports status for the signed-in app user", async () => {
    const { call, appLogin, storage } = await customSetup();
    const status = async (cookie?: string) => json(await call("/status", { method: "GET", cookie }));
    expect(await status()).toEqual({ status: 200, body: { mode: "custom", signedIn: false } });
    expect(await status("app_user=A")).toEqual({
      status: 200,
      body: { mode: "custom", signedIn: true, hasUser: false, hasWallet: false },
    });
    await appLogin("A", "a", "cred-a");
    expect(await status("app_user=A")).toEqual({
      status: 200,
      body: { mode: "custom", signedIn: true, hasUser: true, hasWallet: false },
    });
    await storage.createWallet("a", addr(1), { ...wrapFor("cred-a"), kind: "passkey" });
    expect(await status("app_user=A")).toEqual({
      status: 200,
      body: { mode: "custom", signedIn: true, hasUser: true, hasWallet: true },
    });
    const builtIn = await setup();
    expect(await json(await builtIn.call("/status", { method: "GET" }))).toEqual({
      status: 200,
      body: { mode: "passkey" },
    });
  });

  it("refuses to register an app user who has a wallet", async () => {
    const { call, appLogin, storage } = await customSetup();
    await appLogin("A", "a", "cred-a");
    await storage.createWallet("a", addr(1), { ...wrapFor("cred-a"), kind: "passkey" });
    const res = await call("/register/options", { method: "POST", cookie: "app_user=A", body: "{}" });
    expect(await json(res)).toEqual({ status: 409, body: { error: "this account already has a wallet" } });
  });

  it("registers again on the same user when there is no wallet", async () => {
    // Why: a create that stored the user and then failed (no PRF, or a cross-device passkey) would
    // otherwise lock this app user out of NorKey for good.
    const { call, credential, rows, storage } = await customSetup();
    const userId = randomBytes(16).toString("base64url");
    await storage.createUserWithCredential(credential(userId, "cred-a"), "A");
    const options = await call("/register/options", { method: "POST", cookie: "app_user=A", body: "{}" });
    const { challengeId, options: created } = (await options.json()) as {
      challengeId: string;
      options: { user: { id: string } };
    };
    expect(options.status).toBe(200);
    expect(created.user.id).toBe(userId);
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-a-2", publicKey: new Uint8Array([2]), counter: 0, transports: ["internal"] },
      },
    } as never);
    const verify = await call("/register/verify", {
      method: "POST",
      cookie: "app_user=A",
      body: JSON.stringify({ challengeId, response: { id: "cred-a-2" } }),
    });
    expect(await json(verify)).toEqual({ status: 200, body: { userId } });
    expect(await storage.listCredentialIds(userId)).toEqual(["cred-a", "cred-a-2"]);
    expect(await storage.getUserIdByExternalId("A")).toBe(userId);
    expect(await rows("users")).toBe(1);
  });

  it("offers only the app user's passkeys", async () => {
    const { call, appLogin, credential, storage } = await customSetup();
    await appLogin("A", "a", "cred-a");
    await storage.addCredential(credential("a", "cred-a-2"));
    await appLogin("B", "b", "cred-b");
    const allowed = async (body: unknown) => {
      const res = await call("/login/options", { method: "POST", cookie: "app_user=A", body: JSON.stringify(body) });
      const { options } = (await res.json()) as { options: { allowCredentials?: { id: string }[] } };
      return { status: res.status, ids: options.allowCredentials?.map((c) => c.id) };
    };
    expect(await allowed({})).toEqual({ status: 200, ids: ["cred-a", "cred-a-2"] });
    expect(await allowed({ credentialId: "cred-b" })).toEqual({ status: 200, ids: ["cred-a", "cred-a-2"] });
    expect(await allowed({ credentialId: "cred-a-2" })).toEqual({ status: 200, ids: ["cred-a-2"] });
  });

  it("refuses another user's passkey at login", async () => {
    const { call, appLogin } = await customSetup();
    await appLogin("A", "a", "cred-a");
    await appLogin("B", "b", "cred-b");
    vi.mocked(loginVerify).mockResolvedValueOnce({ userId: "b", credentialId: "cred-b" });
    const res = await call("/login/verify", {
      method: "POST",
      cookie: "app_user=A",
      body: JSON.stringify({ challengeId: "x", response: {} }),
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await json(res)).toEqual({ status: 403, body: { error: "this passkey belongs to another account" } });
  });

  it("adds a passkey only with a fresh, agreeing session", async () => {
    const { call, appLogin, session, storage } = await customSetup();
    const asA = await appLogin("A", "a", "cred-a");
    const asB = await appLogin("B", "b", "cred-b");
    await storage.createWallet("a", addr(1), { ...wrapFor("cred-a"), kind: "passkey" });
    await storage.createWallet("b", addr(2), { ...wrapFor("cred-b"), kind: "passkey" });
    const options = (cookie: string) => call("/passkeys/options", { method: "POST", cookie, body: "{}" });
    const fresh = await options(asA);
    expect(fresh.status).toBe(200);
    expect((await fresh.json()) as { challengeId: string }).toHaveProperty("challengeId");
    const again = { status: 401, body: { error: "sign in again to add a passkey" } };
    expect(await json(await options(`${await session("a", 6 * 60_000)}; app_user=A`))).toEqual(again);
    expect(await json(await options(asB.replace("app_user=B", "app_user=A")))).toEqual(again);
  });

  it("passes the app's id to the sponsorship check", async () => {
    // allow says no, so the proxy answers 403 without calling the vendor.
    const allow = vi.fn(() => false);
    const { call, appLogin, storage } = await customSetup({
      paymasterProxy: { 11155111: { url: "https://paymaster.example/rpc", allow } },
    });
    const asA = await appLogin("A", "a", "cred-a");
    await storage.createWallet("a", addr(1), { ...wrapFor("cred-a"), kind: "passkey" });
    const rpc = (cookie: string) =>
      call("/paymaster/11155111", {
        method: "POST",
        origin: app,
        cookie,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "pm_getPaymasterStubData",
          params: [{ sender: addr(1) }, "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", "0xaa36a7", {}],
        }),
      });
    expect(await json(await rpc(asA))).toEqual({ status: 403, body: { error: "sponsorship not allowed" } });
    expect(allow).toHaveBeenCalledTimes(1);
    expect(allow).toHaveBeenCalledWith(expect.objectContaining({ userId: "a", externalId: "A", address: addr(1) }));
    allow.mockClear();
    expect(await json(await rpc(asA.replace("; app_user=A", "")))).toEqual({ status: 401, body: SIGNED_OUT });
    expect(allow).not.toHaveBeenCalled();
  });
});
