// Why: the server's only security job in slice 1 is to never hand one user's wrap or wallet slot to
// another user, and to refuse writes without a session. A wrap is ciphertext, but serving it to the
// wrong user still breaks the "only your passkey opens your wallet" boundary and enables row swaps.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNorKeyHandler, sqlite } from "../src/index.js";

const origin = "http://localhost:5174";
async function setup() {
  const storage = sqlite(":memory:");
  const handler = createNorKeyHandler({ rpId: "localhost", origins: [origin], storage });
  async function login(userId: string, credentialId: string) {
    await storage.createUser(userId);
    await storage.addCredential({ credentialId, userId, publicKey: new Uint8Array([1]), signCount: 0, transports: [] });
    const token = `tok-${userId}`;
    await storage.createSession({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      expiresAt: Date.now() + 60_000,
    });
    return `norkey_session=${Buffer.from(token).toString("base64url")}`;
  }
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    handler(
      new Request(`http://localhost:8787/norkey${path}`, {
        ...init,
        headers: { origin, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
      }),
    );
  return { storage, call, login };
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

  it("does not give a second user the first user's wrap through storage lookups", async () => {
    const { storage, call, login } = await setup();
    const alice = await login("alice", "cred-alice");
    await login("bob", "cred-bob");
    await call("/wallet", {
      method: "POST",
      cookie: alice,
      body: JSON.stringify({ address: addr(4), wrap: wrapFor("cred-alice") }),
    });
    expect(await storage.getWrap("bob", "cred-alice")).toBeNull();
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
