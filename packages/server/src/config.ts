import type { NorKeyStorage } from "./storage/types.js";

export type NorKeyHandlerConfig = {
  /** The WebAuthn relying party id: the app's registrable domain, e.g. "app.com". */
  rpId: string;
  rpName?: string;
  /** Origins allowed to call the API and to run WebAuthn: the boundary page origin(s). */
  origins: string[];
  storage: NorKeyStorage;
  /** Where the handler is mounted. Default "/norkey". */
  basePath?: string;
  /** Cookie Domain attribute, e.g. "app.com", so the session reaches every subdomain. */
  cookieDomain?: string;
  /** Session lifetime. Default 7 days. */
  sessionTtlSeconds?: number;
};

export type ResolvedConfig = Required<Omit<NorKeyHandlerConfig, "rpName" | "cookieDomain">> &
  Pick<NorKeyHandlerConfig, "rpName" | "cookieDomain">;

export function resolveConfig(c: NorKeyHandlerConfig): ResolvedConfig {
  if (typeof c.rpId !== "string" || c.rpId.trim() === "") throw new Error("NorKey: rpId is required");
  if (!Array.isArray(c.origins) || c.origins.length === 0)
    throw new Error("NorKey: origins must list at least one origin");
  for (const o of c.origins) {
    let parsed: URL;
    try {
      parsed = new URL(o);
    } catch {
      throw new Error(`NorKey: "${o}" is not an absolute origin`);
    }
    if (parsed.origin !== o) throw new Error(`NorKey: "${o}" must be a bare origin like https://accounts.app.com`);
  }
  return {
    ...c,
    basePath: (c.basePath ?? "/norkey").replace(/\/$/, ""),
    sessionTtlSeconds: c.sessionTtlSeconds ?? 7 * 24 * 3600,
  };
}
