import { secp256k1 } from "@noble/curves/secp256k1.js";
import { type Address, bytesToHex, stringToBytes } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { base64UrlToBytes, bytesToArrayBuffer, bytesToBase64Url } from "./encoding.js";

/** The fixed PRF input. Every wrap of every wallet depends on it; changing it orphans all wraps. */
export const PRF_INPUT = stringToBytes("norkey/prf/v1");
const WRAP_INFO = stringToBytes("norkey/wrap/v1");

export type Wrap = {
  id: string;
  kind: "passkey";
  credentialId: string;
  salt: string;
  iv: string;
  ciphertext: string;
};

export class WrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapError";
  }
}

export function generateWalletKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

export function addressOf(key: Uint8Array): Address {
  return publicKeyToAddress(bytesToHex(secp256k1.getPublicKey(key, false)));
}

function associatedData(userId: string, address: Address, wrapId: string): ArrayBuffer {
  return bytesToArrayBuffer(stringToBytes(`${userId}|${address.toLowerCase()}|${wrapId}`));
}

async function deriveKek(prfOutput: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytesToArrayBuffer(salt), info: bytesToArrayBuffer(WRAP_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts `key` and zeroes the caller's `key` buffer before returning. */
export async function wrapKey(args: {
  key: Uint8Array;
  prfOutput: ArrayBuffer;
  credentialId: string;
  userId: string;
  address: Address;
}): Promise<Wrap> {
  let plaintext: ArrayBuffer | undefined;
  try {
    const id = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const kek = await deriveKek(args.prfOutput, salt);
    plaintext = bytesToArrayBuffer(args.key);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(iv), additionalData: associatedData(args.userId, args.address, id) },
      kek,
      plaintext,
    );
    return {
      id,
      kind: "passkey",
      credentialId: args.credentialId,
      salt: bytesToBase64Url(salt),
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(ct)),
    };
  } finally {
    if (plaintext) new Uint8Array(plaintext).fill(0);
    args.key.fill(0);
  }
}

/** Returns the wallet key. The caller owns it and must zero it in a `finally`. */
export async function unwrapKey(args: {
  wrap: Wrap;
  prfOutput: ArrayBuffer;
  userId: string;
  address: Address;
}): Promise<Uint8Array> {
  let key: Uint8Array;
  try {
    const kek = await deriveKek(args.prfOutput, base64UrlToBytes(args.wrap.salt));
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesToArrayBuffer(base64UrlToBytes(args.wrap.iv)),
        additionalData: associatedData(args.userId, args.address, args.wrap.id),
      },
      kek,
      bytesToArrayBuffer(base64UrlToBytes(args.wrap.ciphertext)),
    );
    key = new Uint8Array(pt);
  } catch {
    throw new WrapError("This passkey cannot unlock this wallet.");
  }
  // AES-GCM already binds the address through the associated data. This check is a second,
  // independent guard against signing for a wallet the key does not control.
  if (addressOf(key).toLowerCase() !== args.address.toLowerCase()) {
    key.fill(0);
    throw new WrapError("The unlocked key does not match this wallet's address.");
  }
  return key;
}
