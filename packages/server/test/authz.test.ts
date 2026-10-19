// Why: the server's only security job in slice 1 is to never hand one user's wrap or wallet slot to
// another user, and to refuse writes without a session. A wrap is ciphertext, but serving it to the
// wrong user still breaks the "only your passkey opens your wallet" boundary and enables row swaps.
import { createHash } from "node:crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginVerify } from "../src/auth/passkey.js";
import { createNorKeyHandler } from "../src/index.js";
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
async function setup() {
  const test = await makeStorage();
  opened.push(test);
  const storage = test.storage;
  const handler = createNorKeyHandler({
    rpId: "localhost",
    origins: [origin],
    appOrigins: [app],
    storage,
    sessionTtlSeconds: TTL_SECONDS,
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
  return { storage, call, login, session };
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
