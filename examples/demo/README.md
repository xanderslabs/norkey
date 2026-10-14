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
   NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 NORKEY_DB=./demo.db node packages/server/dist/serve.js
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

Open http://localhost:5173, click **Connect**, then **Create a new wallet**. Fund the address from a Sepolia
faucet, then send a small amount. Set `VITE_SEPOLIA_RPC` to use your own RPC.
Set `VITE_UNICHAIN_SEPOLIA_RPC` to use your own Unichain Sepolia RPC.

The Unichain Sepolia address needs its own test ETH, for example bridged from Sepolia or from a
faucet.

## End-to-end journey

```sh
pnpm build && pnpm --filter demo e2e
```

The journey starts Anvil (a Sepolia fork), the server, the boundary page, and the app, then drives Chrome with a
virtual authenticator. It needs `anvil` on your PATH and network access to fork Sepolia. Read the header of
`e2e/journey.mjs` for why it swaps the popup for an iframe.
