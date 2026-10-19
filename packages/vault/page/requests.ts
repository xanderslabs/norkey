// The popup: serves requests from the app that opened this page. It never imports settings.ts (slice 4).
import {
  type PopupReply,
  type PopupRequest,
  PROTOCOL_VERSION,
  type PreparedCalls,
  type PreparedUserOp,
} from "@norkey/client/protocol";
import type { Address } from "viem";
import { ApiError, createApi, isAppSignedOut, type Status } from "./api.js";
import { RequestError, validateCalls, validateUserOp } from "./calls.js";
import { acceptRequest, announceAlive, announceReady, reply } from "./channel.js";
import { type PageConfig, readConfig } from "./config.js";
import { addPasskey, connectCreate, connectExisting, explain, signCalls, signUserOperation } from "./flows.js";
import { CROSS_DEVICE_REJECTED, NoPrfError, PasskeyError } from "./passkey.js";
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
  const code = e instanceof RequestError ? -32602 : isAppSignedOut(e) ? 4100 : -32603;
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
            showMessage("Backup added", "Added. Test it on the settings page with Test a passkey.", [
              ["Continue", done],
            ]);
          } catch (e) {
            const message = explain(e);
            if (message === null) offer();
            else
              showMessage(
                "Backup not added",
                message,
                [
                  ["Try again", offer],
                  ["Continue", done],
                ],
                true,
              );
          }
        },
        skip: done,
      });
    offer();
  });
}

/** Connect. Built-in mode offers create or unlock, as before slice 5. Custom mode asks the server who
 *  the app's user is and goes straight to the one step that fits (slice 5, section 6). */
async function connect(req: PopupRequest & { kind: "connect" }, origin: string): Promise<void> {
  const cancel = reject(req.id);
  /** `recover` handles an error itself and returns true, or returns false to reply with it. */
  const run =
    (flow: () => Promise<{ address: Address }>, recover: (e: unknown) => boolean = () => false) =>
    async () => {
      showBusy("Waiting for your passkey...");
      try {
        const { address } = await flow();
        finish({ v: PROTOCOL_VERSION, id: req.id, ok: true, kind: "connect", address });
      } catch (e) {
        if (!recover(e)) fail(req.id, e);
      }
    };
  const createFlow = async () => {
    const created = await connectCreate(api, req.label);
    await offerBackup(created.address);
    return created;
  };

  showBusy("Checking your account...");
  let status: Status;
  try {
    status = await api.status();
  } catch (e) {
    fail(req.id, e);
    return;
  }
  if (status.mode === "passkey") {
    showConnect(origin, { create: run(createFlow), existing: run(() => connectExisting(api)), cancel });
    return;
  }
  if (!status.signedIn) {
    showError("Sign in to the app first.");
    setTimeout(
      () => finish({ v: PROTOCOL_VERSION, id: req.id, ok: false, code: 4100, message: "Sign in to the app first." }),
      2500,
    );
    return;
  }
  // A 409 means this app user already has a NorKey user (another tab got there first, or it has a
  // wallet): ask the server again, which leads to unlock.
  const create = run(createFlow, (e) => {
    if (!(e instanceof ApiError && e.status === 409)) return false;
    void connect(req, origin);
    return true;
  });
  if (!status.hasUser) {
    showMessage("Create your wallet", "Your app account gets a wallet that only your passkey opens.", [
      ["Create wallet", create],
      ["Cancel", cancel],
    ]);
    return;
  }
  // A user with no wallet is an earlier create that stopped after registering the passkey. When that
  // passkey cannot finish setup here, a new passkey joins the same NorKey user (decision 7).
  const orphan = !status.hasWallet;
  const existing = run(
    () => connectExisting(api),
    (e) => {
      if (!orphan) return false;
      if (!(e instanceof NoPrfError || (e instanceof PasskeyError && e.message === CROSS_DEVICE_REJECTED))) {
        return false;
      }
      showMessage(
        "Finish setting up",
        `${explain(e)} You can create a new passkey on this device instead.`,
        [
          ["Create a new passkey", create],
          ["Cancel", cancel],
        ],
        true,
      );
      return true;
    },
  );
  showMessage("Unlock your wallet", "Use the passkey you saved for this account.", [
    ["Use my passkey", existing],
    ["Cancel", cancel],
  ]);
}

function handle(req: PopupRequest, origin: string): void {
  if (req.kind === "connect") {
    void connect(req, origin);
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
    setInterval(announceAlive, 60_000);
    handle(req, event.origin);
  });
  announceReady(config.appOrigins);
}
