// Why: a user whose create failed after registering a passkey has no wallet, and "Use my passkey"
// finishes setup by wrapping a new K under that gesture's PRF output. That wrap is the wallet's only
// one. A passkey used from another device over the QR code may return a PRF value that differs from
// the one it gives on its own device (spec fact 1), so a wallet finished that way could be one that
// no gesture on the user's own device ever opens again. Funds sent to it would be lost.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../page/api.js";
import { connectExisting } from "../page/flows.js";

function orphanApi() {
  return {
    loginOptions: vi.fn(async () => ({ challengeId: "c1", options: { challenge: "AAAA", rpId: "localhost" } })),
    loginVerify: vi.fn(async () => ({ userId: "user-1", wallet: null, wrap: null })),
    createWallet: vi.fn(async (address: string) => ({ address })),
  };
}

function assertion(attachment: "platform" | "cross-platform") {
  const bytes = () => new Uint8Array([1, 2, 3]).buffer;
  return {
    id: "cred-1",
    rawId: bytes(),
    authenticatorAttachment: attachment,
    response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes(), userHandle: null },
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(7).buffer } } }),
  };
}

describe("finishing a wallet for a user who has none", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes the wallet's only wrap only from a passkey on this device", async () => {
    const remote = orphanApi();
    vi.stubGlobal("navigator", { credentials: { get: async () => assertion("cross-platform") } });
    await expect(connectExisting(remote as unknown as Api)).rejects.toThrow(
      "This wallet's passkey is not on this device. Use a passkey saved on this device.",
    );
    expect(remote.createWallet).not.toHaveBeenCalled();

    const local = orphanApi();
    vi.stubGlobal("navigator", { credentials: { get: async () => assertion("platform") } });
    const { address } = await connectExisting(local as unknown as Api);
    expect(local.createWallet).toHaveBeenCalledOnce();
    expect(local.createWallet.mock.calls[0]?.[0]).toBe(address);
  });
});
