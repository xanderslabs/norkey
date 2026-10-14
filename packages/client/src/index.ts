import { announceEip6963 } from "./eip6963.js";
import { createEip1193Provider, type Eip1193Provider, type NorKeyProviderConfig } from "./provider.js";

export { CALIBUR_ADDRESS } from "./calibur.js";
export type { Eip6963ProviderInfo } from "./eip6963.js";
export { ProviderRpcError } from "./errors.js";
export type { PopupReply, PopupRequest, PreparedCalls, PreparedUserOp } from "./protocol.js";
export type { Eip1193Provider, NorKeyChain, NorKeyProviderConfig } from "./provider.js";

// Placeholder rdns until the product domain is decided (spec section 13).
const ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111"/><text x="16" y="22" font-size="16" font-family="sans-serif" fill="#fff" text-anchor="middle">N</text></svg>',
  );

/** Create the NorKey EIP-1193 provider and announce it through EIP-6963. */
export function createNorKeyProvider(config: NorKeyProviderConfig): Eip1193Provider {
  const provider = createEip1193Provider(config);
  announceEip6963(provider, { uuid: crypto.randomUUID(), name: "NorKey", icon: ICON, rdns: "dev.norkey" });
  return provider;
}
