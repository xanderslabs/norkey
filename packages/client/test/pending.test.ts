// Why: two sponsored sends in quick succession read the same EntryPoint nonce, and the bundler refuses
// the second only after the user approved it with their passkey. The provider must refuse it before
// the popup opens, so no passkey prompt is wasted, and must accept sends again once the first lands.
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEip1193Provider } from "../src/provider.js";
import { prepareUserOp, submitUserOp, waitForUserOpTransaction } from "../src/userop.js";

vi.mock("../src/userop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/userop.js")>()),
  prepareUserOp: vi.fn(),
  submitUserOp: vi.fn(),
  waitForUserOpTransaction: vi.fn(),
}));

const VAULT = "http://localhost:5174";
const WALLET = "0x00000000000000000000000000000000000a11ce";
const OP_HASH: Hex = `0x${"ab".repeat(32)}`;
const TX_HASH: Hex = `0x${"cd".repeat(32)}`;

/** A popup that answers "ready" and then approves whatever it is sent, as the boundary page would. */
function fakeWindow() {
  const listeners = new Set<(e: unknown) => void>();
  const deliver = (data: unknown) => {
    for (const l of [...listeners]) l({ source: popup, origin: VAULT, data });
  };
  const popup = {
    closed: false,
    close: () => {},
    postMessage: (req: { id: string }) =>
      queueMicrotask(() =>
        deliver({ v: 3, id: req.id, ok: true, kind: "sign-userop", signature: "0x01", authorization: null }),
      ),
  };
  return {
    open: vi.fn(() => popup),
    addEventListener: (_type: string, l: (e: unknown) => void) => {
      listeners.add(l);
      queueMicrotask(() => deliver({ v: 3, kind: "ready" }));
    },
    removeEventListener: (_type: string, l: (e: unknown) => void) => listeners.delete(l),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("one sponsored operation at a time", () => {
  it("refuses a second sponsored send while the first is pending, before any popup opens", async () => {
    const win = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("localStorage", { getItem: () => WALLET, setItem: () => {}, removeItem: () => {} });
    vi.mocked(prepareUserOp).mockResolvedValue({} as never);
    vi.mocked(submitUserOp).mockResolvedValue(OP_HASH);
    let land: (hash: Hex) => void = () => {};
    vi.mocked(waitForUserOpTransaction).mockImplementation(
      () =>
        new Promise<Hex>((resolve) => {
          land = resolve;
        }),
    );
    const provider = createEip1193Provider({
      vaultOrigin: VAULT,
      apiUrl: "http://localhost:8787/norkey",
      chains: [
        {
          id: 11155111,
          rpcUrls: ["http://127.0.0.1:8545"],
          gas: "sponsored",
          paymasterUrl: "http://localhost:8787/norkey/paymaster/11155111",
        },
      ],
      defaultChainId: 11155111,
    });
    const send = () =>
      provider.request({
        method: "wallet_sendCalls",
        params: [{ from: WALLET, calls: [{ to: "0x000000000000000000000000000000000000bEEF", value: "0x0" }] }],
      });

    expect(await send()).toEqual({ id: `0xaa36a7:op:${OP_HASH}` });
    expect(win.open).toHaveBeenCalledTimes(1);

    await expect(send()).rejects.toMatchObject({
      code: -32603,
      message: "Your last transaction on this chain is still pending. Try again when it lands.",
    });
    expect(win.open).toHaveBeenCalledTimes(1);

    // Once the operation lands, the next send opens the popup again.
    land(TX_HASH);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await send()).toEqual({ id: `0xaa36a7:op:${OP_HASH}` });
    expect(win.open).toHaveBeenCalledTimes(2);
  });
});
