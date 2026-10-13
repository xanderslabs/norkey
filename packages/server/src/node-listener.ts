import type { IncomingMessage, ServerResponse } from "node:http";

/** Bodies larger than this get 413. Every NorKey request body is a small JSON object. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Adapt a fetch handler to Node's http server. One bad request never takes the process down. */
export function nodeListener(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const declared = Number(req.headers["content-length"] ?? 0);
      const chunks: Buffer[] = [];
      let size = 0;
      // Keep draining past the cap so the socket stays usable, but stop storing.
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer);
      }
      if (declared > MAX_BODY_BYTES || size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" }).end('{"error":"body too large"}');
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
      let request: Request;
      try {
        request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        });
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad request"}');
        return;
      }
      const response = await handler(request);
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") out[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error("norkey serve:", e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"internal error"}');
    }
  };
}
