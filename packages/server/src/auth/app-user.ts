import type { ResolvedConfig } from "../config.js";
import { readFreshSession, readSession } from "./session.js";

/** The 401 error when the app's user is signed out. The boundary page matches it exactly and replies
 *  4100. */
export const APP_SIGNED_OUT = "sign in to the app first";

/** Custom mode only: the app's user id from `getUserId`, trimmed. Anything but a non-empty string
 *  (an empty string, spaces, a number, undefined from untyped JavaScript) counts as signed out. What
 *  `getUserId` throws is thrown on. Built-in mode returns null. */
export async function readAppUser(config: ResolvedConfig, req: Request): Promise<string | null> {
  if (config.auth.mode !== "custom") return null;
  const id: unknown = await config.auth.getUserId(req);
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed === "" ? null : trimmed;
}

/** The NorKey session's user for a session-gated route. Built-in mode is `readSession` (or
 *  `readFreshSession` when `fresh`) and nothing else. Custom mode also needs the app's user, and its
 *  NorKey user must be the session's user, so a NorKey cookie left over from another app user, or
 *  from before the app signed out, opens nothing. */
export async function gate(
  config: ResolvedConfig,
  req: Request,
  fresh: boolean,
): Promise<{ userId: string; externalId: string | null } | { error: string }> {
  const read = fresh ? readFreshSession : readSession;
  if (config.auth.mode !== "custom") {
    const userId = await read(config, req);
    return userId ? { userId, externalId: null } : { error: "not signed in" };
  }
  const externalId = await readAppUser(config, req);
  if (!externalId) return { error: APP_SIGNED_OUT };
  const userId = await read(config, req);
  if (!userId || (await config.storage.getUserIdByExternalId(externalId)) !== userId) {
    return { error: "not signed in" };
  }
  return { userId, externalId };
}
