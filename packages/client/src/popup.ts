import { ProviderRpcError } from "./errors.js";
import type { PopupReply, PopupRequest } from "./protocol.js";

/** How long to wait for the popup to reply before giving up. */
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Open the boundary page as a popup, send `req`, and resolve with its reply.
 *
 * Replies are accepted only from the exact window this call opened (`event.source === popup`) and
 * only from the vault origin. The request is re-sent when the popup announces `ready`, because a
 * message posted before the popup's listener exists is lost. Must be called inside a user gesture,
 * or the browser blocks the popup.
 */
export function openPopup(vaultOrigin: string, req: PopupRequest): Promise<PopupReply> {
  const parsed = new URL(vaultOrigin);
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalhost) {
    return Promise.reject(new Error(`vaultOrigin must use HTTPS (got "${vaultOrigin}")`));
  }
  const expectedOrigin = parsed.origin;
  const popup = window.open(`${expectedOrigin}/`, "_blank", "popup,width=420,height=640");
  if (!popup)
    return Promise.reject(new ProviderRpcError(4001, "The wallet popup was blocked. Allow popups and try again."));

  return new Promise<PopupReply>((resolve, reject) => {
    let settled = false;

    function cleanup(): void {
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(pollId);
      window.removeEventListener("message", handler);
      popup?.close();
    }

    function handler(event: MessageEvent): void {
      if (event.source !== popup || event.origin !== expectedOrigin) return;
      const data = event.data as { v?: unknown; kind?: unknown; id?: unknown } | null;
      if (typeof data !== "object" || data === null || data.v !== 1) return;
      if (data.kind === "ready") {
        popup?.postMessage(req, expectedOrigin);
        return;
      }
      if (data.id !== req.id) return;
      cleanup();
      resolve(event.data as PopupReply);
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new ProviderRpcError(4001, "The wallet popup timed out."));
    }, POPUP_TIMEOUT_MS);

    // A closed popup and a reply posted just before closing can race. Defer the reject by one task
    // so an already-queued message event resolves first.
    const pollId = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(pollId);
      setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new ProviderRpcError(4001, "The wallet popup was closed."));
      }, 0);
    }, 500);

    window.addEventListener("message", handler);
    popup.postMessage(req, expectedOrigin);
  });
}
