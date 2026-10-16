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
  /** The user row and its first credential in one transaction: both or neither. */
  createUserWithCredential(c: StoredCredential): Promise<void>;
  getCredential(credentialId: string): Promise<StoredCredential | null>;
  /** The ids of every credential of this user, oldest first. */
  listCredentialIds(userId: string): Promise<string[]>;
  /** One more credential for an existing user, and its wrap, in one transaction: both or neither. */
  addCredentialWithWrap(c: StoredCredential, wrap: StoredWrap): Promise<void>;
  setSignCount(credentialId: string, signCount: number): Promise<void>;
  putChallenge(c: { id: string; challenge: string; userId: string | null; expiresAt: number }): Promise<void>;
  /** Deletes and returns the challenge; null if missing or expired. Single use. */
  takeChallenge(id: string): Promise<{ challenge: string; userId: string | null } | null>;
  createSession(s: { tokenHash: string; userId: string; expiresAt: number }): Promise<void>;
  getSessionUser(tokenHash: string): Promise<string | null>;
  /** The session's user and expiry time; null if missing or expired. */
  getSession(tokenHash: string): Promise<{ userId: string; expiresAt: number } | null>;
  /** Deletes the session with this token hash. A missing session is not an error. */
  deleteSession(tokenHash: string): Promise<void>;
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
