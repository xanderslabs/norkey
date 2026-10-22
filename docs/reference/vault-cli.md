# norkey-vault reference

`norkey-vault` is the binary of `@norkey/vault`. It builds the boundary page, the only page that
decrypts a wallet key, and serves a built page for local development and minimal hosting.

```text
norkey-vault build --rp-id <id> --api <url> --app-origin <origin>[,<origin>] --chains <id>[,<id>]
                   [--calibur <id>=<address>]... [--rp-name <name>] [--logo <file>] [--out dist-vault]
norkey-vault serve [--dir dist-vault] [--port 5174]
```

Any other command prints this usage and exits with code 1. Every error prints its message and exits
with code 1. The package declares Node 24 or later in `engines`.

## build

```sh
npx --no-install norkey-vault build --rp-id app.com --api https://app.com/norkey \
  --app-origin https://app.com --chains 11155111
```

Bundles the page, inlines every script and stylesheet, bakes the configuration into the page, and
hashes the final bytes into the Content Security Policy.

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--rp-id <id>` | Yes | | The WebAuthn relying party ID. Use the server's `rpId`. |
| `--api <url>` | Yes | | The server handler's base, as an absolute URL, for example `https://app.com/norkey`. Its origin becomes the CSP `connect-src`. |
| `--app-origin <origin>[,<origin>]` | Yes | | The app page origins, comma-separated. Each must be a bare origin. The page accepts requests only from these origins. |
| `--chains <id>[,<id>]` | Yes | | The chain ids the page signs for, comma-separated. Each must be a positive integer. |
| `--calibur <id>=<address>` | No | `0x000000005c84F8Fd50b21CAC312528A64437030e` | The delegate address for one chain in `--chains`. Repeat the flag for more chains. The page delegates only to this address. |
| `--rp-name <name>` | No | The `--rp-id` value | The app's name. The page shows it in its title (`<rp-name> wallet`), in a header above every screen, and in the connect line ("`<origin>` wants to connect your `<rp-name>` wallet."). |
| `--logo <file>` | No | None | An image shown in the page header. Accepted extensions: `.svg`, `.png`, `.webp`. At most 64 KiB. The file is read at build time and inlined as a `data:` URI. Another type, a larger file or a file that cannot be read stops the build before anything is written. |
| `--out <dir>` | No | `dist-vault` | The output folder. Its contents are replaced. |

### Output

| File | Contents |
| --- | --- |
| `index.html` | The page, with every script, stylesheet and setting inline. |
| `_headers` | The response headers, in the `_headers` format of Netlify and Cloudflare Pages. |
| `headers.json` | The same headers as JSON. `norkey-vault serve` reads it. |

The build prints `norkey-vault: wrote <out>/index.html and _headers`, then each chain with its
delegate address, then the CSP. It also writes `headers.json`, which that line does not name.

### Response headers

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'none'`, `script-src` and `style-src` limited to the page's own SHA-256 hashes, `connect-src` the `--api` origin, `img-src data:`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `form-action 'none'`, `require-trusted-types-for 'script'`, `trusted-types 'allow-duplicates'`. |
| `Cross-Origin-Opener-Policy` | `unsafe-none`. A stricter value cuts `window.opener`, and the popup replies through it. |
| `Origin-Agent-Cluster` | `?1` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains`. Only when `--api` uses HTTPS. |

## serve

```sh
npx --no-install norkey-vault serve --port 5174
```

Serves a built page with its headers from `headers.json`, and `cache-control: no-cache`.

| Flag | Default | Description |
| --- | --- | --- |
| `--dir <dir>` | `dist-vault` | The folder `build` wrote. |
| `--port <port>` | `5174` | The listen port. |

Only `/` and `/index.html` are served. Every other path gets `404`.
