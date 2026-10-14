// Why: a sponsored send is signed as a raw hash, the most dangerous thing a key can sign, because
// the signer cannot see what the hash means. The page must compute that hash itself from the fields
// it showed, on the EntryPoint Calibur trusts, and delegate only to its own Calibur. It must refuse
// an operation with no paymaster (the consent screen would say the user pays nothing), and calls the
// root key could use to reach Calibur's admin functions or the account's EntryPoint deposit.
import { CALIBUR_ADDRESS, ENTRY_POINT, userOperationFrom } from "@norkey/client/calibur";
import type { PreparedCalls, PreparedUserOp } from "@norkey/client/protocol";
import { decodeAbiParameters, parseAbiParameters, recoverAddress, slice } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { recoverAuthorizationAddress } from "viem/utils";
import { describe, expect, it } from "vitest";
import { RequestError, signUserOp, validateCalls, validateUserOp } from "../page/calls.js";
import { addressOf, generateWalletKey } from "../page/wrap.js";

const SEPOLIA = 11155111;
const chains = [{ id: SEPOLIA, calibur: CALIBUR_ADDRESS }];
const A = "0x000000000000000000000000000000000000bEEF";
const B = "0x000000000000000000000000000000000000cafE";
const PAYMASTER = "0x00000000000000000000000000000000000f00d5";
const lower = (s: string) => s.toLowerCase();

function op(sender: `0x${string}`, overrides: Partial<PreparedUserOp> = {}): PreparedUserOp {
  return {
    chainId: SEPOLIA,
    sender,
    calls: [
      { to: A, value: "0x5af3107a4000", data: "0x" },
      { to: B, value: "0x0", data: "0x12345678" },
    ],
    nonce: "0x5",
    callGasLimit: "0x3c05",
    verificationGasLimit: "0x2bd7b",
    preVerificationGas: "0xbb04",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x11170",
    paymasterPostOpGasLimit: "0x124f8",
    paymasterData: "0x0200aa",
    authorizationNonce: 3,
    ...overrides,
  };
}

function wallet() {
  const key = generateWalletKey();
  return { key, from: addressOf(key) };
}

describe("signing a sponsored user operation", () => {
  it("signs the v0.8 userOpHash raw with the root key, delegating only to the page's Calibur", async () => {
    const { key, from } = wallet();
    const p = validateUserOp(op(from), chains);
    const { signature, authorization } = await signUserOp(key, p, CALIBUR_ADDRESS);
    if (!authorization) throw new Error("no authorization");
    expect(lower(authorization.address)).toBe(lower(CALIBUR_ADDRESS));
    expect(authorization.chainId).toBe(SEPOLIA);
    expect(authorization.nonce).toBe(3);
    expect(lower(await recoverAuthorizationAddress({ authorization }))).toBe(lower(from));

    const userOperation = userOperationFrom(p, authorization);
    expect(userOperation.nonce).toBe(5n);
    expect(lower(userOperation.paymaster ?? "")).toBe(lower(PAYMASTER));
    expect(userOperation.paymasterData).toBe("0x0200aa");
    const hash = getUserOperationHash({
      chainId: SEPOLIA,
      entryPointAddress: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      entryPointVersion: "0.8",
      userOperation,
    });
    expect(signature).toHaveLength(132);
    expect(lower(await recoverAddress({ hash, signature }))).toBe(lower(from));

    expect(slice(userOperation.callData, 0, 4)).toBe("0x8dd7712f");
    const [batch] = decodeAbiParameters(
      parseAbiParameters("((address to, uint256 value, bytes data)[] calls, bool revertOnFailure)"),
      slice(userOperation.callData, 4),
    );
    expect(batch.revertOnFailure).toBe(true);
    expect(batch.calls.map((c) => lower(c.to))).toEqual([lower(A), lower(B)]);
    expect(batch.calls[1].data).toBe("0x12345678");
  });

  it("signs no authorization when authorizationNonce is null", async () => {
    const { key, from } = wallet();
    const { authorization } = await signUserOp(
      key,
      validateUserOp(op(from, { authorizationNonce: null }), chains),
      CALIBUR_ADDRESS,
    );
    expect(authorization).toBeNull();
  });

  it("ignores a delegate address or EntryPoint the app adds", async () => {
    const { key, from } = wallet();
    const evil = {
      ...op(from),
      calibur: "0x00000000000000000000000000000000000BAD00",
      entryPoint: "0x00000000000000000000000000000000000BAD01",
    };
    const p = validateUserOp(evil, chains);
    const { signature, authorization } = await signUserOp(key, p, CALIBUR_ADDRESS);
    expect(lower(authorization?.address ?? "")).toBe(lower(CALIBUR_ADDRESS));
    const hash = getUserOperationHash({
      chainId: SEPOLIA,
      entryPointAddress: ENTRY_POINT,
      entryPointVersion: "0.8",
      userOperation: userOperationFrom(p, authorization ?? undefined),
    });
    expect(lower(await recoverAddress({ hash, signature }))).toBe(lower(from));
  });

  it("refuses no paymaster, the EntryPoint as a target, a self-call, and an unknown chain", () => {
    const { from } = wallet();
    const zero = "0x0000000000000000000000000000000000000000";
    expect(() => validateUserOp(op(from, { paymaster: zero }), chains)).toThrow(RequestError);
    const { paymaster: _, ...noPaymaster } = op(from);
    expect(() => validateUserOp(noPaymaster, chains)).toThrow(RequestError);
    for (const to of [ENTRY_POINT, lower(ENTRY_POINT), from, zero] as `0x${string}`[]) {
      expect(() => validateUserOp(op(from, { calls: [{ to, value: "0x0", data: "0x" }] }), chains)).toThrow(
        RequestError,
      );
    }
    expect(() => validateUserOp(op(from, { chainId: 1 }), chains)).toThrow(RequestError);
    expect(() => validateUserOp(op(from, { authorizationNonce: -1 }), chains)).toThrow(RequestError);
  });

  it("refuses a call to the EntryPoint on the native path too", () => {
    const { from } = wallet();
    const native: PreparedCalls = {
      chainId: SEPOLIA,
      from,
      calls: [{ to: ENTRY_POINT, value: "0x0", data: "0x" }],
      nonce: 0,
      gas: "0x5208",
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x1",
      delegate: false,
    };
    expect(() => validateCalls(native, chains)).toThrow(RequestError);
  });
});
