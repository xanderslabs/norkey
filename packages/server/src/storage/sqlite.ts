import { DatabaseSync } from "node:sqlite";
import {
  ExternalIdTakenError,
  type NorKeyStorage,
  type StoredCredential,
  type StoredWrap,
  WalletExistsError,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, external_id TEXT);
CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, transports TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id), address TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wraps (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  credential_id TEXT REFERENCES credentials(credential_id), salt TEXT NOT NULL, iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
`;

type Row = Record<string, unknown>;

/** SQLite storage on Node's built-in `node:sqlite`. Pass ":memory:" for a throwaway database. */
export function sqlite(path: string): NorKeyStorage {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  // A database made before custom auth mode existed has no external_id column.
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Row[];
  if (!userColumns.some((col) => col.name === "external_id")) db.exec("ALTER TABLE users ADD COLUMN external_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_external_id ON users(external_id)");

  const toWrap = (r: Row): StoredWrap => ({
    id: r.id as string,
    kind: r.kind as "passkey",
    credentialId: r.credential_id as string,
    salt: r.salt as string,
    iv: r.iv as string,
    ciphertext: r.ciphertext as string,
  });

  return {
    async createUser(userId) {
      db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(userId, Date.now());
    },
    async addCredential(c) {
      db.prepare(
        "INSERT INTO credentials (credential_id, user_id, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(c.credentialId, c.userId, c.publicKey, c.signCount, JSON.stringify(c.transports), Date.now());
    },
    async createUserWithCredential(c, externalId) {
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO users (id, created_at, external_id) VALUES (?, ?, ?)").run(
          c.userId,
          Date.now(),
          externalId ?? null,
        );
        db.prepare(
          "INSERT INTO credentials (credential_id, user_id, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(c.credentialId, c.userId, c.publicKey, c.signCount, JSON.stringify(c.transports), Date.now());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        if (e instanceof Error && e.message.includes("users.external_id")) throw new ExternalIdTakenError();
        throw e;
      }
    },
    async getUserIdByExternalId(externalId) {
      const r = db.prepare("SELECT id FROM users WHERE external_id = ?").get(externalId) as Row | undefined;
      return r ? (r.id as string) : null;
    },
    async getCredential(credentialId) {
      const r = db.prepare("SELECT * FROM credentials WHERE credential_id = ?").get(credentialId) as Row | undefined;
      if (!r) return null;
      return {
        credentialId: r.credential_id as string,
        userId: r.user_id as string,
        publicKey: new Uint8Array(r.public_key as Uint8Array),
        signCount: Number(r.sign_count),
        transports: JSON.parse(r.transports as string) as string[],
      } satisfies StoredCredential;
    },
    async listCredentialIds(userId) {
      const rows = db
        .prepare("SELECT credential_id FROM credentials WHERE user_id = ? ORDER BY rowid")
        .all(userId) as Row[];
      return rows.map((r) => r.credential_id as string);
    },
    async addCredentialWithWrap(c, wrap) {
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO credentials (credential_id, user_id, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(c.credentialId, c.userId, c.publicKey, c.signCount, JSON.stringify(c.transports), Date.now());
        db.prepare(
          "INSERT INTO wraps (id, user_id, kind, credential_id, salt, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(wrap.id, c.userId, wrap.kind, wrap.credentialId, wrap.salt, wrap.iv, wrap.ciphertext, Date.now());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async setSignCount(credentialId, signCount) {
      db.prepare("UPDATE credentials SET sign_count = ? WHERE credential_id = ?").run(signCount, credentialId);
    },
    async putChallenge(c) {
      db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(Date.now());
      db.prepare("INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)").run(
        c.id,
        c.challenge,
        c.userId,
        c.expiresAt,
      );
    },
    async takeChallenge(id) {
      const r = db.prepare("DELETE FROM challenges WHERE id = ? RETURNING *").get(id) as Row | undefined;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      return { challenge: r.challenge as string, userId: (r.user_id as string | null) ?? null };
    },
    async createSession(s) {
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
        s.tokenHash,
        s.userId,
        s.expiresAt,
      );
    },
    async getSessionUser(tokenHash) {
      const r = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
        | Row
        | undefined;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      return r.user_id as string;
    },
    async getSession(tokenHash) {
      const r = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
        | Row
        | undefined;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      return { userId: r.user_id as string, expiresAt: Number(r.expires_at) };
    },
    async deleteSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },
    async createWallet(userId, address, wrap) {
      db.exec("BEGIN");
      try {
        if (db.prepare("SELECT 1 FROM wallets WHERE user_id = ?").get(userId)) throw new WalletExistsError();
        db.prepare("INSERT INTO wallets (user_id, address, created_at) VALUES (?, ?, ?)").run(
          userId,
          address,
          Date.now(),
        );
        db.prepare(
          "INSERT INTO wraps (id, user_id, kind, credential_id, salt, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(wrap.id, userId, wrap.kind, wrap.credentialId, wrap.salt, wrap.iv, wrap.ciphertext, Date.now());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async getWallet(userId) {
      const r = db.prepare("SELECT address FROM wallets WHERE user_id = ?").get(userId) as Row | undefined;
      return r ? { address: r.address as string } : null;
    },
    async getWrap(userId, credentialId) {
      const r = db
        .prepare("SELECT * FROM wraps WHERE user_id = ? AND credential_id = ? AND kind = 'passkey'")
        .get(userId, credentialId) as Row | undefined;
      return r ? toWrap(r) : null;
    },
  };
}
