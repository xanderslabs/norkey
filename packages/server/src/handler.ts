import { AuthError, loginOptions, loginVerify, registerOptions, registerVerify } from "./auth/passkey.js";
import { endSession, issueSession, readSession } from "./auth/session.js";
import { type NorKeyHandlerConfig, resolveConfig } from "./config.js";
import { proxyPaymaster } from "./routes/paymaster.js";
import { createWallet } from "./routes/wallet.js";

/** A Web-standard fetch handler. Mount it at `basePath` in any framework that speaks Request/Response. */
export function createNorKeyHandler(input: NorKeyHandlerConfig): (req: Request) => Promise<Response> {
  const config = resolveConfig(input);

  return async (req) => {
    const path = new URL(req.url).pathname;
    const sub = path.startsWith(`${config.basePath}/`) ? path.slice(config.basePath.length) : null;
    const proxyChain = sub === null ? null : /^\/paymaster\/(\d+)$/.exec(sub)?.[1];
    // The app page may call the paymaster proxy and POST /logout, nothing else. `origins` is also
    // WebAuthn's expected origin, and a passkey login releases the wrap, so the two lists never mix.
    // Logout takes both: it can only end a session, never reveal or start one.
    const allowList = proxyChain
      ? config.appOrigins
      : sub === "/logout"
        ? [...config.origins, ...config.appOrigins]
        : config.origins;
    const origin = req.headers.get("origin");
    const allowed = origin !== null && allowList.includes(origin);
    const cors: Record<string, string> = allowed
      ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" }
      : { vary: "Origin" };
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...cors, ...extra },
      });

    if (sub === null) return json(404, { error: "not found" });
    const route = `${req.method} ${sub}`;

    if (req.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    if (req.method !== "GET" && !allowed) return json(403, { error: "origin not allowed" });

    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        const text = await req.text();
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        return json(400, { error: "invalid JSON" });
      }
    }

    try {
      if (proxyChain && req.method === "POST") {
        const chainId = Number(proxyChain);
        const entry = config.paymasterProxy?.[chainId];
        if (!entry) return json(404, { error: "not found" });
        const userId = await readSession(config, req);
        const wallet = userId ? await config.storage.getWallet(userId) : null;
        // No wallet answers 401 too: "connect again" finishes an orphaned setup (slice 2).
        if (!userId || !wallet) return json(401, { error: "not signed in" });
        const r = await proxyPaymaster(entry, { chainId, userId, address: wallet.address, body });
        return json(r.status, r.body);
      }
      switch (route) {
        case "POST /register/options":
          return json(200, await registerOptions(config, body?.label));
        case "POST /register/verify": {
          const userId = await registerVerify(config, String(body.challengeId), body.response as never);
          return json(200, { userId }, { "set-cookie": await issueSession(config, userId) });
        }
        case "POST /login/options":
          return json(
            200,
            await loginOptions(config, typeof body.credentialId === "string" ? body.credentialId : undefined),
          );
        case "POST /login/verify": {
          const { userId, credentialId } = await loginVerify(config, String(body.challengeId), body.response as never);
          const wallet = await config.storage.getWallet(userId);
          const wrap = wallet ? await config.storage.getWrap(userId, credentialId) : null;
          return json(200, { userId, wallet, wrap }, { "set-cookie": await issueSession(config, userId) });
        }
        case "POST /wallet": {
          const userId = await readSession(config, req);
          if (!userId) return json(401, { error: "not signed in" });
          const r = await createWallet(config, userId, body);
          return json(r.status, r.body);
        }
        case "POST /logout":
          // 204 carries no body, so this skips json(). No session answers 204 too: logout is idempotent.
          return new Response(null, {
            status: 204,
            headers: { ...cors, "set-cookie": await endSession(config, req) },
          });
        case "GET /wallet": {
          const userId = await readSession(config, req);
          if (!userId) return json(401, { error: "not signed in" });
          const wallet = await config.storage.getWallet(userId);
          return wallet ? json(200, wallet) : json(404, { error: "no wallet" });
        }
        default:
          return json(404, { error: "not found" });
      }
    } catch (e) {
      if (e instanceof AuthError) return json(401, { error: e.message });
      console.error("norkey:", e);
      return json(500, { error: "internal error" });
    }
  };
}
