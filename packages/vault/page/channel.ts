// The only module that talks to the opener. It never imports key material.
import type { PopupReady, PopupReply, PopupRequest } from "@norkey/client/protocol";

let requesterOrigin: string | null = null;

/** Returns the request if it comes from the opener at an allowed origin, else null. */
export function acceptRequest(event: MessageEvent, appOrigins: string[]): PopupRequest | null {
  if (event.source !== window.opener) return null;
  if (!appOrigins.includes(event.origin)) return null;
  const d = event.data as Partial<PopupRequest> | null;
  if (!d || d.v !== 1 || typeof d.id !== "string") return null;
  if (d.kind !== "connect" && d.kind !== "sign-tx") return null;
  requesterOrigin = event.origin;
  return d as PopupRequest;
}

export function announceReady(appOrigins: string[]): void {
  const ready: PopupReady = { v: 1, kind: "ready" };
  for (const o of appOrigins) window.opener?.postMessage(ready, o);
}

export function reply(r: PopupReply): void {
  if (!requesterOrigin) return;
  window.opener?.postMessage(r, requesterOrigin);
}
