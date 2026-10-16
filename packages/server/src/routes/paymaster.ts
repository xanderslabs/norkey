import type { PaymasterProxyEntry } from "../config.js";

/** EntryPoint v0.8, the one Calibur trusts unless the account changes it, which the boundary page
 *  refuses (NorKey-internal/probes/paymaster-7677.md, section 1). */
const ENTRY_POINT_08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const HASH = /^0x[0-9a-fA-F]{64}$/;
/** These spend sponsorship, so `allow` decides them. */
const SPONSOR = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
const BUNDLER = new Set(["eth_estimateUserOperationGas", "eth_sendUserOperation"]);
const RECEIPT = "eth_getUserOperationReceipt";
const TIMEOUT_MS = 30_000;

type Result = { status: number; body: unknown };
const rpcError = (id: unknown, code: number, message: string): Result => ({
  status: 200,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});

/**
 * Relays one JSON-RPC request for the signed-in user to the vendor. The caller has checked the
 * origin, the chain, the session and the wallet. Every operation must be the user's own, on
 * EntryPoint v0.8, and the server's context replaces the client's.
 */
export async function proxyPaymaster(
  entry: PaymasterProxyEntry,
  a: { chainId: number; userId: string; address: string; body: unknown },
): Promise<Result> {
  if (typeof a.body !== "object" || a.body === null || Array.isArray(a.body)) {
    return { status: 400, body: { error: "send one JSON-RPC request" } };
  }
  const { id = null, method, params } = a.body as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string" || !(SPONSOR.has(method) || BUNDLER.has(method) || method === RECEIPT)) {
    return rpcError(id, -32601, "This method is not available through the NorKey proxy.");
  }
  if (!Array.isArray(params)) return rpcError(id, -32602, "params must be an array");

  let forward: unknown[];
  if (method === RECEIPT) {
    if (typeof params[0] !== "string" || !HASH.test(params[0]))
      return rpcError(id, -32602, "Expected a user operation hash.");
    forward = [params[0]];
  } else {
    const [op, entryPoint] = params;
    const sender = (op as { sender?: unknown } | null)?.sender;
    if (typeof sender !== "string" || sender.toLowerCase() !== a.address.toLowerCase()) {
      return rpcError(id, -32602, "The operation's sender is not this user's wallet.");
    }
    if (typeof entryPoint !== "string" || entryPoint.toLowerCase() !== ENTRY_POINT_08) {
      return rpcError(id, -32602, "Only EntryPoint v0.8 is supported.");
    }
    if (SPONSOR.has(method)) {
      if (typeof params[2] !== "string" || Number(params[2]) !== a.chainId) {
        return rpcError(id, -32602, "The chainId does not match this proxy route.");
      }
      const ok = await entry.allow({ userId: a.userId, address: a.address, chainId: a.chainId, method, userOp: op });
      if (!ok) return { status: 403, body: { error: "sponsorship not allowed" } };
      forward = [op, entryPoint, params[2], entry.context ?? {}];
    } else {
      // A client state override is dropped.
      forward = [op, entryPoint];
    }
  }
  return relay(entry.url, a.chainId, id, method, forward);
}

/** An upstream message can quote the URL, key included, or carry viem-style "URL:" and "Request body:"
 *  lines. Keep the first line, replace every URL of any scheme, then the configured URL's host name, host and path
 *  (no scheme), its raw query text (each part, its name and its value, so a raw "+" or a bare name is
 *  caught), its query values, its user name and password, and any path segment long enough to be a
 *  key, each also percent-encoded, decoded, and form-decoded ("+" as a space). Longest first, so a shorter secret cannot break a longer
 *  one. Short values may be over-redacted; that is harmless. Cap the length. */
function trimMessage(message: string, url: string): string {
  let m = (message.split(/\r?\n/, 1)[0] ?? "").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
  const u = new URL(url);
  const segments = u.pathname.split("/").filter((p) => p.length >= 8);
  const secrets = new Set<string>();
  const queryParts = u.search
    .slice(1)
    .split("&")
    .flatMap((part) => {
      const eq = part.indexOf("=");
      return eq < 0 ? [part] : [part, part.slice(0, eq), part.slice(eq + 1)];
    });
  for (const s of [
    url,
    u.hostname,
    u.host + u.pathname,
    ...queryParts,
    ...u.searchParams.values(),
    u.username,
    u.password,
    ...segments,
  ]) {
    if (!s) continue;
    secrets.add(s);
    secrets.add(encodeURIComponent(s));
    try {
      secrets.add(decodeURIComponent(s));
    } catch {}
    try {
      secrets.add(decodeURIComponent(s.replace(/\+/g, " ")));
    } catch {}
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) m = m.split(secret).join("[url]");
  }
  return m.slice(0, 300);
}

/** Never logs or returns `url`: it holds the API key. Upstream error data and headers are dropped. */
async function relay(url: string, chainId: number, id: unknown, method: string, params: unknown[]): Promise<Result> {
  const unavailable = () => rpcError(id, -32603, "paymaster service unavailable");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.error(`norkey: paymaster ${chainId}: no response`);
    return unavailable();
  }
  type Reply = { result?: unknown; error?: { code?: unknown; message?: unknown } };
  let data = null as Reply | null;
  try {
    data = (await res.json()) as Reply | null;
  } catch {}
  if (data && typeof data === "object" && data.error) {
    const code = typeof data.error.code === "number" ? data.error.code : -32603;
    return rpcError(
      id,
      code,
      typeof data.error.message === "string" ? trimMessage(data.error.message, url) : "paymaster error",
    );
  }
  if (!res.ok || !data || typeof data !== "object" || !("result" in data)) {
    console.error(`norkey: paymaster ${chainId}: upstream status ${res.status}`);
    return unavailable();
  }
  return { status: 200, body: { jsonrpc: "2.0", id, result: data.result } };
}
