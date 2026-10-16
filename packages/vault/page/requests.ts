// The popup: serves requests from the app that opened this page. It never imports settings.ts (slice 4).
import {
  type PopupReply,
  type PopupRequest,
  PROTOCOL_VERSION,
  type PreparedCalls,
  type PreparedUserOp,
} from "@norkey/client/protocol";
import type { Address } from "viem";
import { createApi } from "./api.js";
import { RequestError, validateCalls, validateUserOp } from "./calls.js";
import { acceptRequest, announceReady, reply } from "./channel.js";
import { type PageConfig, readConfig } from "./config.js";
import { addPasskey, connectCreate, connectExisting, explain, signCalls, signUserOperation } from "./flows.js";
import { showBackupOffer, showBusy, showConnect, showConsent, showError, showMessage, showWaiting } from "./view.js";

const config = readConfig();
const api = createApi(config.apiUrl);
let pending: PopupRequest | null = null;

function finish(r: PopupReply): void {
  reply(r);
  window.close();
}

function fail(id: string, e: unknown): void {
  // One error list for the popup and the settings page: explain() in flows.ts.
  const message = explain(e);
  if (message === null) {
    finish({ v: PROTOCOL_VERSION, id, ok: false, code: 4001, message: "User rejected the request." });
    return;
  }
  showError(message);
  const code = e instanceof RequestError ? -32602 : -32603;
  // Leave the message visible briefly so the user sees why, then return the error to the app.
  setTimeout(() => finish({ v: PROTOCOL_VERSION, id, ok: false, code, message }), 2500);
}

const reject = (id: string) => () =>
  finish({ v: PROTOCOL_VERSION, id, ok: false, code: 4001, message: "User rejected the request." });

// The validators guarantee the chain is in the map.
const caliburFor = (chainId: number) =>
  (config.chains.find((c) => c.id === chainId) as PageConfig["chains"][number]).calibur;

/** Slice 4: after a new wallet is stored, offer a backup passkey. Resolves when the user is done, and
 *  the popup then replies with the address. An error here is shown, never thrown: the wallet exists. */
function offerBackup(address: Address): Promise<void> {
  return new Promise((done) => {
    const offer = () =>
      showBackupOffer({
        add: async () => {
          showBusy(
            "Follow your browser's prompts: create the backup passkey, confirm it, then unlock with the passkey you just made.",
          );
          try {
            await addPasskey(api, config.rpId, address);
            showMessage("Backup added", "Added. Test it: sign in with the new passkey on the settings page.", [
              ["Continue", done],
            ]);
          } catch (e) {
            const message = explain(e);
            if (message === null) offer();
            else showMessage("Backup not added", message, [["Continue", done]], true);
          }
        },
        skip: done,
      });
    offer();
  });
}

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
      create: run(async () => {
        const created = await connectCreate(api, req.label);
        await offerBackup(created.address);
        return created;
      }),
      existing: run(() => connectExisting(api)),
      cancel: reject(req.id),
    });
    return;
  }
  if (req.kind === "sign-calls") {
    let calls: PreparedCalls;
    try {
      calls = validateCalls(req.calls, config.chains);
    } catch (e) {
      fail(req.id, e);
      return;
    }
    const calibur = caliburFor(calls.chainId);
    const consent = {
      chainId: calls.chainId,
      from: calls.from,
      calls: calls.calls,
      delegate: calls.delegate,
      fee: { kind: "native" as const, gas: calls.gas, maxFeePerGas: calls.maxFeePerGas },
    };
    showConsent(origin, consent, calibur, {
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
    return;
  }
  let op: PreparedUserOp;
  try {
    op = validateUserOp(req.op, config.chains);
  } catch (e) {
    fail(req.id, e);
    return;
  }
  const calibur = caliburFor(op.chainId);
  const consent = {
    chainId: op.chainId,
    from: op.sender,
    calls: op.calls,
    delegate: op.authorizationNonce !== null,
    fee: { kind: "sponsored" as const, paymaster: op.paymaster, nonce: op.nonce, paymasterData: op.paymasterData },
  };
  showConsent(origin, consent, calibur, {
    approve: async () => {
      showBusy("Waiting for your passkey...");
      try {
        const { signature, authorization } = await signUserOperation(api, op, calibur);
        finish({ v: PROTOCOL_VERSION, id: req.id, ok: true, kind: "sign-userop", signature, authorization });
      } catch (e) {
        fail(req.id, e);
      }
    },
    reject: reject(req.id),
  });
}

/** Serve the app that opened this page. main.ts calls this only when the page has an opener. */
export function startRequests(): void {
  showWaiting();
  window.addEventListener("message", (event) => {
    const req = acceptRequest(event, config.appOrigins);
    if (!req || pending) return;
    pending = req;
    handle(req, event.origin);
  });
  announceReady(config.appOrigins);
}
