# @norkey/client reference

The browser client. It exposes an EIP-1193 provider that opens the boundary page as a popup for
every operation that needs the key.

## Entry points

| Import path | Contents |
| --- | --- |
| `@norkey/client` | `createNorKeyProvider`, `ProviderRpcError`, `CALIBUR_ADDRESS`, and the types `NorKeyProviderConfig`, `NorKeyChain`, `Eip1193Provider`, `Eip6963ProviderInfo`, `PopupRequest`, `PopupReply`, `PreparedCalls`, `PreparedUserOp`. |
| `@norkey/client/protocol` | The popup message types and constants that the boundary page shares with the client. |
| `@norkey/client/calibur` | The Calibur and EntryPoint constants and call encoders that the boundary page shares with the client. |

The two subpaths exist for `@norkey/vault`. An app needs only `@norkey/client`.

## createNorKeyProvider

```ts
function createNorKeyProvider(config: NorKeyProviderConfig): Eip1193Provider;
```

Checks `config`, creates the provider, and announces it through EIP-6963. The announcement is sent
once at creation and again on every `eip6963:requestProvider` event. Its `info` is:

| Field | Value |
| --- | --- |
| `uuid` | A new `crypto.randomUUID()` for each call. |
| `name` | `config.name`. |
| `icon` | `config.icon`, or a neutral wallet icon when it is not set. |
| `rdns` | The hostname of `config.vaultOrigin` with its labels reversed. The port is dropped. `https://accounts.app.com` gives `com.app.accounts`, and `http://localhost:5174` gives `localhost`. |

`createNorKeyProvider` throws a `TypeError` from `new URL` when `vaultOrigin` does not parse as a
URL. It throws an `Error` whose message starts with `NorKey:` when:

- The page is not a secure context. Serve the app over HTTPS or from `localhost`.
- `vaultOrigin` parses as a URL but is not a bare origin.
- `apiUrl` is missing or empty.
- `defaultChainId` is not the `id` of a chain in `chains`.
- A chain has an empty `rpcUrls`.
- A chain has `gas: "sponsored"` and no `paymasterUrl`.
- A chain has a `gas` value other than `"native"` or `"sponsored"`.

## NorKeyProviderConfig

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vaultOrigin` | `string` | Yes | The boundary page origin, for example `https://accounts.app.com`. It must use HTTPS unless its host is `localhost`, `127.0.0.1` or `[::1]`. The popup check rejects any other origin when the popup opens. |
| `apiUrl` | `string` | Yes | The server handler's base, for example `/norkey`. Point it at the same server handler as `--api`. A relative URL resolves against the app page. |
| `chains` | `NorKeyChain[]` | Yes | The chains the wallet can use. |
| `defaultChainId` | `number` | Yes | The chain the provider starts on. It must be in `chains`. |
| `name` | `string` | Yes | The app's wallet name, shown in wallet pickers (EIP-6963). |
| `icon` | `string` | No | A `data:` URI for wallet pickers. Default: a neutral wallet icon. |
| `label` | `() => string \| undefined` | No | Names a new wallet's passkey in the browser's passkey picker, for example the signed-in user's email. Called when the connect popup opens. When it is missing or returns a blank string, the server names the passkey `<rpName> wallet` followed by 6 hex characters. |

## NorKeyChain

A union on `gas`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | Yes | The chain id. |
| `rpcUrls` | `string[]` | Yes | JSON-RPC URLs, used in order as a fallback list. At least one. |
| `gas` | `"native" \| "sponsored"` | Yes | `"native"`: the wallet pays gas and sends an EIP-7702 transaction. `"sponsored"`: every send is an ERC-4337 user operation that an ERC-7677 paymaster pays for. |
| `paymasterUrl` | `string` | With `"sponsored"` | The server's paymaster proxy for this chain, for example `/norkey/paymaster/11155111`. A relative URL resolves against the app page. It serves both the paymaster and the bundler methods. |
| `calibur` | `Address` | No | The delegate the provider checks for. Default: `CALIBUR_ADDRESS`. The boundary page signs only for the address in its own build, so set this to the page's `--calibur` for the chain. If the two differ, every send delegates again. |

## Eip1193Provider

```ts
type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};
```

### Events

| Event | Argument | Emitted when |
| --- | --- | --- |
| `connect` | `{ chainId: string }` | `eth_requestAccounts` connects through the popup. |
| `accountsChanged` | `string[]` | An account connects (`[address]`), or the provider forgets it (`[]`). |
| `chainChanged` | `string` (hex chain id) | `wallet_switchEthereumChain` moves to another chain. |

