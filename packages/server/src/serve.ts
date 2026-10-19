#!/usr/bin/env node
import { createServer } from "node:http";
import { createNorKeyHandler, type NorKeyHandlerConfig, nodeListener, sqlite } from "./index.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`norkey serve: ${name} is required`);
    process.exit(1);
  }
  return v;
}

const paymasterProxy: NonNullable<NorKeyHandlerConfig["paymasterProxy"]> = {};
for (const [name, url] of Object.entries(process.env)) {
  const m = /^NORKEY_PAYMASTER_(\d+)$/.exec(name);
  if (!m || !url) continue;
  const contextJson = process.env[`NORKEY_PAYMASTER_CONTEXT_${m[1]}`];
  let context: Record<string, unknown> | undefined;
  try {
    context = contextJson ? (JSON.parse(contextJson) as Record<string, unknown>) : undefined;
  } catch {
    console.error(`norkey serve: NORKEY_PAYMASTER_CONTEXT_${m[1]} is not valid JSON`);
    process.exit(1);
  }
  paymasterProxy[Number(m[1])] = { url, context, allow: () => true };
}
if (Object.keys(paymasterProxy).length > 0 && process.env.NORKEY_PAYMASTER_ALLOW !== "all") {
  console.error(
    "norkey serve: set NORKEY_PAYMASTER_ALLOW=all to sponsor every signed-in user. Set limits in your paymaster's dashboard, or mount the handler and write your own allow.",
  );
  process.exit(1);
}

// Postgres when DATABASE_URL is set, else SQLite. The import is dynamic so SQLite needs no postgres.js.
const storage = process.env.DATABASE_URL
  ? (await import("./postgres.js")).postgres(process.env.DATABASE_URL)
  : sqlite(process.env.NORKEY_DB ?? "./norkey.db");

const handler = createNorKeyHandler({
  rpId: required("NORKEY_RP_ID"),
  rpName: process.env.NORKEY_RP_NAME,
  origins: required("NORKEY_ORIGINS")
    .split(",")
    .map((s) => s.trim()),
  appOrigins: (process.env.NORKEY_APP_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  cookieDomain: process.env.NORKEY_COOKIE_DOMAIN,
  storage,
  paymasterProxy,
});
const port = Number(process.env.NORKEY_PORT ?? 8787);

createServer(nodeListener(handler)).listen(port, () => console.log(`norkey listening on :${port}`));
