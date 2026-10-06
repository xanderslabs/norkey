#!/usr/bin/env node
import { createServer } from "node:http";
import { createNorKeyHandler, sqlite } from "./index.js";

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

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  const response = await handler(
    new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    }),
  );
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") out[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`norkey listening on :${port}`));
