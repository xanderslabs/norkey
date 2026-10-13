// Why: a 7702 authorization is the most powerful thing this wallet signs. It hands the account's
// code to a contract. If the delegate address could come from the app, XSS on the app page could get
// a user to delegate to a drainer with one tap. If the authorization nonce is off by one, the first
// send burns its fee and leaves the account undelegated. And the batch that is signed must be exactly
// the batch the consent screen showed.
import { BATCHED_CALL_MODE, CALIBUR_ADDRESS, executeAbi, isDelegatedTo } from "@norkey/client/calibur";
import type { PreparedCalls } from "@norkey/client/protocol";
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { describe, expect, it } from "vitest";
import { RequestError, signPreparedCalls, validateCalls } from "../page/calls.js";
import { addressOf, generateWalletKey } from "../page/wrap.js";

const SEPOLIA = 11155111;
const chains = [{ id: SEPOLIA, calibur: CALIBUR_ADDRESS }];
const A = "0x000000000000000000000000000000000000bEEF";
const B = "0x000000000000000000000000000000000000cafE";
const lower = (s: string) => s.toLowerCase();

function request(from: `0x${string}`, overrides: Partial<PreparedCalls> = {}): PreparedCalls {
  return {
    chainId: SEPOLIA,
    from,
    calls: [
      { to: A, value: "0x5af3107a4000", data: "0x" },
      { to: B, value: "0x5af3107a4000", data: "0x" },
    ],
    nonce: 7,
    gas: "0xf4240",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    delegate: true,
    ...overrides,
  };
}

function wallet() {
  const key = generateWalletKey();
  return { key, from: addressOf(key) };
}

describe("signing calls", () => {
  it("signs a type-4 self-call with one authorization to the configured Calibur at nonce + 1", async () => {
    const { key, from } = wallet();
    const raw = await signPreparedCalls(key, validateCalls(request(from), chains), CALIBUR_ADDRESS);
    const tx = parseTransaction(raw);
    expect(tx.type).toBe("eip7702");
    expect(lower(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }))).toBe(
      lower(from),
    );
    expect(lower(tx.to ?? "")).toBe(lower(from));
    expect(tx.nonce).toBe(7);
    expect(tx.authorizationList).toHaveLength(1);
    const auth = tx.authorizationList?.[0];
    if (!auth) throw new Error("no authorization");
    expect(lower(auth.address)).toBe(lower(CALIBUR_ADDRESS));
    expect(auth.chainId).toBe(SEPOLIA);
    expect(auth.nonce).toBe(8);
    expect(lower(await recoverAuthorizationAddress({ authorization: auth }))).toBe(lower(from));
    const { args } = decodeFunctionData({ abi: executeAbi, data: tx.data ?? "0x" });
    expect(args[0]).toBe(BATCHED_CALL_MODE);
    const [calls] = decodeAbiParameters(parseAbiParameters("(address to, uint256 value, bytes data)[]"), args[1]);
    expect(calls.map((c) => lower(c.to))).toEqual([lower(A), lower(B)]);
  });

  it("signs no authorization once the account is delegated", async () => {
    const { key, from } = wallet();
    const raw = await signPreparedCalls(
      key,
      validateCalls(request(from, { delegate: false }), chains),
      CALIBUR_ADDRESS,
    );
    const tx = parseTransaction(raw);
    expect(tx.type).toBe("eip1559");
    expect(tx.authorizationList).toBeUndefined();
    expect(lower(tx.to ?? "")).toBe(lower(from));
  });

  it("ignores a delegate address the app adds to the request", async () => {
    const { key, from } = wallet();
    const evil = { ...request(from), calibur: "0x00000000000000000000000000000000000BAD00" };
    const tx = parseTransaction(await signPreparedCalls(key, validateCalls(evil, chains), CALIBUR_ADDRESS));
    expect(lower(tx.authorizationList?.[0]?.address ?? "")).toBe(lower(CALIBUR_ADDRESS));
  });

  it("refuses a chain the page was not built for, and a malformed call", () => {
    const { from } = wallet();
    expect(() => validateCalls(request(from, { chainId: 1 }), chains)).toThrow(RequestError);
    const bad = request(from, { calls: [{ to: "0x1234" as `0x${string}`, value: "0x0", data: "0x" }] });
    expect(() => validateCalls(bad, chains)).toThrow(RequestError);
    expect(() => validateCalls(request(from, { calls: [] }), chains)).toThrow(RequestError);
  });

  it("treats a designator for any other contract as not delegated", () => {
    const other = "0x00000000000000000000000000000000000BAD00";
    expect(isDelegatedTo(`0xef0100${CALIBUR_ADDRESS.slice(2).toLowerCase()}`, CALIBUR_ADDRESS)).toBe(true);
    expect(isDelegatedTo(`0xef0100${other.slice(2)}`, CALIBUR_ADDRESS)).toBe(false);
    expect(isDelegatedTo(undefined, CALIBUR_ADDRESS)).toBe(false);
  });
});
