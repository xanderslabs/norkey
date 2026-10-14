// Why: eth_sendTransaction waits for the bundle after the operation is sent. If one failed status
// check ended that wait, the app would see a payment as failed after it landed, and a retry would
// pay twice. Only the deadline may end the wait.
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForUserOpTransaction } from "../src/userop.js";

const PROXY = "http://localhost:8787/norkey/paymaster/11155111";
const OP_HASH = `0x${"ab".repeat(32)}` as const;
const TX_HASH = `0x${"cd".repeat(32)}`;
const receipt = {
  success: true,
  receipt: {
    logs: [],
    status: "0x1",
    blockHash: TX_HASH,
    blockNumber: "0x1",
    gasUsed: "0x1",
    transactionHash: TX_HASH,
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("waitForUserOpTransaction", () => {
  it("keeps polling through a failed status check and returns the bundle transaction hash", async () => {
    vi.useFakeTimers();
    const replies = [
      () => Response.json({ jsonrpc: "2.0", id: 1, result: null }),
      () => new Response("upstream down", { status: 502 }),
      () => Response.json({ jsonrpc: "2.0", id: 1, result: receipt }),
    ];
    const fetchStub = vi.fn(async () => (replies.shift() ?? replies[0])());
    vi.stubGlobal("fetch", fetchStub);
    const done = waitForUserOpTransaction(PROXY, OP_HASH, 11155111);
    const settled = done.then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toEqual({ v: TX_HASH });
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });
});
