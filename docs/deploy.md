# Deploy to your domain

This guide shows how to move a working local setup, such as the one from the
[quick start](quickstart.md), to your own domain. It uses this layout:

| Part | URL |
| --- | --- |
| Your app | `https://app.com` |
| The server | `https://app.com/norkey`, behind your app |
| The boundary page | `https://accounts.app.com`, on its own subdomain |

The relying party ID is `app.com`, the registrable domain that all three share.

## Run the server behind your app

Run the server where your app's domain can reach it at `/norkey`. With `norkey serve`:

```sh
NORKEY_RP_ID=app.com NORKEY_RP_NAME="My App" NORKEY_ORIGINS=https://accounts.app.com \
NORKEY_APP_ORIGINS=https://app.com NORKEY_DB=/data/norkey.db npx --no-install norkey serve
```

- Route `https://app.com/norkey/` to the server's port, `8787` by default (`NORKEY_PORT`), and keep
  the `/norkey` path. The handler answers only under its base path.
- `NORKEY_DB` is the SQLite file. Put it on a disk that survives a restart, and back it up. To use
  Postgres, see [Store data in Postgres](postgres.md).
- `NORKEY_ORIGINS` is the boundary page's origin, and `NORKEY_APP_ORIGINS` is the app's. An origin
  cannot be in both.

You can also mount `createNorKeyHandler` in your app's own server at `/norkey`. See
[Use your app's sign-in](custom-auth.md) for an example, and the
[server reference](reference/server.md) for every option.

Keep the server on the same site as the app. The session cookie is `SameSite=Lax`, so the app's
calls to a cross-site server would not carry it. Off `localhost`, the cookie is also `Secure`, so
serve everything over HTTPS.

## Build the boundary page

Build the page with the production values, and your app's name and logo:

```sh
npx --no-install norkey-vault build --rp-id app.com --api https://app.com/norkey --app-origin https://app.com \
  --chains 11155111 --rp-name "My App" --logo ./logo.svg --out dist-vault
```

- `--api` must be an absolute URL. Its origin is the only one the page's Content Security Policy lets
  it call.
- `--rp-name` sets the name in the page's title, header and connect line. `--logo` adds an image to
  the header: an `.svg`, `.png` or `.webp` file of at most 64 KiB.
- List every chain your app uses in `--chains`.

The settings are baked into the page and covered by the CSP hashes. Rebuild the page after any
change to them. See the [vault CLI reference](reference/vault-cli.md) for every flag.

## Host the boundary page

Serve `dist-vault/index.html` at `https://accounts.app.com/` with the headers the build wrote.

- On Netlify or Cloudflare Pages, deploy the `dist-vault` folder. Both read its `_headers` file.
- On another host, set the response headers from `dist-vault/headers.json` yourself.
- `npx --no-install norkey-vault serve --dir dist-vault` serves the page with those headers, on port `5174`.
  Put it behind a TLS proxy.

Give the boundary page its own subdomain, apart from the app's origin. Same-origin isolation is what
keeps the app page away from the key. The page must use HTTPS, and WebAuthn requires its host to be
`app.com` or a subdomain of it.

Whoever can change the files on this host can serve a tampered page, and the next passkey gesture on
it would leak that user's wallet key. Read
[Security](security.md#the-boundary-page-is-the-crown-jewel) before you choose where it lives.

## Point the app at both

Create the provider with the production URLs:

```ts
createNorKeyProvider({
  name: "My App",
  vaultOrigin: "https://accounts.app.com",
  apiUrl: "/norkey",
  chains: [{ id: 11155111, rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], gas: "native" }],
  defaultChainId: 11155111,
});
```

`apiUrl` may be relative, because it resolves against the app page. `--api` on the boundary page
may not. Both name the same server, at `https://app.com/norkey`.

## Give users the wallet settings page

Link to `https://accounts.app.com` with `rel="noopener"`. Opened with no opener, the boundary page is
the wallet settings page. A boundary page that has an opener waits for an app request instead.

The user signs in with a passkey, then can:

- **Add a passkey**: one more passkey that opens the same wallet. It can be in another passkey
  provider, in another device's provider, or on a hardware security key that supports PRF. The
  browser asks three times: create the new passkey, confirm it, then unlock with a passkey the
  wallet already has. If the user signed in more than 5 minutes ago, a sign-in comes first, so the
  browser asks four times. Then test the new passkey with **Test a passkey**, on each device it will
  be used from.
- **Test a passkey**: the user picks any of their passkeys, and the page checks that it opens the
  wallet. A sign-in does not check this.
- **Export wallet key**: the private key as hex and as a QR code, after three warnings, a checkbox
  and one passkey prompt. Anyone with the key controls the wallet, and it cannot be revoked. The page
  wipes it when the user leaves the screen, clicks **Hide**, or after 60 seconds.

## Check that the values match

| Server | Boundary page | Client |
| --- | --- | --- |
| `NORKEY_RP_ID` `app.com` | `--rp-id app.com` | |
| `NORKEY_ORIGINS` `https://accounts.app.com` | Its own origin | `vaultOrigin` |
| `NORKEY_APP_ORIGINS` `https://app.com` | `--app-origin https://app.com` | The app page's origin |
| `NORKEY_RP_NAME` `My App` (or the handler's `rpName`) | `--rp-name "My App"` | |
| Mounted at `https://app.com/norkey` | `--api https://app.com/norkey` | `apiUrl: "/norkey"` |
| | `--chains` | `chains` |

The page shows the `--rp-name` value, and the server names new passkeys from its own `rpName`. Set both
to the same name.
