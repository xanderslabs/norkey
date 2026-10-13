import { ProviderRpcError } from "./errors.js";
import { type PopupReply, type PopupRequest, PROTOCOL_VERSION } from "./protocol.js";

/** How long to wait for the popup to reply before giving up. */
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Open the boundary page as a popup, send the request `prepare` resolves to, and resolve with the reply.
 *
 * The popup opens synchronously, before `prepare` runs: browsers allow `window.open` only while the
 * click's user activation lasts, and preparing a transaction takes RPC round trips that can outlast
 * it. The request is posted once both the request is ready and the popup has announced `ready` (a
 * message posted before the popup's listener exists is lost). If `prepare` fails, the popup closes
 * and its error is returned.
 *
 * Replies are accepted only from the exact window this call opened (`event.source === popup`), only
 * from the vault origin, and only with the request's id.
 */
export function openPopup(vaultOrigin: string, id: string, prepare: () => Promise<PopupRequest>): Promise<PopupReply> {
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
    let req: PopupRequest | null = null;
    let ready = false;

    function cleanup(): void {
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(pollId);
      window.removeEventListener("message", handler);
      popup?.close();
    }

    function send(): void {
      if (req && ready && !settled) popup?.postMessage(req, expectedOrigin);
    }

    function handler(event: MessageEvent): void {
      if (event.source !== popup || event.origin !== expectedOrigin) return;
      const data = event.data as { v?: unknown; kind?: unknown; id?: unknown } | null;
      if (typeof data !== "object" || data === null || data.v !== PROTOCOL_VERSION) return;
      if (data.kind === "ready") {
        ready = true;
        send();
        return;
      }
      if (data.id !== id) return;
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
    prepare().then(
      (r) => {
        req = r;
        send();
      },
      (e: unknown) => {
        if (settled) return;
        cleanup();
        reject(e);
      },
    );
  });
}
