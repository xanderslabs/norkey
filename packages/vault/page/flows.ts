import type { PreparedCalls, PreparedUserOp } from "@norkey/client/protocol";
import type { Address, Hex } from "viem";
import { type Api, ApiError } from "./api.js";
import { RequestError, signPreparedCalls, signUserOp } from "./calls.js";
import { bytesToBase64Url } from "./encoding.js";
import {
  CancelledError,
  CROSS_DEVICE_REJECTED,
  createPasskey,
  getPasskey,
  NoPrfError,
  PasskeyError,
} from "./passkey.js";
import { addressOf, generateWalletKey, unwrapKey, WrapError, wrapKey } from "./wrap.js";

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

const CREDENTIAL_KEY = "norkey:credential";

/** Convenience only: lets the next prompt target this passkey directly. Missing means a picker. */
function rememberCredential(id: string): void {
  try {
    localStorage.setItem(CREDENTIAL_KEY, id);
  } catch {}
}
function recalledCredential(): string | undefined {
  try {
    return localStorage.getItem(CREDENTIAL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Generate K, wrap it under this passkey's PRF output, and store the wallet. Zeroes K. */
async function createWalletUnder(
  api: Api,
  a: { prfOutput: ArrayBuffer; credentialId: string; userId: string },
): Promise<Address> {
  const key = generateWalletKey();
  try {
    const address = addressOf(key);
    // wrapKey zeroes `key` itself; the finally below is the second guard.
    const wrap = await wrapKey({
      key,
      prfOutput: a.prfOutput,
      credentialId: a.credentialId,
      userId: a.userId,
      address,
    });
    await api.createWallet(address, wrap);
    return address;
  } finally {
    key.fill(0);
  }
}

export async function connectCreate(api: Api, label?: string): Promise<{ address: Address }> {
  const { challengeId, options } = await api.registerOptions(label);
  const created = await createPasskey(options);
  let prf = created.prfOutput;
  try {
    const { userId } = await api.registerVerify(challengeId, created.response);
    if (!prf) {
      // No PRF at create: one immediate get on the same credential.
      const lo = await api.loginOptions(created.response.id);
      const got = await getPasskey(lo.options);
      prf = got.prfOutput;
      await api.loginVerify(lo.challengeId, got.response);
    }
    const address = await createWalletUnder(api, { prfOutput: prf, credentialId: created.response.id, userId });
    rememberCredential(created.response.id);
    return { address };
  } finally {
    if (prf) new Uint8Array(prf).fill(0);
  }
}

export async function connectExisting(api: Api): Promise<{ address: Address }> {
  const lo = await api.loginOptions(); // discoverable: the user picks
  const got = await getPasskey(lo.options);
  try {
    const res = await api.loginVerify(lo.challengeId, got.response);
    let address = res.wallet?.address;
    if (!address) {
      // A create that failed after registering this passkey left a user with no wallet. Finish setup
      // with this gesture's PRF output instead of sending the user off to make a second passkey.
      // That wrap is the wallet's only one, so a passkey from another device cannot make it: over the
      // QR code its PRF value may differ from the one it gives on its own device (Apple called such a
      // mismatch on Safari 18.2 a bug).
      if (got.response.authenticatorAttachment === "cross-platform") throw new PasskeyError(CROSS_DEVICE_REJECTED);
      address = await createWalletUnder(api, {
        prfOutput: got.prfOutput,
        credentialId: got.response.id,
        userId: res.userId,
      });
    }
    rememberCredential(got.response.id);
    return { address };
  } finally {
    new Uint8Array(got.prfOutput).fill(0);
  }
}

/** One passkey gesture: unwrap K, check it opens `from`, run `use`, then zero K and the PRF output.
 *  `refuse` names a passkey that has no wrap yet (add-a-passkey's new one). `local` as in getPasskey.
 *  `pick` asks for any passkey instead of the remembered one and leaves the remembered one as it was:
 *  Test a passkey on the settings page checks a passkey without changing which one the next prompt
 *  targets. */
export async function withUnlockedKey<T>(
  api: Api,
  from: string,
  use: (key: Uint8Array, userId: string) => Promise<T>,
  opts: { refuse?: string; local?: boolean; pick?: boolean } = {},
): Promise<T> {
  const lo = await api.loginOptions(opts.pick ? undefined : recalledCredential());
  const got = await getPasskey(lo.options, opts.local);
  let key: Uint8Array | undefined;
  try {
    if (got.response.id === opts.refuse) throw new FlowError("Use the passkey you already had for this step.");
    const res = await api.loginVerify(lo.challengeId, got.response);
    if (!res.wallet || !res.wrap) throw new FlowError("This passkey cannot sign for this wallet.");
    if (res.wallet.address.toLowerCase() !== from.toLowerCase()) {
      throw new FlowError("This passkey opens a different wallet than the one the app asked for.");
    }
    key = await unwrapKey({
      wrap: res.wrap,
      prfOutput: got.prfOutput,
      userId: res.userId,
      address: res.wallet.address,
    });
    const result = await use(key, res.userId);
    if (!opts.pick) rememberCredential(got.response.id);
    return result;
  } finally {
    key?.fill(0);
    new Uint8Array(got.prfOutput).fill(0);
  }
}

/** A sign-in with no unwrap: the PRF output is zeroed at once. Issues a fresh session and returns the
 *  user's wallet address, or null when the user has no wallet. */
export async function signIn(api: Api, credentialId?: string, local = true): Promise<Address | null> {
  const lo = await api.loginOptions(credentialId);
  const got = await getPasskey(lo.options, local);
  try {
    const res = await api.loginVerify(lo.challengeId, got.response);
    if (!res.wallet) return null;
    rememberCredential(got.response.id);
    return res.wallet.address;
  } finally {
    new Uint8Array(got.prfOutput).fill(0);
  }
}

/** Creation options for one more passkey. The server needs a session from the last 5 minutes, so an
 *  old cookie cannot add one. After a 401 the user signs in once more and the request is repeated. */
async function freshPasskeyOptions(api: Api) {
  try {
    return await api.passkeyOptions();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    await signIn(api, recalledCredential(), false);
    return api.passkeyOptions();
  }
}

/**
 * Wrap the same K under one more passkey. The new passkey is created and read first, and K exists
 * only inside the last gesture, which unlocks it with a passkey the wallet already has, so K never
 * lives across two prompts. The new wrap uses PRF output from a `get` on the new passkey, never the
 * value at create: a value at create that later differs would leave a wrap nothing can open. No
 * prompt passes hints, so another provider or a hardware key can answer.
 */
export async function addPasskey(api: Api, rpId: string, address: Address): Promise<void> {
  const { challengeId, options } = await freshPasskeyOptions(api);
  const created = await createPasskey(options);
  if (created.prfOutput) new Uint8Array(created.prfOutput).fill(0);
  const credentialId = created.response.id;
  let prf: ArrayBuffer | undefined;
  try {
    // A local challenge: this read only evaluates PRF, so nothing is sent to the server.
    const read = await getPasskey(
      {
        challenge: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
        rpId,
        allowCredentials: [{ id: credentialId, type: "public-key", transports: created.response.response.transports }],
        userVerification: "required",
      },
      false,
    );
    prf = read.prfOutput;
    const prfOutput = prf;
    const wrap = await withUnlockedKey(
      api,
      address,
      (key, userId) => wrapKey({ key, prfOutput, credentialId, userId, address }),
      { refuse: credentialId, local: false },
    );
    await api.addPasskey(challengeId, created.response, wrap);
  } finally {
    if (prf) new Uint8Array(prf).fill(0);
  }
}

/** The message to show for a flow error, or null when the user cancelled. */
export function explain(e: unknown): string | null {
  if ((e instanceof DOMException && e.name === "NotAllowedError") || e instanceof CancelledError) return null;
  // excludeCredentials: this provider already holds a passkey for the wallet.
  if (e instanceof DOMException && e.name === "InvalidStateError") {
    return "This passkey provider already has a passkey for this wallet. Choose another provider or a security key.";
  }
  const known =
    e instanceof NoPrfError ||
    e instanceof PasskeyError ||
    e instanceof FlowError ||
    e instanceof WrapError ||
    e instanceof ApiError ||
    e instanceof RequestError;
  if (!known) console.error("norkey:", e);
  return known ? (e as Error).message : "Unexpected error.";
}

export async function signCalls(api: Api, p: PreparedCalls, calibur: Address): Promise<{ raw: Hex }> {
  return withUnlockedKey(api, p.from, async (key) => ({ raw: await signPreparedCalls(key, p, calibur) }));
}

export async function signUserOperation(api: Api, p: PreparedUserOp, calibur: Address) {
  return withUnlockedKey(api, p.sender, (key) => signUserOp(key, p, calibur));
}
