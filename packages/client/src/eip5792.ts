import { type Hex, numberToHex, type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { getUserOpReceipt } from "./userop.js";

/** A bundle id is the chain and the transaction hash, or for a user operation "op:" and its hash, so
 *  status needs no stored state. */
export const callsId = (chainId: number, hash: Hex, op = false): string =>
  `${numberToHex(chainId)}:${op ? "op:" : ""}${hash}`;

export function parseCallsId(id: unknown): { chainId: number; hash: Hex; op: boolean } | null {
  if (typeof id !== "string") return null;
  const m = /^(0x[0-9a-f]+):(op:)?(0x[0-9a-fA-F]{64})$/.exec(id);
  return m ? { chainId: Number(m[1]), hash: m[3] as Hex, op: m[2] !== undefined } : null;
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

/** EIP-5792 status for a user operation, through the paymaster proxy. 200 or 500 comes from the
 *  operation's own result: a bundle can succeed while the operation inside it reverts. */
export async function userOpCallsStatus(proxyUrl: string, id: string, chainId: number, hash: Hex) {
  const r = await getUserOpReceipt(proxyUrl, hash);
  const base = { version: "2.0.0", id, chainId: numberToHex(chainId), atomic: true };
  if (!r) return { ...base, status: 100 };
  return {
    ...base,
    status: r.success ? 200 : 500,
    receipts: [
      {
        logs: (r.receipt.logs ?? []).map((l) => ({ address: l.address, data: l.data, topics: l.topics })),
        status: r.receipt.status,
        blockHash: r.receipt.blockHash,
        blockNumber: r.receipt.blockNumber,
        gasUsed: r.receipt.gasUsed,
        transactionHash: r.receipt.transactionHash,
      },
    ],
  };
}
