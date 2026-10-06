import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

/** Serve a built boundary page with its headers. For local development and minimal hosting. */
export async function serveVault(dir: string, port: number): Promise<void> {
  const html = await readFile(join(dir, "index.html"));
  const headers = JSON.parse(await readFile(join(dir, "headers.json"), "utf8")) as Record<string, string>;
  createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/" && path !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...headers });
    res.end(html);
  }).listen(port, () => console.log(`norkey-vault serving ${dir} on :${port}`));
}
