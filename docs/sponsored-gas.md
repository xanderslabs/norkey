# Sponsor your users' gas

This guide shows how to pay gas for your users through an ERC-7677 paymaster. On a sponsored chain,
every send is an ERC-4337 user operation that your paymaster pays for. The app calls the paymaster
through your NorKey server, so the paymaster URL and its API key stay on the server.

A wallet with no ETH can then send zero-value transactions. Its first sponsored send also upgrades
it to Calibur, inside the sponsored bundle. Sending ETH still needs the ETH you send.

## Choose a paymaster

Use one vendor for both the paymaster and the bundler on a chain. The server sends both kinds of
call to the same URL.

- An example of an ERC-7677 paymaster URL is Candide's public endpoint for Sepolia:
  `https://api.candide.dev/public/v3/11155111`.
- A keyed vendor URL works the same way, for example
  `https://api.pimlico.io/v2/11155111/rpc?apikey=<key>`.

## Configure the server

### With norkey serve

Set the paymaster URL for each chain, allow your app's origin to call it, and set the sponsorship
rule:

```sh
NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 NORKEY_APP_ORIGINS=http://localhost:5173 \
NORKEY_PAYMASTER_11155111=https://api.candide.dev/public/v3/11155111 \
NORKEY_PAYMASTER_ALLOW=all npx --no-install norkey serve
```

- `NORKEY_PAYMASTER_<chainId>` adds a paymaster proxy route for that chain, at
  `<basePath>/paymaster/<chainId>`.
- `NORKEY_APP_ORIGINS` is required with a paymaster. Only these origins may call the paymaster
  route. Do not add the app's origin to `NORKEY_ORIGINS`: that list is also WebAuthn's expected
  origin, and the boundary page's origins may not call the paymaster route.
- `NORKEY_PAYMASTER_ALLOW=all` sponsors every signed-in user. The server refuses to start without
  it.
- For a vendor that takes a sponsorship policy, set `NORKEY_PAYMASTER_CONTEXT_<chainId>` to the
  ERC-7677 context as JSON, for example `'{"sponsorshipPolicyId":"<policy id>"}'`.

`NORKEY_PAYMASTER_ALLOW=all` and passkey sign-in together mean that anyone can create a wallet and
get sponsored. Set per-sender and total limits in your paymaster's dashboard. They are the only cap
on what you spend.

### With your own allow rule

To decide per user, mount `createNorKeyHandler` yourself and write `allow`:

```js
const handler = createNorKeyHandler({
  rpId: "localhost",
  origins: ["http://localhost:5174"],
  appOrigins: ["http://localhost:5173"],
  storage,
  paymasterProxy: {
    11155111: {
      url: process.env.PAYMASTER_URL,
      allow: ({ address }) => sponsored.has(address),
    },
  },
});
```

`allow` runs for each `pm_getPaymasterStubData` and `pm_getPaymasterData` call, with the user, the
wallet address, the chain, the method and the user operation. Return `false` to refuse, and the app
gets error `4100` with "This app does not sponsor this transaction." The argument fields are in
[PaymasterAllowArgs](reference/server.md#paymasterallowargs).

## Configure the app

Mark the chain as sponsored in `createNorKeyProvider`, and point `paymasterUrl` at the server's
proxy route for that chain:

```ts
createNorKeyProvider({
  name: "My App",
  vaultOrigin: "http://localhost:5174",
  apiUrl: "http://localhost:8787/norkey",
  chains: [
    {
      id: 11155111,
      rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
      gas: "sponsored",
      paymasterUrl: "http://localhost:8787/norkey/paymaster/11155111",
    },
  ],
  defaultChainId: 11155111,
});
```

Chains you leave on `gas: "native"` keep paying their own gas. The boundary page needs no change, as
long as its `--chains` lists the chain.

See [NorKeyChain](reference/client.md#norkeychain) and the
[paymaster proxy methods](reference/server.md#paymaster-proxy-methods) for the details.
