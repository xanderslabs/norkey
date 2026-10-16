import { AuthError, verifyNewPasskey } from "../auth/passkey.js";
import type { ResolvedConfig } from "../config.js";
import { isWrap } from "./wallet.js";

/** POST /passkeys: one more passkey and its wrap of the same key. The caller has resolved a fresh
 *  session. The server cannot check what a wrap decrypts to, only that it names the new passkey. */
export async function addPasskey(
  config: ResolvedConfig,
  userId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const { challengeId, response, wrap } = (body ?? {}) as { challengeId?: unknown; response?: unknown; wrap?: unknown };
  if (typeof challengeId !== "string" || typeof response !== "object" || response === null || !isWrap(wrap)) {
    return { status: 400, body: { error: "challengeId, response and wrap are required" } };
  }
  if (!(await config.storage.getWallet(userId))) return { status: 409, body: { error: "no wallet" } };
  const stored = await config.storage.takeChallenge(challengeId);
  if (!stored) throw new AuthError();
  // A challenge is bound to the user it was issued for.
  if (stored.userId !== userId) return { status: 403, body: { error: "challenge was issued to another user" } };
  const credential = await verifyNewPasskey(config, stored.challenge, userId, response as never);
  if (wrap.credentialId !== credential.credentialId) {
    return { status: 400, body: { error: "the wrap must be for the new passkey" } };
  }
  await config.storage.addCredentialWithWrap(credential, {
    id: wrap.id,
    kind: "passkey",
    credentialId: wrap.credentialId,
    salt: wrap.salt,
    iv: wrap.iv,
    ciphertext: wrap.ciphertext,
  });
  return { status: 201, body: { credentialId: credential.credentialId } };
}
