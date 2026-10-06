import { createHash, randomBytes } from "node:crypto";
import type { ResolvedConfig } from "../config.js";

const COOKIE = "norkey_session";
const hash = (token: Uint8Array) => createHash("sha256").update(token).digest("hex");

/** Creates a session and returns the Set-Cookie value. Only the token's hash is stored. */
export async function issueSession(config: ResolvedConfig, userId: string): Promise<string> {
  const token = randomBytes(32);
  const tokenB64 = token.toString("base64url");
  await config.storage.createSession({
    tokenHash: hash(token),
    userId,
    expiresAt: Date.now() + config.sessionTtlSeconds * 1000,
  });
  let cookie = `${COOKIE}=${tokenB64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}`;
  if (config.rpId !== "localhost") cookie += "; Secure";
  if (config.cookieDomain) cookie += `; Domain=${config.cookieDomain}`;
  return cookie;
}

export async function readSession(config: ResolvedConfig, req: Request): Promise<string | null> {
  const header = req.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const token = Buffer.from(match.slice(COOKIE.length + 1), "base64url");
  return config.storage.getSessionUser(hash(token));
}
