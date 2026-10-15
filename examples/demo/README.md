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

```sh
pnpm build && pnpm --filter demo e2e:sponsored
```

The sponsored journey forks Sepolia and runs Pimlico's Alto bundler and mock paymaster locally, so
it needs no API key.

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

- `NORKEY_APP_ORIGINS` may call only the paymaster route. Do not add the app origin to
  `NORKEY_ORIGINS`: that list is also WebAuthn's expected origin.
- `NORKEY_PAYMASTER_ALLOW=all` sponsors every signed-in user, and anyone can sign up. Set per-sender
  and total limits in your paymaster's dashboard. They are the only cap on what you spend. To decide
  per user, mount `createNorKeyHandler` yourself and write `allow`.
- Use one vendor for both the paymaster and the bundler on a chain.