The provider remembers the connected address in `localStorage` under `norkey:address`. It forgets the
address on `wallet_revokePermissions`, on a `4100` reply from the popup, and on an expired session
from the paymaster proxy.

### Methods

| Method | Behavior |
| --- | --- |
| `eth_chainId` | The current chain id, as hex. |
| `eth_accounts` | `[address]` when an address is remembered, else `[]`. |
| `eth_requestAccounts` | Returns the remembered address without a popup. Otherwise opens the popup to create a wallet or open an existing one, then emits `connect` and `accountsChanged`. |
| `wallet_revokePermissions` | Posts to `<apiUrl>/logout` with credentials, forgets the address, and emits `accountsChanged` with `[]`. Returns `null`. If the server call fails, the address is still forgotten and the call rejects with `-32603`. |
| `wallet_switchEthereumChain` | Switches to `params[0].chainId`. Rejects with `4902` if the chain is not in `chains`. Returns `null`. |
| `eth_sendTransaction` | Sends one call from `params[0]`, which must name the connected account in `from`. On a native chain, returns the transaction hash. On a sponsored chain, waits up to 60 seconds for the bundle and returns its transaction hash. |
| `wallet_sendCalls` | EIP-5792. Sends `calls` as one atomic batch and returns `{ id }`. A `chainId` other than the current chain rejects with `4902`. A capability not marked `optional` rejects with `5700`. `from` defaults to the connected account. |
| `wallet_getCallsStatus` | EIP-5792 status `2.0.0` for an id from `wallet_sendCalls`: `100` pending, `200` confirmed, `500` reverted. Every batch is reported as `atomic: true`. A well-formed id that was never sent stays at `100`. A malformed id, an id for a chain not in `chains`, or an `op:` id on a native chain rejects with `5730`. |
| `wallet_getCapabilities` | `{ atomic: { status: "supported" } }` for each requested chain in `chains`, keyed by hex chain id. With no chain list in `params[1]`, it covers every chain in `chains`. |
| `personal_sign`, `eth_sign`, `eth_signTypedData_v4`, `wallet_showCallsStatus` | Reject with `4200`. |
| Any other method | Forwarded to the current chain's `rpcUrls`. |

The first send on a chain carries an EIP-7702 authorization to the chain's Calibur address. Later
sends on that chain do not.

### Call rules

`eth_sendTransaction` and `wallet_sendCalls` check each call before the popup opens. A failed check
rejects with `-32602`.

- Between 1 and 10 calls per send.
- `to` is required. Contract creation is not supported.
- `to` cannot be the wallet itself or the zero address.
- `value`, when set, is a hex quantity.
- `data`, when set, is hex of whole bytes.

On a sponsored chain, a second send from the same account on the same chain rejects with `-32603`
while the first is still pending.

### Bundle ids

`wallet_sendCalls` returns `<chainId>:<hash>` for a native send and `<chainId>:op:<hash>` for a
sponsored one, with the chain id in hex. The status lookup needs no stored state.

## ProviderRpcError

```ts
class ProviderRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string);
}
```

A rejection from `request` is a `ProviderRpcError`, with two exceptions: a `vaultOrigin` that fails
the HTTPS check rejects with a plain `Error`, and errors from the chain's RPC pass through as they
are. A popup reply carries the code and message the boundary page chose.

| Code | Messages |
| --- | --- |
| `4001` | "The wallet popup was blocked. Allow popups and try again."; "The wallet popup timed out." (5 minutes with no word from the popup); "The wallet popup was closed."; "User rejected the request." |
| `4100` | "The requested account is not connected."; "Your wallet session expired. Connect again." (the paymaster proxy answered `401`); "This app does not sponsor this transaction." (the paymaster proxy answered `403`); "Sign in to the app first." (custom auth mode, the app user is signed out) |
| `4200` | "`<method>` is not supported yet" |
| `4902` | "Chain not configured"; "Switch to chain `<id>` before sending calls to it." |
| `5700` | "The capability "`<name>`" is not supported." |
| `5730` | "Unknown bundle id." |
| `-32602` | A call failed the call rules, or the boundary page refused the request. |
| `-32603` | The paymaster or bundler refused; the paymaster proxy did not answer or answered an error status; a sponsored send is still pending; a user operation reverted on chain or was not bundled within 60 seconds; the server session could not be ended on disconnect; the boundary page failed for another reason. |

## CALIBUR_ADDRESS

`0x000000005c84F8Fd50b21CAC312528A64437030e`, Uniswap's Calibur. The default delegate on every
chain.
