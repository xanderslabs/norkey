import type { Eip1193Provider } from "./provider.js";

/** EIP-6963 provider metadata a wallet advertises for discovery. */
export type Eip6963ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };

/** Announce the provider once and on every `eip6963:requestProvider`. Returns a cleanup. */
export function announceEip6963(provider: Eip1193Provider, info: Eip6963ProviderInfo): () => void {
  if (typeof window === "undefined") return () => {};
  // EIP-6963 requires the event detail to be frozen.
  const detail = Object.freeze({ info: Object.freeze({ ...info }), provider });
  const announce = (): void => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  };
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  return () => window.removeEventListener("eip6963:requestProvider", announce);
}
