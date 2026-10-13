import type { PreparedCalls } from "@norkey/client/protocol";
import { decodeFunctionData, erc20Abi, formatEther, type Hex, maxUint256 } from "viem";

export type CallView = { title: string; rows: [string, string][]; raw?: Hex };

const CHAIN_NAMES: Record<number, string> = { 11155111: "Sepolia", 1301: "Unichain Sepolia" };
export const chainName = (id: number): string => CHAIN_NAMES[id] ?? `Chain ${id}`;

/** What one call does, for the consent screen. Token amounts are base units: the page makes no RPC
 *  calls, so it cannot read a token's decimals or symbol. */
export function describeCall(call: PreparedCalls["calls"][number]): CallView {
  const value = BigInt(call.value);
  const eth = `${formatEther(value)} ETH`;
  if (call.data === "0x")
    return {
      title: "Send ETH",
      rows: [
        ["To", call.to],
        ["Amount", eth],
      ],
    };
  const extra: [string, string][] = value > 0n ? [["Also sends", eth]] : [];
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    if (decoded.functionName === "transfer") {
      const [to, amount] = decoded.args;
      return {
        title: "Send tokens",
        rows: [["Token", call.to], ["To", to], ["Amount", `${amount} (base units)`], ...extra],
      };
    }
    if (decoded.functionName === "approve") {
      const [spender, amount] = decoded.args;
      return {
        title: "Allow token spending",
        rows: [
          ["Token", call.to],
          ["Spender", spender],
          ["Amount", amount === maxUint256 ? "Unlimited" : `${amount} (base units)`],
          ...extra,
        ],
      };
    }
  } catch {
    // Not an ERC-20 call: shown raw below.
  }
  return {
    title: "Contract call",
    rows: [
      ["To", call.to],
      ["Amount", eth],
    ],
    raw: call.data,
  };
}
