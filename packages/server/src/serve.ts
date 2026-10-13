#!/usr/bin/env node
import { createServer } from "node:http";
import { createNorKeyHandler, nodeListener, sqlite } from "./index.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`norkey serve: ${name} is required`);
    process.exit(1);
  }
  return v;
}

const handler = createNorKeyHandler({
  rpId: required("NORKEY_RP_ID"),
  rpName: process.env.NORKEY_RP_NAME,
  origins: required("NORKEY_ORIGINS")
    .split(",")
    .map((s) => s.trim()),
  cookieDomain: process.env.NORKEY_COOKIE_DOMAIN,
  storage: sqlite(process.env.NORKEY_DB ?? "./norkey.db"),
});
const port = Number(process.env.NORKEY_PORT ?? 8787);

createServer(nodeListener(handler)).listen(port, () => console.log(`norkey listening on :${port}`));
