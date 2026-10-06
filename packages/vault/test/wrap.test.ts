// Why: the wrap is the only thing standing between a leaked database and users' funds, and the
// address check is what stops a user's other passkey (or a swapped row) from signing for the wrong
// wallet. If any of these pass when they should fail, a DB leak or row swap becomes a theft.
import { describe, expect, it } from "vitest";
import { addressOf, generateWalletKey, unwrapKey, WrapError, wrapKey } from "../page/wrap.js";

const prf = () => crypto.getRandomValues(new Uint8Array(32)).buffer;
const userId = "user-1";

async function fresh() {
  const key = generateWalletKey();
  const prfOutput = prf();
  const address = addressOf(key);
  const wrap = await wrapKey({ key: key.slice(), prfOutput, credentialId: "cred-1", userId, address });
  return { key, prfOutput, address, wrap };
}

describe("wrap", () => {
  it("round-trips the key", async () => {
    const { key, prfOutput, address, wrap } = await fresh();
    const out = await unwrapKey({ wrap, prfOutput, userId, address });
    expect(out).toEqual(key);
  });

  it("stores no plaintext key bytes", async () => {
    const { key, wrap } = await fresh();
    expect(JSON.stringify(wrap)).not.toContain(Buffer.from(key).toString("base64url"));
  });

  it("rejects a different PRF output", async () => {
    const { address, wrap } = await fresh();
    await expect(unwrapKey({ wrap, prfOutput: prf(), userId, address })).rejects.toBeInstanceOf(WrapError);
  });

  it("rejects a tampered ciphertext", async () => {
    const { prfOutput, address, wrap } = await fresh();
    const bytes = Buffer.from(wrap.ciphertext, "base64url");
    bytes[0] ^= 1;
    const tampered = { ...wrap, ciphertext: bytes.toString("base64url") };
    await expect(unwrapKey({ wrap: tampered, prfOutput, userId, address })).rejects.toBeInstanceOf(WrapError);
  });

  it("rejects the wrap under another user id (associated data)", async () => {
    const { prfOutput, address, wrap } = await fresh();
    await expect(unwrapKey({ wrap, prfOutput, userId: "user-2", address })).rejects.toBeInstanceOf(WrapError);
  });

  it("rejects when the expected address is not the key's address", async () => {
    const { prfOutput, wrap } = await fresh();
    const other = addressOf(generateWalletKey());
    await expect(unwrapKey({ wrap, prfOutput, userId, address: other })).rejects.toBeInstanceOf(WrapError);
  });

  it("uses a fresh salt and iv per wrap", async () => {
    const a = await fresh();
    const b = await fresh();
    expect(a.wrap.salt).not.toBe(b.wrap.salt);
    expect(a.wrap.iv).not.toBe(b.wrap.iv);
  });
});
