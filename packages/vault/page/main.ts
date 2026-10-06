import type { PopupReply, PopupRequest } from "@norkey/client/protocol";
import { ApiError, createApi } from "./api.js";
import { acceptRequest, announceReady, reply } from "./channel.js";
import { readConfig } from "./config.js";
import { connectCreate, connectExisting, FlowError, signTx } from "./flows.js";
import { NoPrfError } from "./passkey.js";
import { showBusy, showConnect, showConsent, showError, showWaiting } from "./view.js";
import { WrapError } from "./wrap.js";

const config = readConfig();
const api = createApi(config.apiUrl);
let pending: PopupRequest | null = null;

function finish(r: PopupReply): void {
  reply(r);
  window.close();
}

function fail(id: string, e: unknown): void {
  const cancelled = e instanceof DOMException && e.name === "NotAllowedError";
  const known = e instanceof NoPrfError || e instanceof FlowError || e instanceof WrapError || e instanceof ApiError;
  const message = cancelled ? "User rejected the request." : known ? (e as Error).message : "Unexpected error.";
  if (!cancelled) {
    showError(message);
    // Leave the message visible briefly so the user sees why, then return the error to the app.
    setTimeout(() => finish({ v: 1, id, ok: false, code: -32603, message }), 2500);
    return;
  }
  finish({ v: 1, id, ok: false, code: 4001, message });
}

const reject = (id: string) => () => finish({ v: 1, id, ok: false, code: 4001, message: "User rejected the request." });

function handle(req: PopupRequest, origin: string): void {
  if (req.kind === "connect") {
    const run = (flow: () => Promise<{ address: `0x${string}` }>) => async () => {
      showBusy("Waiting for your passkey...");
      try {
        const { address } = await flow();
        finish({ v: 1, id: req.id, ok: true, kind: "connect", address });
      } catch (e) {
        fail(req.id, e);
      }
    };
    showConnect(origin, {
      create: run(() => connectCreate(api)),
      existing: run(() => connectExisting(api)),
      cancel: reject(req.id),
    });
    return;
  }
  showConsent(origin, req.tx, {
    approve: async () => {
      showBusy("Waiting for your passkey...");
      try {
        const { raw } = await signTx(api, req.tx);
        finish({ v: 1, id: req.id, ok: true, kind: "sign-tx", raw });
      } catch (e) {
        fail(req.id, e);
      }
    },
    reject: reject(req.id),
  });
}

if (!window.opener) {
  showWaiting("Open this page from your app to use your wallet.");
} else {
  showWaiting();
  window.addEventListener("message", (event) => {
    const req = acceptRequest(event, config.appOrigins);
    if (!req || pending) return;
    pending = req;
    handle(req, event.origin);
  });
  announceReady(config.appOrigins);
}
