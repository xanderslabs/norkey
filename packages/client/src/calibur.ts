import { type Address, encodeAbiParameters, encodeFunctionData, type Hex, parseAbi, parseAbiParameters } from "viem";

/** Uniswap's Calibur, the same runtime code on every chain NorKey supports
 *  (NorKey-internal/probes/calibur-addresses.md). The vault CLI repeats this default. */
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
