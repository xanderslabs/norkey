import type { ResolvedConfig } from "../config.js";
import { type StoredWrap, WalletExistsError } from "../storage/types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WRAP_FIELDS = ["id", "credentialId", "salt", "iv", "ciphertext"] as const;

export function isWrap(w: unknown): w is StoredWrap {
  if (typeof w !== "object" || w === null) return false;
  const r = w as Record<string, unknown>;
  return r.kind === "passkey" && WRAP_FIELDS.every((f) => typeof r[f] === "string" && (r[f] as string).length > 0);
}

/** Returns an HTTP status and body. The caller has already resolved the session user. */
export async function createWallet(
  config: ResolvedConfig,
  userId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const { address, wrap } = (body ?? {}) as { address?: unknown; wrap?: unknown };
  if (typeof address !== "string" || !ADDRESS.test(address) || !isWrap(wrap)) {
    return { status: 400, body: { error: "address and wrap are required" } };
  }
  const credential = await config.storage.getCredential(wrap.credentialId);
  if (credential?.userId !== userId) return { status: 403, body: { error: "credential does not belong to this user" } };
  try {
    await config.storage.createWallet(userId, address, {
      id: wrap.id,
      kind: "passkey",
      credentialId: wrap.credentialId,
      salt: wrap.salt,
      iv: wrap.iv,
      ciphertext: wrap.ciphertext,
    });
  } catch (e) {
    if (e instanceof WalletExistsError) return { status: 409, body: { error: e.message } };
    throw e;
  }
  return { status: 201, body: { address } };
}
