# NorKey demo

A plain Vite page that connects a NorKey wallet on Sepolia and Unichain Sepolia and sends ETH
through viem. It runs from this repo's workspace packages. To set NorKey up in your own app from
the published packages, follow the [quick start](../../docs/quickstart.md).

## Run it

Build the packages once from the repo root:

```sh
pnpm install && pnpm build
```

Then start three processes from the repo root.

1. The server:

   ```sh
   NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 NORKEY_APP_ORIGINS=http://localhost:5173 \
   NORKEY_DB=./demo.db node packages/server/dist/serve.js serve
   ```

2. The boundary page:

   ```sh
   node packages/vault/dist/bin.js build --rp-id localhost --api http://localhost:8787/norkey --app-origin http://localhost:5173 --chains 11155111,1301
   node packages/vault/dist/bin.js serve --port 5174
   ```

3. The app:

   ```sh
   pnpm --filter demo dev
   ```

Open http://localhost:5173, click **Connect**, then **Create a new wallet**. Fund the address from a
Sepolia faucet, then send a small amount. The Unichain Sepolia address needs its own test ETH, for
example bridged from Sepolia or from a faucet.

**Disconnect** calls `wallet_revokePermissions`, which ends the server session. **Wallet settings**
opens the boundary page in a new tab, where you can add a passkey, test a passkey, or export the
wallet key.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_SEPOLIA_RPC` | `https://ethereum-sepolia-rpc.publicnode.com` | Sepolia RPC URL. |
| `VITE_UNICHAIN_SEPOLIA_RPC` | `https://sepolia.unichain.org` | Unichain Sepolia RPC URL. |
| `VITE_API` | `http://localhost:8787/norkey` | The provider's `apiUrl`. |
| `VITE_VAULT_ORIGIN` | `http://localhost:5174` | The provider's `vaultOrigin`. |
| `VITE_SPONSORED` | Not set | Comma-separated chain ids that use sponsored gas. |
| `VITE_CUSTOM_AUTH` | Not set | `1` shows the stub app sign-in for custom auth mode. |

## Run it in custom auth mode

`custom-server.mjs` mounts the server in [custom auth mode](../../docs/custom-auth.md). Its
`getUserId` reads a `demo_user` cookie that the page sets itself. That is a stub: a real app reads
its own session. Build the packages once with `pnpm install && pnpm build`, then start three
processes from the repo root.

1. The server. On SQLite, it uses `examples/demo/custom.db`, or the path in `NORKEY_DB`:

   ```sh
   pnpm --filter demo custom-server
   ```

   On [Postgres](../../docs/postgres.md), start the database from `docker-compose.yml` first:

   ```sh
   pnpm db:up
   DATABASE_URL=postgres://norkey:norkey@localhost:54329/norkey pnpm --filter demo custom-server
   ```

   Stop the database with `pnpm db:down`. Its data is not kept between runs.

2. The boundary page, with the same commands as in [Run it](#run-it).

3. The app, with the stub login shown:

   ```sh
   VITE_CUSTOM_AUTH=1 pnpm --filter demo dev
   ```

Open http://localhost:5173, type a name under **App user**, and click **Sign in to the app**. Then
click **Connect**. A new app user sees **Create your wallet**. An app user with a wallet sees
**Unlock your wallet**. **Sign out of the app** calls `wallet_revokePermissions` before it clears
`demo_user`.

## Run it with sponsored gas

Start the server with a [paymaster](../../docs/sponsored-gas.md) for Sepolia:

```sh
NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 NORKEY_APP_ORIGINS=http://localhost:5173 \
NORKEY_PAYMASTER_11155111=https://api.candide.dev/public/v3/11155111 \
NORKEY_PAYMASTER_ALLOW=all NORKEY_DB=./demo.db node packages/server/dist/serve.js serve
```

Then start the app with the sponsored chains listed:

```sh
VITE_SPONSORED=11155111 pnpm --filter demo dev
```

Chains not listed stay on native gas.

## End-to-end journeys

```sh
pnpm build && pnpm --filter demo e2e
```

The journey starts Anvil (a Sepolia fork), the server, the boundary page, and the app, then drives
Chrome with a virtual authenticator. It needs `anvil` on your PATH and network access to fork
Sepolia. Read the header of `e2e/journey.mjs` for why it swaps the popup for an iframe. Its last
steps add a second virtual authenticator, a USB security key, on the settings page, send with it,
and export the key.

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
