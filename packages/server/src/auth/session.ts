import { createHash, randomBytes } from "node:crypto";
import type { ResolvedConfig } from "../config.js";

const COOKIE = "norkey_session";
/** Slice 4, decision 5: adding a passkey needs a session issued in the last 5 minutes. */
const FRESH_MS = 5 * 60 * 1000;
const hash = (token: Uint8Array) => createHash("sha256").update(token).digest("hex");

/** One place builds the cookie, so logout's expiring copy has the same Path, Domain and Secure as the
 *  issued one. The browser replaces a cookie only when its name, Domain and Path match. */
function sessionCookie(config: ResolvedConfig, value: string, maxAge: number): string {
  let cookie = `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  if (config.rpId !== "localhost") cookie += "; Secure";
  if (config.cookieDomain) cookie += `; Domain=${config.cookieDomain}`;
  return cookie;
}

/** Creates a session and returns the Set-Cookie value. Only the token's hash is stored. */
export async function issueSession(config: ResolvedConfig, userId: string): Promise<string> {
  const token = randomBytes(32);
  await config.storage.createSession({
    tokenHash: hash(token),
    userId,
    expiresAt: Date.now() + config.sessionTtlSeconds * 1000,
  });
  return sessionCookie(config, token.toString("base64url"), config.sessionTtlSeconds);
}

function readToken(req: Request): Buffer | null {
  const header = req.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  return match ? Buffer.from(match.slice(COOKIE.length + 1), "base64url") : null;
}

export async function readSession(config: ResolvedConfig, req: Request): Promise<string | null> {
  const token = readToken(req);
  return token ? config.storage.getSessionUser(hash(token)) : null;
}

/** The session's user if the session was issued in the last 5 minutes, else null. Storage keeps only
 *  the expiry, so the issue time is the expiry minus the configured lifetime. A lifetime lowered after
 *  issue makes an old session look newer; an issue time in the future is refused. */
export async function readFreshSession(config: ResolvedConfig, req: Request): Promise<string | null> {
  const token = readToken(req);
  const session = token ? await config.storage.getSession(hash(token)) : null;
  if (!session) return null;
  const age = Date.now() - (session.expiresAt - config.sessionTtlSeconds * 1000);
  return age >= 0 && age <= FRESH_MS ? session.userId : null;
}

/** Deletes the request's session, if it has one, and returns a Set-Cookie value that expires the cookie. */
export async function endSession(config: ResolvedConfig, req: Request): Promise<string> {
  const token = readToken(req);
  if (token) await config.storage.deleteSession(hash(token));
  return sessionCookie(config, "", 0);
}
