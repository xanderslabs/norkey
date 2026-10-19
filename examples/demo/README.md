# NorKey demo

A plain Vite page that connects a NorKey wallet on Sepolia and sends ETH through viem.

## Run it

Build the packages once from the repo root:

```sh
pnpm install && pnpm build
```

Then start three processes from the repo root.

1. The server:

   ```sh
   NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 NORKEY_APP_ORIGINS=http://localhost:5173 \
   NORKEY_DB=./demo.db node packages/server/dist/serve.js
   ```

   `NORKEY_APP_ORIGINS` lets the app's **Disconnect** end the server session.

2. The boundary page:

   ```sh
   node packages/vault/dist/bin.js build --rp-id localhost --api http://localhost:8787/norkey --app-origin http://localhost:5173 --chains 11155111,1301
   node packages/vault/dist/bin.js serve --port 5174
   ```

3. The app:

   ```sh
   pnpm --filter demo dev
   ```

Open http://localhost:5173, click **Connect**, then **Create a new wallet**. Fund the address from a Sepolia
faucet, then send a small amount. Set `VITE_SEPOLIA_RPC` to use your own RPC.
Set `VITE_UNICHAIN_SEPOLIA_RPC` to use your own Unichain Sepolia RPC.

The Unichain Sepolia address needs its own test ETH, for example bridged from Sepolia or from a
faucet.

**Disconnect** calls `wallet_revokePermissions`. The provider posts to `<apiUrl>/logout`, which
deletes the server session and expires its cookie, then forgets the address. The next **Connect**
asks for a passkey again. The demo sets `apiUrl` from `VITE_API` (default
`http://localhost:8787/norkey`), the same value the boundary page is built with (`--api`). Keep
`apiUrl` on the same site as the app: the session cookie is `SameSite=Lax`, so a cross-site
`apiUrl` would not carry it.

## Wallet settings

**Wallet settings** opens the boundary page in a new tab. Opened with no opener, the boundary page
is the settings page. The user signs in with a passkey, then can:

- **Add a passkey**: one more passkey that opens the same wallet. It can be in another passkey
  provider, in another device's provider, or on a hardware security key that supports PRF. The
  browser asks three times: create the new passkey, confirm it, then unlock with a passkey the
  wallet already has. If you signed in more than 5 minutes ago, it asks four times: a sign-in
  comes first. Then test the new passkey with **Test a passkey**, on each device you will use it
  from.
- **Test a passkey**: pick any of your passkeys. The page checks that it opens the wallet, which a
  sign-in does not check, and says "This passkey opens your wallet." or why it does not.
- **Export wallet key**: the private key as hex and as a QR code, after three warnings, a checkbox
  and one passkey prompt. Anyone with the key controls the wallet, and it cannot be revoked. The
  page wipes it when you leave the screen, click **Hide**, or after 60 seconds.

A new wallet also gets an offer to add a backup passkey before the popup closes. **Skip** leaves it
for the settings page. A user who loses every passkey and never exported the key loses the wallet.

Link to the settings page with `rel="noopener"`. A boundary page that has an opener waits for an
app request instead.

## Custom auth mode

In custom auth mode, your app's own sign-in decides who the user is. NorKey has no sign-in of its
own: each app user gets at most one NorKey user and one wallet. The user still approves every
wallet operation with a passkey.

`norkey serve` cannot run custom mode, because `getUserId` is code. Mount `createNorKeyHandler`
yourself, as `custom-server.mjs` does:

```js
createNorKeyHandler({
  rpId: "localhost",
  origins: ["http://localhost:5174"],
  appOrigins: ["http://localhost:5173"],
  auth: { mode: "custom", getUserId },
  storage,
});
```

### What `getUserId` reads

`getUserId(req)` receives the request as a `Request` and returns the app's user id, or `null` when
the app user is signed out. It can return a promise. Read your app's own session cookie in it.
NorKey trims the id, and treats anything other than a non-empty string as signed out. The demo's
`getUserId` returns the value of its `demo_user` cookie.

The id you return decides whose wallet the request reaches. NorKey keeps its own random user id and
stores yours in `external_id`. Your id never reaches an authenticator.

When the app user is signed out, the popup says "Sign in to the app first." and the provider
rejects the request with `4100`. Custom mode never falls back to a NorKey sign-in.

### The cookie rule

The boundary page calls the handler from its own origin, so your app's session cookie must reach
the handler from there too. Set the cookie from your app's server with
`Domain=<registrable domain>` and `SameSite=Lax`. For example, an app at `app.com` with the boundary
page at `accounts.app.com` sets `Domain=app.com`. The boundary page and the handler are same-site,
so `SameSite=Lax` is enough. NorKey never sees an app token.

The demo is a stub. The page sets `demo_user` itself, with no `Domain`, because on `localhost` a
cookie is shared across ports.

### Sign-out

Call `wallet_revokePermissions` on the provider when the app user signs out:

```js
await norkey.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
```

It posts to `<apiUrl>/logout`, which deletes the NorKey session, and the provider forgets the
remembered address. Without it, `eth_requestAccounts` returns that address from `localStorage`
without a popup, so the next app user on the device gets the previous user's address. The app
origin must be in `appOrigins` for `/logout` to accept the call. The demo's **Sign out of the app**
button calls it before it clears `demo_user`.

### Choose the mode once per database

Built-in mode stores users with a null `external_id`, and custom mode finds users only by
`external_id`. If you switch a database from built-in mode to custom mode, NorKey can no longer
reach the existing users. Nothing in the code detects this.

