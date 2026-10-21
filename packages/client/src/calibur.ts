import {
  type Address,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  parseAbi,
  parseAbiParameters,
  type SignedAuthorization,
} from "viem";
import { entryPoint08Address, type UserOperation } from "viem/account-abstraction";
import type { PreparedUserOp } from "./protocol.js";

/** Uniswap's Calibur, the same runtime code on the eight chains checked: Ethereum, Base, Optimism,
 *  Arbitrum One, BNB Chain, Unichain, Sepolia and Unichain Sepolia (the keccak of `cast code`
 *  matched on each one on 2026-10-06). The vault CLI repeats this default. */
export const CALIBUR_ADDRESS: Address = "0x000000005c84F8Fd50b21CAC312528A64437030e";

/** Calibur's ERC-7821 mode BATCHED_CALL: every call must succeed or the whole batch reverts. */
export const BATCHED_CALL_MODE: Hex = `0x01${"00".repeat(31)}`;

export const executeAbi = parseAbi(["function execute(bytes32 mode, bytes executionData) payable"]);
const CALLS = parseAbiParameters("(address to, uint256 value, bytes data)[]");

export type Call = { to: Address; value: bigint; data: Hex };

/** The calldata for a self-call that runs `calls` as one atomic batch through Calibur. */
export function encodeExecute(calls: readonly Call[]): Hex {
  const executionData = encodeAbiParameters(CALLS, [calls.map((c) => ({ to: c.to, value: c.value, data: c.data }))]);
  return encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [BATCHED_CALL_MODE, executionData] });
}

/** True when `code` is the EIP-7702 designator for `calibur`. A designator for any other address is false. */
export function isDelegatedTo(code: Hex | undefined, calibur: Address): boolean {
  return (code ?? "0x").toLowerCase() === `0xef0100${calibur.slice(2)}`.toLowerCase();
}

/** EntryPoint v0.8: Calibur trusts it unless the account calls updateEntryPoint, a self-call the
 *  boundary page refuses. */
export const ENTRY_POINT: Address = entryPoint08Address;

/** Calibur's executeUserOp(PackedUserOperation,bytes32). The EntryPoint calls it, and Calibur decodes
 *  BatchedCall from the callData after this selector. */
const EXECUTE_USER_OP: Hex = "0x8dd7712f";
const BATCHED_CALL = parseAbiParameters("((address to, uint256 value, bytes data)[] calls, bool revertOnFailure)");

/** callData for a user operation. revertOnFailure is true, so the batch is atomic, as BATCHED_CALL
 *  mode is for a self-call. Not execute(mode, ...): Calibur checks msg.sender there, so the EntryPoint
 *  cannot call it. */
export function encodeExecuteUserOp(calls: readonly Call[]): Hex {
  const batch = { calls: calls.map((c) => ({ to: c.to, value: c.value, data: c.data })), revertOnFailure: true };
  return concat([EXECUTE_USER_OP, encodeAbiParameters(BATCHED_CALL, [batch])]);
}

/**
 * The user operation a PreparedUserOp describes. The boundary page hashes this and the provider
 * submits it, so neither can drift from the other. The authorization rides as eip7702Auth, with no
 * factory field: Pimlico's mock paymaster refuses the 0x7702 factory marker, and every bundler tried
 * accepts the operation without it. The caller sets `signature`.
 */
export function userOperationFrom(p: PreparedUserOp, authorization?: SignedAuthorization): UserOperation<"0.8"> {
  return {
    sender: p.sender,
    nonce: BigInt(p.nonce),
    callData: encodeExecuteUserOp(p.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }))),
    callGasLimit: BigInt(p.callGasLimit),
    verificationGasLimit: BigInt(p.verificationGasLimit),
    preVerificationGas: BigInt(p.preVerificationGas),
    maxFeePerGas: BigInt(p.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
    paymaster: p.paymaster,
    paymasterVerificationGasLimit: BigInt(p.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(p.paymasterPostOpGasLimit),
    paymasterData: p.paymasterData,
    signature: "0x",
    ...(authorization ? { authorization } : {}),
  };
}
