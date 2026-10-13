import { type PopupReply, type PopupRequest, PROTOCOL_VERSION, type PreparedCalls } from "@norkey/client/protocol";
import { ApiError, createApi } from "./api.js";
import { RequestError, validateCalls } from "./calls.js";
import { acceptRequest, announceReady, reply } from "./channel.js";
import { type PageConfig, readConfig } from "./config.js";
import { connectCreate, connectExisting, FlowError, signCalls } from "./flows.js";
import { CancelledError, NoPrfError, PasskeyError } from "./passkey.js";
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
  const cancelled = (e instanceof DOMException && e.name === "NotAllowedError") || e instanceof CancelledError;
  if (cancelled) {
    finish({ v: PROTOCOL_VERSION, id, ok: false, code: 4001, message: "User rejected the request." });
    return;
  }
  const known =
    e instanceof NoPrfError ||
    e instanceof PasskeyError ||
    e instanceof FlowError ||
    e instanceof WrapError ||
    e instanceof ApiError ||
    e instanceof RequestError;
  const message = known ? (e as Error).message : "Unexpected error.";
  if (!known) console.error("norkey:", e);
  showError(message);
  const code = e instanceof RequestError ? -32602 : -32603;
  // Leave the message visible briefly so the user sees why, then return the error to the app.
  setTimeout(() => finish({ v: PROTOCOL_VERSION, id, ok: false, code, message }), 2500);
}

const reject = (id: string) => () =>
  finish({ v: PROTOCOL_VERSION, id, ok: false, code: 4001, message: "User rejected the request." });

function handle(req: PopupRequest, origin: string): void {
  if (req.kind === "connect") {
    const run = (flow: () => Promise<{ address: `0x${string}` }>) => async () => {
      showBusy("Waiting for your passkey...");
      try {
        const { address } = await flow();
        finish({ v: PROTOCOL_VERSION, id: req.id, ok: true, kind: "connect", address });
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
  let calls: PreparedCalls;
  try {
    calls = validateCalls(req.calls, config.chains);
  } catch (e) {
    fail(req.id, e);
    return;
  }
  // validateCalls guarantees the chain is in the map.
  const calibur = (config.chains.find((c) => c.id === calls.chainId) as PageConfig["chains"][number]).calibur;
  showConsent(origin, calls, calibur, {
    approve: async () => {
      showBusy("Waiting for your passkey...");
      try {
        const { raw } = await signCalls(api, calls, calibur);
        finish({ v: PROTOCOL_VERSION, id: req.id, ok: true, kind: "sign-calls", raw });
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
