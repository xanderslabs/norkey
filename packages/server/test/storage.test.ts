// Why (spec section 8, test 2): a challenge that can be taken twice replays a login, and a wallet
// row without its wrap (or the reverse) is silent and can strand a key. Every adapter must keep
// these properties, so this file runs against whichever adapter test/adapters.ts selects.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalIdTakenError,
  type StoredCredential,
  type StoredWrap,
  sqlite,
  WalletExistsError,
} from "../src/index.js";
import { adapterName, makeStorage, type TestStorage } from "./adapters.js";

const cred = (credentialId: string, userId: string): StoredCredential => ({
  credentialId,
  userId,
  publicKey: new Uint8Array([1]),
  signCount: 0,
  transports: [],
});
const wrap = (id: string, credentialId: string): StoredWrap => ({
  id,
  kind: "passkey",
  credentialId,
  salt: "s",
  iv: "i",
  ciphertext: "c",
});
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe(`storage contract (${adapterName})`, () => {
  let t: TestStorage;
  const open = async () => {
    t = await makeStorage();
    return t.storage;
  };
  afterEach(async () => {
    await t?.close();
  });

  it("takes a challenge once", async () => {
    const s = await open();
    await s.putChallenge({ id: "c1", challenge: "abc", userId: "u1", expiresAt: Date.now() + 60_000 });
    expect(await s.takeChallenge("c1")).toEqual({ challenge: "abc", userId: "u1" });
    expect(await s.takeChallenge("c1")).toBeNull();
  });

  it("returns null for an expired challenge", async () => {
    const s = await open();
    await s.putChallenge({ id: "c1", challenge: "abc", userId: null, expiresAt: Date.now() - 1 });
    expect(await s.takeChallenge("c1")).toBeNull();
  });

  it("purges expired challenges on put", async () => {
    const s = await open();
    await s.putChallenge({ id: "old", challenge: "a", userId: null, expiresAt: Date.now() - 1 });
    await s.putChallenge({ id: "new", challenge: "b", userId: null, expiresAt: Date.now() + 60_000 });
    expect(await t.rows("challenges")).toBe(1);
  });

  it("gives a challenge to one of two concurrent takers", async () => {
    const s = await open();
    await s.putChallenge({ id: "c1", challenge: "abc", userId: null, expiresAt: Date.now() + 60_000 });
    const got = await Promise.all([s.takeChallenge("c1"), s.takeChallenge("c1")]);
    expect(got.filter((g) => g !== null)).toHaveLength(1);
  });

  it("creates a user and credential together or not at all", async () => {
    const s = await open();
    await s.createUserWithCredential(cred("cred-a", "alice"));
    await expect(s.createUserWithCredential(cred("cred-a", "bob"), "app-bob")).rejects.toThrow();
    expect(await s.getUserIdByExternalId("app-bob")).toBeNull();
    expect(await t.rows("users")).toBe(1);
  });

  it("refuses a second user with the same external id", async () => {
    const s = await open();
    await s.createUserWithCredential(cred("cred-a", "alice"), "app-1");
    await expect(s.createUserWithCredential(cred("cred-b", "bob"), "app-1")).rejects.toBeInstanceOf(
      ExternalIdTakenError,
    );
    expect(await s.getUserIdByExternalId("app-1")).toBe("alice");
    expect(await t.rows("users")).toBe(1);
  });

  it("writes a wallet and its wrap together or not at all", async () => {
    const s = await open();
    await s.createUserWithCredential(cred("cred-a", "alice"));
    await s.createUserWithCredential(cred("cred-b", "bob"));
    await s.createWallet("alice", addr(1), wrap("w1", "cred-a"));
    await expect(s.createWallet("bob", addr(2), wrap("w1", "cred-b"))).rejects.toThrow();
    expect(await s.getWallet("bob")).toBeNull();
  });

  it("refuses a second wallet", async () => {
    const s = await open();
    await s.createUserWithCredential(cred("cred-a", "alice"));
    await s.createWallet("alice", addr(1), wrap("w1", "cred-a"));
    await expect(s.createWallet("alice", addr(2), wrap("w2", "cred-a"))).rejects.toBeInstanceOf(WalletExistsError);
  });

  it("adds a credential and its wrap together or not at all", async () => {
    const s = await open();
    await s.createUserWithCredential(cred("cred-a", "alice"));
    await s.createWallet("alice", addr(1), wrap("w1", "cred-a"));
    await expect(s.addCredentialWithWrap(cred("cred-a2", "alice"), wrap("w1", "cred-a2"))).rejects.toThrow();
    expect(await s.listCredentialIds("alice")).toEqual(["cred-a"]);
  });

  it.skipIf(adapterName !== "sqlite")("adds external_id to a database made before slice 5", async () => {
    const dir = await mkdtemp(join(tmpdir(), "norkey-old-"));
    try {
      const path = join(dir, "old.db");
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE credentials (
          credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, transports TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO users (id, created_at) VALUES ('old-user', 1);
        INSERT INTO credentials VALUES ('old-cred', 'old-user', x'01', 0, '[]', 1);
      `);
      old.close();
      const s = sqlite(path);
      expect((await s.getCredential("old-cred"))?.userId).toBe("old-user");
      await s.createUserWithCredential(cred("new-cred", "new-user"), "app-1");
      expect(await s.getUserIdByExternalId("app-1")).toBe("new-user");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
