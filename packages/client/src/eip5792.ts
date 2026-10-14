import { type Hex, numberToHex, type PublicClient, TransactionReceiptNotFoundError } from "viem";

/** A bundle id is the chain and the transaction hash, so status needs no stored state. */
export const callsId = (chainId: number, hash: Hex): string => `${numberToHex(chainId)}:${hash}`;

export function parseCallsId(id: unknown): { chainId: number; hash: Hex } | null {
  if (typeof id !== "string") return null;
  const m = /^(0x[0-9a-f]+):(0x[0-9a-fA-F]{64})$/.exec(id);
  return m ? { chainId: Number(m[1]), hash: m[2] as Hex } : null;
}

/**
 * EIP-5792 2.0.0 status: 100 pending, 200 confirmed, 500 reverted on chain. Batches are atomic.
 * 100 means "no receipt yet": a dropped transaction, or a well-formed id that was never sent, stays at
 * 100. A transaction just sent can be missing from a load-balanced RPC for a moment, so this does not
 * answer 5730 for it. Stop polling after a timeout, as viem's `waitForCallsStatus` does.
 */
export async function callsStatus(client: PublicClient, id: string, chainId: number, hash: Hex) {
  const receipt = await client.getTransactionReceipt({ hash }).catch((e: unknown) => {
    if (e instanceof TransactionReceiptNotFoundError) return null;
    throw e;
  });
  const base = { version: "2.0.0", id, chainId: numberToHex(chainId), atomic: true };
  if (!receipt) return { ...base, status: 100 };
  const ok = receipt.status === "success";
  return {
    ...base,
    status: ok ? 200 : 500,
    receipts: [
      {
        logs: receipt.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })),
        status: ok ? "0x1" : "0x0",
        blockHash: receipt.blockHash,
        blockNumber: numberToHex(receipt.blockNumber),
        gasUsed: numberToHex(receipt.gasUsed),
        transactionHash: receipt.transactionHash,
      },
    ],
  };
}
