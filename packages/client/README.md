# @norkey/client

The browser client for NorKey. It gives your app an EIP-1193 provider, announced through EIP-6963
under your app's name. Each operation that needs the wallet key opens the boundary page as a popup,
and the user approves it with a passkey.

```sh
npm install @norkey/client viem
```

```ts
import { createNorKeyProvider } from "@norkey/client";

const provider = createNorKeyProvider({
  name: "My App",
  vaultOrigin: "https://accounts.app.com",
  apiUrl: "/norkey",
  chains: [{ id: 11155111, rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], gas: "native" }],
  defaultChainId: 11155111,
});
```

Docs: the [quick start](https://github.com/xanderslabs/norkey/blob/main/docs/quickstart.md) and the
[client reference](https://github.com/xanderslabs/norkey/blob/main/docs/reference/client.md).
