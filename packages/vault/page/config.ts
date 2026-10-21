/** Baked into the page by `norkey-vault build`, before the CSP hashes are taken. */
export type PageConfig = {
  rpId: string;
  rpName: string;
  /** A `data:` URI shown in the header. */
  logo?: string;
  apiUrl: string;
  appOrigins: string[];
  /** The chains this page signs for, each with the only address it will delegate to. */
  chains: { id: number; calibur: `0x${string}` }[];
};

export function readConfig(): PageConfig {
  const c = (window as unknown as { __NORKEY_CONFIG__?: PageConfig }).__NORKEY_CONFIG__;
  if (!c) throw new Error("This page was not built with norkey-vault.");
  return c;
}
