export type StoredWrap = {
  id: string;
  kind: "passkey";
  credentialId: string;
  salt: string;
  iv: string;
  ciphertext: string;
};

export type StoredCredential = {
  credentialId: string;
  userId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  signCount: number;
  transports: string[];
};

/** Everything NorKey keeps. No method takes or returns a plaintext key, a KEK, or a PRF output. */
export interface NorKeyStorage {
  createUser(userId: string): Promise<void>;
  addCredential(c: StoredCredential): Promise<void>;
  getCredential(credentialId: string): Promise<StoredCredential | null>;
  setSignCount(credentialId: string, signCount: number): Promise<void>;
  putChallenge(c: { id: string; challenge: string; userId: string | null; expiresAt: number }): Promise<void>;
  /** Deletes and returns the challenge; null if missing or expired. Single use. */
  takeChallenge(id: string): Promise<{ challenge: string; userId: string | null } | null>;
  createSession(s: { tokenHash: string; userId: string; expiresAt: number }): Promise<void>;
  getSessionUser(tokenHash: string): Promise<string | null>;
  /** Wallet row and its first wrap in one transaction. Throws WalletExistsError if one exists. */
  createWallet(userId: string, address: string, wrap: StoredWrap): Promise<void>;
  getWallet(userId: string): Promise<{ address: string } | null>;
  getWrap(userId: string, credentialId: string): Promise<StoredWrap | null>;
}

export class WalletExistsError extends Error {
  constructor() {
    super("This user already has a wallet");
    this.name = "WalletExistsError";
  }
}
