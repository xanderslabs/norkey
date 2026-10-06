/**
 * The boundary page's CSP. Hashes, not a nonce: a static file cannot mint a fresh nonce per
 * response, and once the config is baked the script bytes are fixed, so their sha256 is stable.
 * `connect-src` is exactly the NorKey API origin. The page fetches nothing else; every other
 * directive is 'none'.
 */
export function buildCsp(hashes: string[], apiUrl: string): string {
  if (hashes.length === 0) throw new Error("buildCsp: no script hashes; hash the final bytes after baking config");
  const pinned = hashes.map((h) => `'sha256-${h}'`).join(" ");
  return [
    "default-src 'none'",
    `script-src ${pinned}`,
    `style-src ${pinned}`,
    `connect-src ${new URL(apiUrl).origin}`,
    "img-src data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'allow-duplicates'",
  ].join("; ");
}

/**
 * Headers beyond CSP. Cross-Origin-Opener-Policy is deliberately unsafe-none: any stricter value
 * severs window.opener, and the popup returns its result through that relationship.
 */
export function securityHeaders(csp: string, https: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": csp,
    "Cross-Origin-Opener-Policy": "unsafe-none",
    "Origin-Agent-Cluster": "?1",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(https ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" } : {}),
  };
}

/** The Netlify / Cloudflare Pages `_headers` format. */
export function headersFileContent(headers: Record<string, string>): string {
  return `/*\n${Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n")}\n`;
}
