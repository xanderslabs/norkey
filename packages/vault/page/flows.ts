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

export async function connectCreate(api: Api): Promise<{ address: Address }> {
  const { challengeId, options } = await api.registerOptions();
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
