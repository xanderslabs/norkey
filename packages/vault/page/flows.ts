import type { PreparedTx } from "@norkey/client/protocol";
import type { Address, Hex } from "viem";
import type { Api } from "./api.js";
import { accountFromKey } from "./key-account.js";
import { createPasskey, getPasskey } from "./passkey.js";
import { addressOf, generateWalletKey, unwrapKey, wrapKey } from "./wrap.js";

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

export async function connectCreate(api: Api): Promise<{ address: Address }> {
  const { challengeId, options } = await api.registerOptions();
  const created = await createPasskey(options);
  const { userId } = await api.registerVerify(challengeId, created.response);
  let prf = created.prfOutput;
  if (!prf) {
    // No PRF at create: one immediate get on the same credential.
    const lo = await api.loginOptions(created.response.id);
    const got = await getPasskey(lo.options);
    await api.loginVerify(lo.challengeId, got.response);
    prf = got.prfOutput;
  }
  const key = generateWalletKey();
  try {
    const address = addressOf(key);
    // wrapKey zeroes `key` itself; the finally below is the second guard.
    const wrap = await wrapKey({ key, prfOutput: prf, credentialId: created.response.id, userId, address });
    await api.createWallet(address, wrap);
    rememberCredential(created.response.id);
    return { address };
  } finally {
    key.fill(0);
    new Uint8Array(prf).fill(0);
  }
}

export async function connectExisting(api: Api): Promise<{ address: Address }> {
  const lo = await api.loginOptions(); // discoverable: the user picks
  const got = await getPasskey(lo.options);
  new Uint8Array(got.prfOutput).fill(0); // connect needs no key
  const res = await api.loginVerify(lo.challengeId, got.response);
  if (!res.wallet) throw new FlowError("This passkey has no NorKey wallet here yet. Create one instead.");
  rememberCredential(got.response.id);
  return { address: res.wallet.address };
}

export async function signTx(api: Api, tx: PreparedTx): Promise<{ raw: Hex }> {
  const lo = await api.loginOptions(recalledCredential());
  const got = await getPasskey(lo.options);
  let key: Uint8Array | undefined;
  try {
    const res = await api.loginVerify(lo.challengeId, got.response);
    if (!res.wallet || !res.wrap) throw new FlowError("This passkey cannot sign for this wallet.");
    if (res.wallet.address.toLowerCase() !== tx.from.toLowerCase()) {
      throw new FlowError("This passkey opens a different wallet than the one the app asked for.");
    }
    key = await unwrapKey({
      wrap: res.wrap,
      prfOutput: got.prfOutput,
      userId: res.userId,
      address: res.wallet.address,
    });
    const account = accountFromKey(key);
    const raw = await account.signTransaction({
      type: "eip1559",
      chainId: tx.chainId,
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
      nonce: tx.nonce,
      gas: BigInt(tx.gas),
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    });
    rememberCredential(got.response.id);
    return { raw };
  } finally {
    key?.fill(0);
    new Uint8Array(got.prfOutput).fill(0);
  }
}
