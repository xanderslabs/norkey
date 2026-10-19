import pg from "postgres";
import {
  ExternalIdTakenError,
  type NorKeyStorage,
  type StoredCredential,
  type StoredWrap,
  WalletExistsError,
} from "./types.js";

/**
 * The tables NorKey keeps in Postgres. They are created on first use; teams that run their own
 * migrations can apply this instead. Names are prefixed `norkey_` because the database is shared with
 * the app. Times are BIGINT milliseconds, as in the SQLite adapter.
 */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS norkey_users (
  id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, external_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS norkey_credentials (
  credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES norkey_users(id),
  public_key BYTEA NOT NULL, sign_count BIGINT NOT NULL, transports TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS norkey_wallets (
  user_id TEXT PRIMARY KEY REFERENCES norkey_users(id), address TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS norkey_wraps (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES norkey_users(id), kind TEXT NOT NULL,
  credential_id TEXT REFERENCES norkey_credentials(credential_id), salt TEXT NOT NULL, iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS norkey_challenges (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS norkey_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES norkey_users(id), expires_at BIGINT NOT NULL);
`;

type Row = Record<string, unknown>;

/** True for a Postgres unique violation on this constraint. */
function violates(e: unknown, constraint: string): boolean {
  return e instanceof pg.PostgresError && e.code === "23505" && e.constraint_name === constraint;
}

/**
 * Postgres storage on postgres.js. The tables are created on first use. Run and tested on Node only.
 * `close()` ends the connection pool.
 */
export function postgres(url: string): NorKeyStorage & { close(): Promise<void> } {
  let sql: pg.Sql;
  try {
    sql = pg(url, { onnotice: () => {} });
  } catch {
    // The parser's own error can carry the URL, and with it the password.
    throw new Error("postgres: the connection URL is not valid");
  }

  let ready: Promise<void> | undefined;
  /** Creates the tables once. A failed attempt is retried by the next call. */
  const schema = () => {
    ready ??= sql.unsafe(POSTGRES_SCHEMA).then(
      () => undefined,
      (e) => {
        ready = undefined;
        throw e;
      },
    );
    return ready;
  };

  const toWrap = (r: Row): StoredWrap => ({
    id: r.id as string,
    kind: r.kind as "passkey",
    credentialId: r.credential_id as string,
    salt: r.salt as string,
    iv: r.iv as string,
    ciphertext: r.ciphertext as string,
  });
  const credentialRow = (c: StoredCredential) => ({
    credential_id: c.credentialId,
    user_id: c.userId,
    public_key: Buffer.from(c.publicKey),
    sign_count: c.signCount,
    transports: JSON.stringify(c.transports),
    created_at: Date.now(),
  });
  const wrapRow = (userId: string, wrap: StoredWrap) => ({
    id: wrap.id,
    user_id: userId,
    kind: wrap.kind,
    credential_id: wrap.credentialId,
    salt: wrap.salt,
    iv: wrap.iv,
    ciphertext: wrap.ciphertext,
    created_at: Date.now(),
  });

  return {
    async createUser(userId) {
      await schema();
      await sql`INSERT INTO norkey_users (id, created_at) VALUES (${userId}, ${Date.now()})`;
    },
    async addCredential(c) {
      await schema();
      await sql`INSERT INTO norkey_credentials ${sql(credentialRow(c))}`;
    },
    async createUserWithCredential(c, externalId) {
      await schema();
      try {
        await sql.begin(async (tx) => {
          await tx`INSERT INTO norkey_users (id, created_at, external_id)
            VALUES (${c.userId}, ${Date.now()}, ${externalId ?? null})`;
          await tx`INSERT INTO norkey_credentials ${tx(credentialRow(c))}`;
        });
      } catch (e) {
        if (violates(e, "norkey_users_external_id_key")) throw new ExternalIdTakenError();
        throw e;
      }
    },
    async getUserIdByExternalId(externalId) {
      await schema();
      const [r] = await sql<Row[]>`SELECT id FROM norkey_users WHERE external_id = ${externalId}`;
      return r ? (r.id as string) : null;
    },
    async getCredential(credentialId) {
      await schema();
      const [r] = await sql<Row[]>`SELECT * FROM norkey_credentials WHERE credential_id = ${credentialId}`;
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
      await schema();
      const rows = await sql<Row[]>`SELECT credential_id FROM norkey_credentials WHERE user_id = ${userId}
        ORDER BY created_at, credential_id`;
      return rows.map((r) => r.credential_id as string);
    },
    async addCredentialWithWrap(c, wrap) {
      await schema();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO norkey_credentials ${tx(credentialRow(c))}`;
        await tx`INSERT INTO norkey_wraps ${tx(wrapRow(c.userId, wrap))}`;
      });
    },
    async setSignCount(credentialId, signCount) {
      await schema();
      await sql`UPDATE norkey_credentials SET sign_count = ${signCount} WHERE credential_id = ${credentialId}`;
    },
    async putChallenge(c) {
      await schema();
      await sql`DELETE FROM norkey_challenges WHERE expires_at < ${Date.now()}`;
      await sql`INSERT INTO norkey_challenges (id, challenge, user_id, expires_at)
        VALUES (${c.id}, ${c.challenge}, ${c.userId}, ${c.expiresAt})`;
    },
    async takeChallenge(id) {
      await schema();
      // One statement: of two concurrent takers, only one gets the row back.
      const [r] = await sql<Row[]>`DELETE FROM norkey_challenges WHERE id = ${id} RETURNING *`;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      return { challenge: r.challenge as string, userId: (r.user_id as string | null) ?? null };
    },
    async createSession(s) {
      await schema();
      await sql`DELETE FROM norkey_sessions WHERE expires_at < ${Date.now()}`;
      await sql`INSERT INTO norkey_sessions (token_hash, user_id, expires_at)
        VALUES (${s.tokenHash}, ${s.userId}, ${s.expiresAt})`;
    },
    async getSessionUser(tokenHash) {
      await schema();
      const [r] = await sql<Row[]>`SELECT user_id, expires_at FROM norkey_sessions WHERE token_hash = ${tokenHash}`;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      return r.user_id as string;
    },
    async getSession(tokenHash) {
      await schema();
      const [r] = await sql<Row[]>`SELECT user_id, expires_at FROM norkey_sessions WHERE token_hash = ${tokenHash}`;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      return { userId: r.user_id as string, expiresAt: Number(r.expires_at) };
    },
    async deleteSession(tokenHash) {
      await schema();
      await sql`DELETE FROM norkey_sessions WHERE token_hash = ${tokenHash}`;
    },
    async createWallet(userId, address, wrap) {
      await schema();
      try {
        await sql.begin(async (tx) => {
          await tx`INSERT INTO norkey_wallets (user_id, address, created_at) VALUES (${userId}, ${address}, ${Date.now()})`;
          await tx`INSERT INTO norkey_wraps ${tx(wrapRow(userId, wrap))}`;
        });
      } catch (e) {
        if (violates(e, "norkey_wallets_pkey")) throw new WalletExistsError();
        throw e;
      }
    },
    async getWallet(userId) {
      await schema();
      const [r] = await sql<Row[]>`SELECT address FROM norkey_wallets WHERE user_id = ${userId}`;
      return r ? { address: r.address as string } : null;
    },
    async getWrap(userId, credentialId) {
      await schema();
      const [r] = await sql<Row[]>`SELECT * FROM norkey_wraps
        WHERE user_id = ${userId} AND credential_id = ${credentialId} AND kind = 'passkey'`;
      return r ? toWrap(r) : null;
    },
    async close() {
      await sql.end();
    },
  };
}
