// The one place tests choose a storage adapter. SQLite by default; NORKEY_PG=1 selects Postgres.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type NorKeyStorage, sqlite } from "../src/index.js";

export const adapterName: "sqlite" | "postgres" = process.env.NORKEY_PG === "1" ? "postgres" : "sqlite";

export type TestStorage = {
  storage: NorKeyStorage;
  /** The row count of a table, read outside the adapter. */
  rows(table: "challenges" | "users"): Promise<number>;
  close(): Promise<void>;
};

export async function makeStorage(): Promise<TestStorage> {
  if (adapterName === "postgres") {
    if (!process.env.DATABASE_URL) throw new Error("test:pg needs DATABASE_URL (run pnpm db:up)");
    throw new Error("Postgres adapter not built yet");
  }
  const dir = await mkdtemp(join(tmpdir(), "norkey-test-"));
  const path = join(dir, "norkey.db");
  const storage = sqlite(path);
  return {
    storage,
    async rows(table) {
      const reader = new DatabaseSync(path);
      try {
        return Number((reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
      } finally {
        reader.close();
      }
    },
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
