import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  type Address,
  bytesToHex,
  type Hex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  serializeSignature,
  serializeTransaction,
} from "viem";
import { type PrivateKeyAccount, publicKeyToAddress, toAccount } from "viem/accounts";
import { hashAuthorization } from "viem/utils";

/** Sign a 32-byte digest with the secp256k1 private key given as raw BYTES.
 *
 * This reproduces viem's own `sign` primitive (accounts/utils/sign.ts) exactly: deterministic
 * RFC-6979 (`extraEntropy: false`), low-S, `v = recovery ? 28 : 27`, `yParity = recovery`, r/s as
 * 32-byte hex. It takes a `Uint8Array` key so no `Hex` private-key string is ever constructed.
 * `prehash: false` is REQUIRED: @noble/curves v2 sha256-prehashes by default, whereas the digest
 * passed here is already the final hash (keccak256 / EIP-191 / EIP-712). The signature is public;
 * only the key is secret, and the key is bytes the caller wipes. */
function signDigest(hash: Hex, keyBytes: Uint8Array): { r: Hex; s: Hex; v: bigint; yParity: number } {
  const recovered = secp256k1.sign(hexToBytes(hash), keyBytes, {
    lowS: true,
    extraEntropy: false,
    prehash: false,
    format: "recovered",
  });
  const sig = secp256k1.Signature.fromBytes(recovered, "recovered");
  // `format: "recovered"` guarantees a recovery bit; the type widens it to optional, so pin it.
  const yParity = sig.recovery ?? 0;
  return { r: numberToHex(sig.r, { size: 32 }), s: numberToHex(sig.s, { size: 32 }), v: yParity ? 28n : 27n, yParity };
}

/**
 * A viem account whose sign closures read `key` by reference. No Hex private key exists; only the
 * public key and address are strings. Zeroing `key` makes the account inert, which is the intent:
 * the caller wipes the key in a `finally` once signing is done.
 */
export function accountFromKey(key: Uint8Array): PrivateKeyAccount {
  const publicKey = bytesToHex(secp256k1.getPublicKey(key, false));
  const address: Address = publicKeyToAddress(publicKey);
  const account = toAccount({
    address,
    async sign({ hash }) {
      return serializeSignature(signDigest(hash, key));
    },
    async signMessage({ message }) {
      return serializeSignature(signDigest(hashMessage(message), key));
    },
    async signTypedData(typedData) {
      return serializeSignature(signDigest(hashTypedData(typedData as Parameters<typeof hashTypedData>[0]), key));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      // Match viem: for EIP-4844 sign the payload body without sidecars.
      const signable = transaction.type === "eip4844" ? { ...transaction, sidecars: false } : transaction;
      const sig = signDigest(keccak256(await serializer(signable)), key);
      return serializer(transaction, sig);
    },
    async signAuthorization(authorization) {
      const auth = authorization as { address?: Address; contractAddress?: Address; chainId: number; nonce: number };
      const target = (auth.contractAddress ?? auth.address) as Address;
      const sig = signDigest(hashAuthorization({ address: target, chainId: auth.chainId, nonce: auth.nonce }), key);
      return { address: target, chainId: auth.chainId, nonce: auth.nonce, ...sig };
    },
  });
  // Mirror privateKeyToAccount's public shape so the PrivateKeyAccount type holds.
  return { ...account, publicKey, source: "privateKey" } as PrivateKeyAccount;
}
