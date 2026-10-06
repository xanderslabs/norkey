export function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Decode a base64url string back to bytes. */
export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  if (typeof atob === "function") return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

/** Materialise a Uint8Array's underlying buffer as a standalone ArrayBuffer sized to the view. */
export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
