/** Baked into the page by `norkey-vault build`, before the CSP hashes are taken. */
export type PageConfig = {
  rpId: string;
  rpName: string;
  apiUrl: string;
  appOrigins: string[];
};

export function readConfig(): PageConfig {
  const c = (window as unknown as { __NORKEY_CONFIG__?: PageConfig }).__NORKEY_CONFIG__;
  if (!c) throw new Error("This page was not built with norkey-vault.");
  return c;
}
