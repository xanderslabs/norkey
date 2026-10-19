// The one place tests choose a storage adapter. SQLite by default; NORKEY_PG=1 selects Postgres.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "postgres";
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
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("test:pg needs DATABASE_URL (run pnpm db:up)");
    const { postgres } = await import("../src/storage/postgres.js");
    // Each test starts from empty tables. A fresh database has none yet; the adapter creates them.
    const admin = pg(url, { max: 1, onnotice: () => {} });
    try {
      const tables = await admin<{ name: string }[]>`
        SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'norkey\_%'`;
      if (tables.length > 0) await admin`TRUNCATE ${admin(tables.map((t) => t.name))} RESTART IDENTITY CASCADE`;
    } finally {
      await admin.end();
    }
    const storage = postgres(url);
    return {
      storage,
      async rows(table) {
        const reader = pg(url, { max: 1 });
        try {
          const [r] = await reader<{ n: string }[]>`SELECT COUNT(*) AS n FROM ${reader(`norkey_${table}`)}`;
          return Number(r?.n);
        } finally {
          await reader.end();
        }
      },
      async close() {
        await storage.close();
      },
    };
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
