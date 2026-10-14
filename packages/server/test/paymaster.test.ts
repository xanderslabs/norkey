// Why: the proxy spends the developer's money and holds their paymaster API key. If it relays
// without a session, anyone drains the sponsorship. If it relays another sender's operation, one
// user spends sponsorship on any account. If the client's context reaches the vendor, a client picks
// a more generous policy. If the URL or upstream error data leaks, so does the key. And the app
// origin must never reach the passkey routes: they release the wrap.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNorKeyHandler, sqlite } from "../src/index.js";

const vault = "http://localhost:5174";
const app = "http://localhost:5173";
const SECRET_URL = "https://paymaster.example/v2/11155111/rpc?apikey=SECRET";
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const WALLET = "0x00000000000000000000000000000000000a11ce";

type Allow = (a: { userId: string; address: string; chainId: number; method: string; userOp: unknown }) => boolean;

async function setup(allow: Allow = () => true, upstreamReply?: (req: { id: unknown; params: unknown[] }) => unknown) {
  const storage = sqlite(":memory:");
  const allowSpy = vi.fn(allow);
  const upstream = vi.fn(async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: unknown; params: unknown[] };
    return Response.json(upstreamReply ? upstreamReply(req) : { jsonrpc: "2.0", id: req.id, result: { ok: true } });
  });
  vi.stubGlobal("fetch", upstream);
  const handler = createNorKeyHandler({
    rpId: "localhost",
    origins: [vault],
    appOrigins: [app],
    storage,
    paymasterProxy: { 11155111: { url: SECRET_URL, context: { sponsorshipPolicyId: "sp_server" }, allow: allowSpy } },
  });
  await storage.createUser("alice");
  await storage.addCredential({
    credentialId: "cred-alice",
    userId: "alice",
    publicKey: new Uint8Array([1]),
    signCount: 0,
    transports: [],
  });
  await storage.createWallet("alice", WALLET, {
    id: "w1",
    kind: "passkey",
    credentialId: "cred-alice",
    salt: "s",
    iv: "i",
    ciphertext: "c",
  });
  const token = "tok-alice";
  await storage.createSession({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: "alice",
    expiresAt: Date.now() + 60_000,
  });
  const cookie = `norkey_session=${Buffer.from(token).toString("base64url")}`;
  const post = (path: string, body: unknown, opts: { cookie?: string | null; origin?: string } = {}) =>
    handler(
      new Request(`http://localhost:8787/norkey${path}`, {
        method: "POST",
        headers: {
          origin: opts.origin ?? app,
          "content-type": "application/json",
          ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? cookie }),
        },
        body: JSON.stringify(body),
      }),
    );
  const rpc = (body: unknown, opts: { cookie?: string | null } = {}) => post("/paymaster/11155111", body, opts);
  return { rpc, post, upstream, allowSpy };
}

const stubCall = (overrides: { sender?: string; entryPoint?: string; chainId?: string; method?: string } = {}) => ({
  jsonrpc: "2.0",
  id: 7,
  method: overrides.method ?? "pm_getPaymasterStubData",
  params: [
    { sender: overrides.sender ?? WALLET, nonce: "0x0" },
    overrides.entryPoint ?? EP,
    overrides.chainId ?? "0xaa36a7",
    { sponsorshipPolicyId: "sp_client" },
  ],
});

afterEach(() => vi.unstubAllGlobals());

describe("paymaster proxy", () => {
  it("refuses a request with no session, before calling upstream", async () => {
    const { rpc, upstream } = await setup();
    const res = await rpc(stubCall(), { cookie: null });
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses another sender's operation without calling upstream", async () => {
    const { rpc, upstream, allowSpy } = await setup();
    const res = await rpc(stubCall({ sender: "0x000000000000000000000000000000000000b0b0" }));
    expect((await res.json()).error.code).toBe(-32602);
    expect(upstream).not.toHaveBeenCalled();
    expect(allowSpy).not.toHaveBeenCalled();
  });

  it("sends the server's context to the configured URL, never the client's", async () => {
    const { rpc, upstream } = await setup();
    const res = await rpc(stubCall());
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SECRET_URL);
    expect(JSON.parse(String(init.body)).params[3]).toEqual({ sponsorshipPolicyId: "sp_server" });
  });

  it("refuses methods off the allowlist and JSON-RPC batches", async () => {
    const { rpc, upstream } = await setup();
    const off = await rpc(stubCall({ method: "pimlico_sponsorUserOperation" }));
    expect((await off.json()).error.code).toBe(-32601);
    const batch = await rpc([stubCall()]);
    expect(batch.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 403 when allow says no, without calling upstream", async () => {
    const { rpc, upstream, allowSpy } = await setup(() => false);
    const res = await rpc(stubCall());
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(allowSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "alice",
        address: WALLET,
        chainId: 11155111,
        method: "pm_getPaymasterStubData",
      }),
    );
  });

  it("refuses a wrong EntryPoint or chainId", async () => {
    const { rpc, upstream } = await setup();
    const ep07 = await rpc(stubCall({ entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" }));
    expect((await ep07.json()).error.code).toBe(-32602);
    const mainnet = await rpc(stubCall({ chainId: "0x1" }));
    expect((await mainnet.json()).error.code).toBe(-32602);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never returns the upstream URL or error data", async () => {
    const { rpc } = await setup(undefined, (req) => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32003, message: "sponsorship rejected", data: { url: SECRET_URL } },
    }));
    const res = await rpc(stubCall());
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(JSON.parse(text)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32003, message: "sponsorship rejected" },
    });
  });

  it("keeps app origins away from the passkey routes", async () => {
    const { post } = await setup();
    for (const path of ["/login/options", "/login/verify", "/register/options", "/register/verify", "/wallet"]) {
      const res = await post(path, {}, { origin: app });
      expect(res.status, path).toBe(403);
    }
  });

  it("refuses a proxy config without allow, and does not print the URL", () => {
    const make = () =>
      createNorKeyHandler({
        rpId: "localhost",
        origins: [vault],
        appOrigins: [app],
        storage: sqlite(":memory:"),
        paymasterProxy: { 11155111: { url: SECRET_URL } as never },
      });
    expect(make).toThrow(/allow is required/);
    try {
      make();
    } catch (e) {
      expect(String(e)).not.toContain("SECRET");
    }
  });
});
