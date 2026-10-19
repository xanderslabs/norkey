import { APP_SIGNED_OUT, gate, readAppUser } from "./auth/app-user.js";
import {
  AuthError,
  addPasskeyOptions,
  ConflictError,
  loginOptions,
  loginVerify,
  registerOptions,
  registerVerify,
} from "./auth/passkey.js";
import { endSession, issueSession } from "./auth/session.js";
import { type NorKeyHandlerConfig, resolveConfig } from "./config.js";
import { addPasskey } from "./routes/passkeys.js";
import { proxyPaymaster } from "./routes/paymaster.js";
import { createWallet } from "./routes/wallet.js";

const APP_USER_ROUTES = new Set([
  "POST /register/options",
  "POST /register/verify",
  "POST /login/options",
  "POST /login/verify",
]);

/** The passkey routes keep their own wording for a missing or stale NorKey session. */
const addPasskeyError = (error: string) => (error === "not signed in" ? "sign in again to add a passkey" : error);

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
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return json(400, { error: "invalid JSON" });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return json(400, { error: "invalid JSON" });
      }
    }

    const custom = config.auth.mode === "custom";

    try {
      // Custom mode's register and login routes need the app's user before anything else.
      let appUser: string | null = null;
      if (custom && APP_USER_ROUTES.has(route)) {
        appUser = await readAppUser(config, req);
        if (!appUser) return json(401, { error: APP_SIGNED_OUT });
      }
      if (proxyChain && req.method === "POST") {
        const chainId = Number(proxyChain);
        const entry = config.paymasterProxy?.[chainId];
        if (!entry) return json(404, { error: "not found" });
        const signedIn = await gate(config, req, false);
        if ("error" in signedIn) return json(401, { error: signedIn.error });
        const { userId, externalId } = signedIn;
        const wallet = await config.storage.getWallet(userId);
        // No wallet answers 401 too: "connect again" finishes an orphaned setup (slice 2).
        if (!wallet) return json(401, { error: "not signed in" });
        const r = await proxyPaymaster(entry, { chainId, userId, externalId, address: wallet.address, body });
        return json(r.status, r.body);
      }
      switch (route) {
        case "GET /status": {
          if (!custom) return json(200, { mode: "passkey" });
          const external = await readAppUser(config, req);
          if (!external) return json(200, { mode: "custom", signedIn: false });
          const userId = await config.storage.getUserIdByExternalId(external);
          const hasWallet = userId ? (await config.storage.getWallet(userId)) !== null : false;
          return json(200, { mode: "custom", signedIn: true, hasUser: userId !== null, hasWallet });
        }
        case "POST /register/options": {
          if (!appUser) return json(200, await registerOptions(config, body.label));
          const mapped = await config.storage.getUserIdByExternalId(appUser);
          // One wallet per app user (slice 5, decision 7): the page goes to unlock instead.
          if (mapped && (await config.storage.getWallet(mapped))) {
            return json(409, { error: "this account already has a wallet" });
          }
          return json(200, await registerOptions(config, body.label, mapped ?? undefined));
        }
        case "POST /register/verify": {
          const userId = await registerVerify(
            config,
            String(body.challengeId),
            body.response as never,
            appUser ?? undefined,
          );
          return json(200, { userId }, { "set-cookie": await issueSession(config, userId) });
        }
        case "POST /login/options": {
          const credentialId = typeof body.credentialId === "string" ? body.credentialId : undefined;
          if (!appUser) return json(200, await loginOptions(config, credentialId));
          const mapped = await config.storage.getUserIdByExternalId(appUser);
          if (!mapped) return json(404, { error: "no NorKey user" });
          return json(200, await loginOptions(config, credentialId, await config.storage.listCredentialIds(mapped)));
        }
        case "POST /login/verify": {
          const { userId, credentialId } = await loginVerify(config, String(body.challengeId), body.response as never);
          // Two app accounts on one device: the passkey must be the app user's own (slice 5, decision 6).
          if (appUser && (await config.storage.getUserIdByExternalId(appUser)) !== userId) {
            return json(403, { error: "this passkey belongs to another account" });
          }
          const wallet = await config.storage.getWallet(userId);
          const wrap = wallet ? await config.storage.getWrap(userId, credentialId) : null;
          return json(200, { userId, wallet, wrap }, { "set-cookie": await issueSession(config, userId) });
        }
        case "POST /wallet": {
          const signedIn = await gate(config, req, false);
          if ("error" in signedIn) return json(401, { error: signedIn.error });
          const r = await createWallet(config, signedIn.userId, body);
          return json(r.status, r.body);
        }
        case "POST /passkeys/options": {
          // Slice 4, decision 5: a session issued in the last 5 minutes, so an old cookie cannot add one.
          const signedIn = await gate(config, req, true);
          if ("error" in signedIn) return json(401, { error: addPasskeyError(signedIn.error) });
          if (!(await config.storage.getWallet(signedIn.userId))) return json(409, { error: "no wallet" });
          return json(200, await addPasskeyOptions(config, signedIn.userId));
        }
        case "POST /passkeys": {
          const signedIn = await gate(config, req, true);
          if ("error" in signedIn) return json(401, { error: addPasskeyError(signedIn.error) });
          const r = await addPasskey(config, signedIn.userId, body);
          return json(r.status, r.body);
        }
        case "POST /logout":
          // 204 carries no body, so this skips json(). No session answers 204 too: logout is idempotent.
          return new Response(null, {
            status: 204,
            headers: { ...cors, "set-cookie": await endSession(config, req) },
          });
        case "GET /wallet": {
          const signedIn = await gate(config, req, false);
          if ("error" in signedIn) return json(401, { error: signedIn.error });
          const wallet = await config.storage.getWallet(signedIn.userId);
          return wallet ? json(200, wallet) : json(404, { error: "no wallet" });
        }
        default:
          return json(404, { error: "not found" });
      }
    } catch (e) {
      if (e instanceof AuthError) return json(401, { error: e.message });
      if (e instanceof ConflictError) return json(409, { error: e.message });
      console.error("norkey:", e);
      return json(500, { error: "internal error" });
    }
  };
}
