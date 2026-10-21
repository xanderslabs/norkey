# NorKey

App wallets you host yourself. NorKey gives your JS/TS app self-custodial wallets for its users. Each
wallet is a plain EOA, unlocked with a passkey and delegated through EIP-7702 to Uniswap's Calibur.
You run the server part yourself, with your own code or the bundled `norkey serve`, and it stores
only encrypted keys. No vendor sits in the signing path, and nothing is billed per user.

## Packages

| Package | What it does |
| --- | --- |
| [`@norkey/client`](packages/client) | The browser client: an EIP-1193 provider for your app, announced through EIP-6963 under your app's name. |
| [`@norkey/server`](packages/server) | The server: a fetch handler and the `norkey serve` command. It stores users, passkey credentials and encrypted key wraps in SQLite or Postgres, and can relay ERC-7677 paymaster calls. |
| [`@norkey/vault`](packages/vault) | The `norkey-vault` command. It builds the boundary page, the only page that decrypts a wallet key, and serves it for local development. |

## Security model

- A database leak yields nothing usable: the server stores each wallet key only as ciphertext, wrapped under a key derived from one passkey's PRF output.
- The key exists in boundary-page memory for one gesture, and same-origin isolation keeps the app page out. XSS on the app page can request signatures; the consent screen and the gesture are the defenses.
- Boundary-page hosting is the crown jewel: a server breach can serve a tampered boundary page, and the next gesture on that page would leak the key.
- Losing every passkey loses access through NorKey, and the server cannot help. Funds stay at the EOA, and only a user who exported the key can still move them.
- The developer who owns the domain is trusted. Device malware is out of scope.

## Documentation

- [Quick start](docs/quickstart.md): from an empty folder to a sent transaction on Sepolia.
- How-to guides: [custom auth](docs/custom-auth.md), [Postgres](docs/postgres.md),
  [sponsored gas](docs/sponsored-gas.md), [deploy](docs/deploy.md).
- [Security](docs/security.md): the key model and its stated limits.
- Reference: [client](docs/reference/client.md), [server](docs/reference/server.md),
  [vault CLI](docs/reference/vault-cli.md).
- [Demo](examples/demo): a Vite app that runs every flow, with end-to-end journeys.

## License

MIT. See [LICENSE](LICENSE).
