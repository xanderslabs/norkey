import type { NorKeyStorage } from "./storage/types.js";

export type PaymasterAllowArgs = {
  userId: string;
  /** The app's user id in custom auth mode, null in built-in mode. */
  externalId: string | null;
  address: string;
  chainId: number;
  method: string;
  userOp: unknown;
};

/** Who says who the user is. "passkey" (default): NorKey's own passkey sign-in. "custom": the app's
 *  session, read by `getUserId`; a passkey assertion is still verified for every key operation. */
export type AuthConfig =
  | { mode: "passkey" }
  | { mode: "custom"; getUserId: (req: Request) => string | null | Promise<string | null> };

export type PaymasterProxyEntry = {
  /** The vendor's bundler and paymaster URL, API key included. Never sent to a client. */
  url: string;
  /** Sent as the ERC-7677 context on every pm_* call. The client's context is dropped. */
  context?: Record<string, unknown>;
  /** Required. Decides each sponsorship request; false answers 403. */
  allow: (a: PaymasterAllowArgs) => boolean | Promise<boolean>;
};

export type NorKeyHandlerConfig = {
  /** The WebAuthn relying party id: the app's registrable domain, e.g. "app.com". */
  rpId: string;
  rpName?: string;
  /** Origins allowed to call the API and to run WebAuthn: the boundary page origin(s). */
  origins: string[];
  /** The app page origin(s). They may call the paymaster proxy and nothing else: `origins` is also
   *  WebAuthn's expected origin, and a passkey login releases the wrap. */
  appOrigins?: string[];
  storage: NorKeyStorage;
  /** Where the handler is mounted. Default "/norkey". */
  basePath?: string;
  /** Cookie Domain attribute, e.g. "app.com", so the session reaches every subdomain. */
  cookieDomain?: string;
  /** Session lifetime. Default 7 days. */
  sessionTtlSeconds?: number;
  /** Per chain id: relay ERC-7677 and bundler calls for signed-in users to this vendor URL. */
  paymasterProxy?: Record<number, PaymasterProxyEntry>;
  /** Default { mode: "passkey" }. Custom mode reads the app's own session cookie in `getUserId`. */
  auth?: AuthConfig;
};

export type ResolvedConfig = Required<Omit<NorKeyHandlerConfig, "rpName" | "cookieDomain" | "paymasterProxy">> &
  Pick<NorKeyHandlerConfig, "rpName" | "cookieDomain" | "paymasterProxy">;

function checkOrigins(list: string[], name: string): void {
  for (const o of list) {
    let parsed: URL;
    try {
      parsed = new URL(o);
    } catch {
      throw new Error(`NorKey: ${name}: "${o}" is not an absolute origin`);
    }
    if (parsed.origin !== o)
      throw new Error(`NorKey: ${name}: "${o}" must be a bare origin like https://accounts.app.com`);
  }
}

export function resolveConfig(c: NorKeyHandlerConfig): ResolvedConfig {
  if (typeof c.rpId !== "string" || c.rpId.trim() === "") throw new Error("NorKey: rpId is required");
  if (!Array.isArray(c.origins) || c.origins.length === 0)
    throw new Error("NorKey: origins must list at least one origin");
  checkOrigins(c.origins, "origins");
  const appOrigins = c.appOrigins ?? [];
  checkOrigins(appOrigins, "appOrigins");
  // An app origin in origins would also be WebAuthn's expected origin, and a passkey login releases the wrap.
  if (appOrigins.some((o) => c.origins.includes(o)))
    throw new Error("NorKey: an origin cannot be in both origins and appOrigins");
  const proxied = Object.entries(c.paymasterProxy ?? {});
  for (const [chainId, p] of proxied) {
    // Never echo p.url: it holds the API key.
    let url: URL | null = null;
    try {
      url = new URL(p.url);
    } catch {}
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new Error(`NorKey: paymasterProxy ${chainId}: url must be an absolute http(s) URL`);
    }
    if (typeof p.allow !== "function") {
      throw new Error(
        `NorKey: paymasterProxy ${chainId}: allow is required. Write allow: () => true to sponsor every signed-in user, and set limits in your paymaster's dashboard.`,
      );
    }
  }
  if (proxied.length > 0 && appOrigins.length === 0) {
    throw new Error("NorKey: appOrigins must list the app's origin when paymasterProxy is set");
  }
  const auth: AuthConfig = c.auth ?? { mode: "passkey" };
  if (auth.mode !== "passkey" && auth.mode !== "custom") {
    throw new Error('NorKey: auth.mode must be "passkey" or "custom"');
  }
  if (auth.mode === "custom" && typeof auth.getUserId !== "function") {
    throw new Error("NorKey: auth.getUserId is required in custom mode");
  }
  return {
    ...c,
    auth,
    appOrigins,
    basePath: (c.basePath ?? "/norkey").replace(/\/$/, ""),
    sessionTtlSeconds: c.sessionTtlSeconds ?? 7 * 24 * 3600,
  };
}
