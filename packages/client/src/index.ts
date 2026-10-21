import { announceEip6963, reverseHost } from "./eip6963.js";
import { createEip1193Provider, type Eip1193Provider, type NorKeyProviderConfig } from "./provider.js";

export { CALIBUR_ADDRESS } from "./calibur.js";
export type { Eip6963ProviderInfo } from "./eip6963.js";
export { ProviderRpcError } from "./errors.js";
export type { PopupReply, PopupRequest, PreparedCalls, PreparedUserOp } from "./protocol.js";
export type { Eip1193Provider, NorKeyChain, NorKeyProviderConfig } from "./provider.js";

// A neutral wallet glyph, so an app without its own icon shows no letter and no NorKey mark.
const DEFAULT_ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#e5e7eb"/><path d="M8 11h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2zm0 0 0-1a2 2 0 0 1 2-2h11" fill="none" stroke="#374151" stroke-width="2" stroke-linejoin="round"/><circle cx="20" cy="17.5" r="1.5" fill="#374151"/></svg>',
  );

/** Create the NorKey EIP-1193 provider and announce it through EIP-6963 as the app's wallet. */
export function createNorKeyProvider(config: NorKeyProviderConfig): Eip1193Provider {
  const provider = createEip1193Provider(config);
  announceEip6963(provider, {
    uuid: crypto.randomUUID(),
    name: config.name,
    icon: config.icon ?? DEFAULT_ICON,
    rdns: reverseHost(config.vaultOrigin),
  });
  return provider;
}
