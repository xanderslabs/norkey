import { encodeExecute } from "@norkey/client/calibur";
import { MAX_CALLS, type PreparedCalls } from "@norkey/client/protocol";
import { type Address, type Hex, isAddress, isHex, zeroAddress } from "viem";
import type { PageConfig } from "./config.js";
import { accountFromKey } from "./key-account.js";

/** A request the page refuses before showing anything. Replies -32602. */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const quantity = (v: unknown): v is string => typeof v === "string" && QUANTITY.test(v);

/** Checks every field the page will show or sign. Returns the same object, typed. */
export function validateCalls(input: unknown, chains: PageConfig["chains"]): PreparedCalls {
  if (typeof input !== "object" || input === null) throw new RequestError("The request has no transaction.");
  const c = input as Record<string, unknown>;
  if (!chains.some((x) => x.id === c.chainId)) {
    throw new RequestError(`This wallet is not set up for chain ${String(c.chainId)}.`);
  }
  if (typeof c.from !== "string" || !isAddress(c.from, { strict: false })) {
    throw new RequestError("The sender is not an address.");
  }
  if (!quantity(c.gas) || !quantity(c.maxFeePerGas) || !quantity(c.maxPriorityFeePerGas)) {
    throw new RequestError("The gas fields are not hex quantities.");
  }
  if (!Number.isSafeInteger(c.nonce) || (c.nonce as number) < 0) throw new RequestError("The nonce is not valid.");
  if (typeof c.delegate !== "boolean") throw new RequestError("The request does not say whether to delegate.");
  if (!Array.isArray(c.calls) || c.calls.length < 1 || c.calls.length > MAX_CALLS) {
    throw new RequestError(`A request needs between 1 and ${MAX_CALLS} calls.`);
  }
  for (const call of c.calls as Record<string, unknown>[]) {
    if (typeof call?.to !== "string" || !isAddress(call.to, { strict: false })) {
      throw new RequestError("A call has no valid recipient.");
    }
    // Calibur runs a call to the account, or to address(0), as the account itself: as the root key it
    // could reach admin functions such as registering a key. The consent screen cannot show that.
    const to = call.to.toLowerCase();
    if (to === c.from.toLowerCase() || to === zeroAddress) {
      throw new RequestError("A call to the wallet itself is not supported.");
    }
    if (!quantity(call.value)) throw new RequestError("A call's value is not a hex quantity.");
    if (typeof call.data !== "string" || !isHex(call.data, { strict: true }) || call.data.length % 2 !== 0) {
      throw new RequestError("A call's data is not hex.");
    }
  }
  return c as PreparedCalls;
}

/**
 * Sign what the consent screen showed. One call on a delegated account is a plain EIP-1559
 * transaction. Anything else is a self-call to Calibur's `execute`, and on an undelegated account it
 * is a type-4 transaction carrying the authorization. `calibur` comes from the page's build config.
 */
export async function signPreparedCalls(key: Uint8Array, p: PreparedCalls, calibur: Address): Promise<Hex> {
  const account = accountFromKey(key);
  if (account.address.toLowerCase() !== p.from.toLowerCase()) {
    throw new RequestError("The unlocked key does not match the sender.");
  }
  const common = {
    chainId: p.chainId,
    nonce: p.nonce,
    gas: BigInt(p.gas),
    maxFeePerGas: BigInt(p.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
  };
  const calls = p.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));
  if (!p.delegate && calls.length === 1) {
    return account.signTransaction({ type: "eip1559", ...common, ...calls[0] });
  }
  const data = encodeExecute(calls);
  if (!p.delegate) {
    return account.signTransaction({ type: "eip1559", ...common, to: p.from, value: 0n, data });
  }
  // EIP-7702: the transaction spends `nonce` before its authorizations are checked, so a
  // self-sponsored authorization is signed over nonce + 1.
  const authorization = await account.signAuthorization({ address: calibur, chainId: p.chainId, nonce: p.nonce + 1 });
  return account.signTransaction({
    type: "eip7702",
    ...common,
    to: p.from,
    value: 0n,
    data,
    authorizationList: [authorization],
  });
}
