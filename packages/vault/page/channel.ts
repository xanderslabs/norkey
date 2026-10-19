// The only module that talks to the opener. It never imports key material.
import {
  type PopupAlive,
  type PopupReady,
  type PopupReply,
  type PopupRequest,
  PROTOCOL_VERSION,
} from "@norkey/client/protocol";

let requesterOrigin: string | null = null;

/** Returns the request if it comes from the opener at an allowed origin, else null. */
export function acceptRequest(event: MessageEvent, appOrigins: string[]): PopupRequest | null {
  if (event.source !== window.opener) return null;
  if (!appOrigins.includes(event.origin)) return null;
  const d = event.data as Partial<PopupRequest> | null;
  if (!d || d.v !== PROTOCOL_VERSION || typeof d.id !== "string") return null;
  if (d.kind !== "connect" && d.kind !== "sign-calls" && d.kind !== "sign-userop") return null;
  requesterOrigin = event.origin;
  // The label is display text for the passkey picker. Anything but a string is dropped.
  if (d.kind === "connect" && d.label !== undefined && typeof d.label !== "string") {
    return { v: PROTOCOL_VERSION, id: d.id, kind: "connect" };
  }
  return d as PopupRequest;
}

export function announceReady(appOrigins: string[]): void {
  const ready: PopupReady = { v: PROTOCOL_VERSION, kind: "ready" };
  for (const o of appOrigins) window.opener?.postMessage(ready, o);
}

export function announceAlive(): void {
  if (!requesterOrigin) return;
  const alive: PopupAlive = { v: PROTOCOL_VERSION, kind: "alive" };
  window.opener?.postMessage(alive, requesterOrigin);
}

export function reply(r: PopupReply): void {
  if (!requesterOrigin) return;
  window.opener?.postMessage(r, requesterOrigin);
}