### A squatted account

A brand-new app user has no passkey yet, so the first registration relies on the app session
alone. An attacker who holds a user's app session before that user's first NorKey use can register
their own passkey and wallet under that app account. The real user then reaches **Unlock your
wallet** and cannot open it. No funds are at risk, since the wallet is the attacker's own, but the
account is taken. NorKey does not prevent this in code.

To free the account, delete that NorKey user and its rows. Find the user by `external_id` in
`users` (`norkey_users` on Postgres). Delete its rows from `wraps`, `credentials`, `wallets` and
`sessions`, in that order, then the `users` row. Check first that the wallet is empty: the wraps are
the only copy of its key that NorKey keeps.

### Run the demo in custom mode

Build the packages once from the repo root with `pnpm install && pnpm build`. Then start three
processes from the repo root.

1. The server. On SQLite, it uses `examples/demo/custom.db`, or the path in `NORKEY_DB`:

   ```sh
   pnpm --filter demo custom-server
   ```

   On Postgres, start the database from `docker-compose.yml` first:

   ```sh
   pnpm db:up
   DATABASE_URL=postgres://norkey:norkey@localhost:54329/norkey pnpm --filter demo custom-server
   ```

   Stop the database with `pnpm db:down`. It keeps no volume, so its data goes with it.

2. The boundary page, with the same commands as in [Run it](#run-it).

3. The app, with the stub login shown:

   ```sh
   VITE_CUSTOM_AUTH=1 pnpm --filter demo dev
   ```

Open http://localhost:5173, type a name under **App user**, and click **Sign in to the app**. Then
click **Connect**. A new app user sees **Create your wallet**. An app user with a wallet sees
**Unlock your wallet**.

### Postgres

Import the adapter from its own entry point, so a SQLite user does not need postgres.js:

```js
import { postgres } from "@norkey/server/postgres";

const storage = postgres(process.env.DATABASE_URL);
```

Install `postgres` (postgres.js 3.x) in your app: it is an optional peer dependency of
`@norkey/server`. NorKey creates its tables on first use. Their names start with `norkey_`, so they
can share a database with your app. If you run your own migrations, apply the exported
`POSTGRES_SCHEMA` instead. `norkey serve` also uses Postgres when `DATABASE_URL` is set.

The Postgres adapter is run and tested on Node only. Bun, Deno and Cloudflare Workers are not
verified.

## End-to-end journey

```sh
pnpm build && pnpm --filter demo e2e
```

The journey starts Anvil (a Sepolia fork), the server, the boundary page, and the app, then drives Chrome with a
virtual authenticator. It needs `anvil` on your PATH and network access to fork Sepolia. Read the header of
`e2e/journey.mjs` for why it swaps the popup for an iframe. Its last steps add a second virtual
authenticator, a USB security key, on the settings page, send with it, and export the key.

```sh
pnpm build && pnpm --filter demo e2e:sponsored
```

The sponsored journey forks Sepolia and runs Pimlico's Alto bundler and mock paymaster locally, so
it needs no API key.

```sh
pnpm build && pnpm db:up
DATABASE_URL=postgres://norkey:norkey@localhost:54329/norkey pnpm --filter demo e2e:custom
```

The custom-mode journey runs `custom-server.mjs` on Postgres. It empties the `norkey_` tables
first. It checks that a signed-out connect rejects with `4100`, then creates a wallet for one app
user, sends, and adds a second passkey. A second app user's connect opens the popup instead of
returning the first user's address. The first user then signs back in and unlocks the same wallet.
It fails at once if `DATABASE_URL` is unset or Postgres does not answer.

## Sponsored gas

A chain set to `gas: "sponsored"` sends every transaction as an ERC-4337 user operation that your
ERC-7677 paymaster pays for. The app calls the paymaster through the server, so the paymaster URL
and its API key stay on the server.

Start the server with the paymaster for each chain, and allow the app origin to call it:

```sh
NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 NORKEY_APP_ORIGINS=http://localhost:5173 \
NORKEY_PAYMASTER_11155111=https://api.candide.dev/public/v3/11155111 \
NORKEY_PAYMASTER_ALLOW=all NORKEY_DB=./demo.db node packages/server/dist/serve.js
```

Then start the app with the sponsored chains listed:

```sh
VITE_SPONSORED=11155111 pnpm --filter demo dev
```

Chains not listed stay on native gas. A wallet with no ETH can send zero-value transactions on a
sponsored chain. The first one upgrades the wallet to Calibur inside the sponsored bundle. Sending
ETH still needs the ETH you send.

Candide's public endpoint sponsors on Sepolia with no key. A keyed vendor URL goes in the same
variable, for example `https://api.pimlico.io/v2/11155111/rpc?apikey=<key>`, and its policy goes in
`NORKEY_PAYMASTER_CONTEXT_11155111`, for example `'{"sponsorshipPolicyId":"<policy id>"}'`.

- `NORKEY_APP_ORIGINS` may call only the paymaster route and `/logout`. Do not add the app origin
  to `NORKEY_ORIGINS`: that list is also WebAuthn's expected origin.
- `NORKEY_PAYMASTER_ALLOW=all` sponsors every signed-in user, and anyone can sign up. Set per-sender
  and total limits in your paymaster's dashboard. They are the only cap on what you spend. To decide
  per user, mount `createNorKeyHandler` yourself and write `allow`.
- Use one vendor for both the paymaster and the bundler on a chain.
