# @norkey/server reference

The server stores users, passkey credentials, wallet addresses and encrypted key wraps. It never
receives a plaintext key.

## Entry points

| Import path | Exports |
| --- | --- |
| `@norkey/server` | `createNorKeyHandler`, `nodeListener`, `MAX_BODY_BYTES`, `sqlite`, `WalletExistsError`, `ExternalIdTakenError`, and the types `NorKeyHandlerConfig`, `AuthConfig`, `PaymasterProxyEntry`, `PaymasterAllowArgs`, `NorKeyStorage`, `StoredCredential`, `StoredWrap`. |
| `@norkey/server/postgres` | `postgres`, `POSTGRES_SCHEMA`. |

| Binary | Command |
| --- | --- |
| `norkey` | `norkey serve` |

The package declares Node 24 or later in `engines`.

## createNorKeyHandler

```ts
function createNorKeyHandler(config: NorKeyHandlerConfig): (req: Request) => Promise<Response>;
```

Returns a Web-standard fetch handler. Mount it at `basePath` in any framework that takes a `Request`
and returns a `Response`. Requests outside `basePath` get `404`.

The config is checked when the handler is created. A bad config throws an `Error` whose message
starts with `NorKey:`.

## NorKeyHandlerConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rpId` | `string` | Required | The WebAuthn relying party ID: the app's registrable domain, for example `app.com`. |
| `rpName` | `string` | `rpId` | The WebAuthn relying party name. New passkeys without a label are named `<rpName> wallet` followed by 6 hex characters. |
| `origins` | `string[]` | Required | The boundary page origins. At least one. They may call every route except the paymaster proxy, and they are WebAuthn's expected origins. |
| `appOrigins` | `string[]` | `[]` | The app page origins. They may call only the paymaster proxy and `POST /logout`. Required when `paymasterProxy` is set. An origin cannot be in both lists. |
| `storage` | `NorKeyStorage` | Required | Where the server keeps its data. See [Storage](#storage). |
| `basePath` | `string` | `"/norkey"` | Where the handler is mounted. A trailing slash is removed. |
| `cookieDomain` | `string` | Not set | The session cookie's `Domain` attribute, for example `app.com`, so the cookie reaches every subdomain. |
| `sessionTtlSeconds` | `number` | `604800` (7 days) | The session lifetime. |
| `paymasterProxy` | `Record<number, PaymasterProxyEntry>` | Not set | Per chain id, relay ERC-7677 paymaster calls and bundler calls for signed-in users to a vendor URL. |
| `auth` | `AuthConfig` | `{ mode: "passkey" }` | Who decides who the user is. |

Every entry in `origins` and `appOrigins` must be a bare origin, such as `https://accounts.app.com`.

## AuthConfig

```ts
type AuthConfig =
  | { mode: "passkey" }
  | { mode: "custom"; getUserId: (req: Request) => string | null | Promise<string | null> };
```

| Mode | Behavior |
| --- | --- |
| `"passkey"` | The server's own passkey sign-in decides the user. |
| `"custom"` | `getUserId` reads the app's own session from the request and returns the app's user id, or `null` when the app user is signed out. The id is trimmed. Anything other than a non-empty string counts as signed out. Each app user gets at most one NorKey user and one wallet. A passkey assertion is still verified for every key operation. |

In custom mode, the server stores the app's user id as `external_id` and keeps its own random user
id. Passkey mode stores users with a null `external_id`, and custom mode finds users only by
`external_id`. If you switch a database from passkey mode to custom mode, the existing users can no
longer be reached.

## PaymasterProxyEntry

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | The vendor's bundler and paymaster URL, API key included. An absolute `http` or `https` URL. It is never sent to a client and never logged. |
| `context` | `Record<string, unknown>` | No | Sent as the ERC-7677 context on every `pm_*` call. The client's context is dropped. |
| `allow` | `(a: PaymasterAllowArgs) => boolean \| Promise<boolean>` | Yes | Decides each sponsorship request. `false` answers `403`. |

### PaymasterAllowArgs

| Field | Type | Description |
| --- | --- | --- |
| `userId` | `string` | The NorKey user id. |
| `externalId` | `string \| null` | The app's user id in custom mode, `null` in passkey mode. |
| `address` | `string` | The user's wallet address. |
| `chainId` | `number` | The chain of the proxy route. |
| `method` | `string` | `pm_getPaymasterStubData` or `pm_getPaymasterData`. |
| `userOp` | `unknown` | The user operation, as the client sent it. |

## nodeListener

```ts
function nodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```

Adapts a fetch handler to `node:http`. A body larger than `MAX_BODY_BYTES` (65536 bytes) gets `413`.
An error thrown by the handler gets `500` and is logged; the process keeps running.

```ts
createServer(nodeListener(createNorKeyHandler(config))).listen(8787);
```

## Storage

### sqlite

```ts
function sqlite(path: string): NorKeyStorage;
```

SQLite on Node's built-in `node:sqlite`. Creates its tables when `sqlite(path)` is called. Pass `":memory:"` for a
throwaway database.

### postgres

```ts
import { postgres } from "@norkey/server/postgres";

function postgres(url: string): NorKeyStorage & { close(): Promise<void> };
```

Postgres on postgres.js. Install `postgres` 3.x in the app: it is an optional peer dependency.
Creates its tables on first use. Table names start with `norkey_`. `close()` ends the connection
pool. Run and tested on Node only.

### POSTGRES_SCHEMA

The SQL that creates the `norkey_` tables: `norkey_users`, `norkey_credentials`, `norkey_wallets`,
`norkey_wraps`, `norkey_challenges` and `norkey_sessions`. Apply it yourself if you run your own
migrations. Each statement is `CREATE TABLE IF NOT EXISTS`.

### NorKeyStorage

The interface both adapters implement. No method takes or returns a plaintext key.

| Method | Description |
| --- | --- |
| `createUser(userId)` | Creates a user. |
| `addCredential(c)` | Stores a credential. |
| `createUserWithCredential(c, externalId?)` | Creates the user and its first credential in one transaction. Throws `ExternalIdTakenError` if another user has `externalId`. |
| `getUserIdByExternalId(externalId)` | The NorKey user id for an app user id, or `null`. |
| `getCredential(credentialId)` | A `StoredCredential`, or `null`. |
| `listCredentialIds(userId)` | The user's credential ids, oldest first. |
| `addCredentialWithWrap(c, wrap)` | Adds a credential and its wrap to an existing user in one transaction. |
| `setSignCount(credentialId, signCount)` | Updates a credential's sign count. |
| `putChallenge(c)` | Stores a challenge with `id`, `challenge`, `userId` and `expiresAt`. |
| `takeChallenge(id)` | Deletes and returns a challenge, or `null` if it is missing or expired. |
| `createSession(s)` | Stores a session by `tokenHash`, with `userId` and `expiresAt`. |
| `getSessionUser(tokenHash)` | The session's user id, or `null`. |
| `getSession(tokenHash)` | The session's `userId` and `expiresAt`, or `null` if it is missing or expired. |
| `deleteSession(tokenHash)` | Deletes a session. A missing session is not an error. |
| `createWallet(userId, address, wrap)` | Creates the wallet and its first wrap in one transaction. Throws `WalletExistsError` if the user has a wallet. |
| `getWallet(userId)` | `{ address }`, or `null`. |
| `getWrap(userId, credentialId)` | A `StoredWrap`, or `null`. |

`StoredWrap` is `{ id, kind: "passkey", credentialId, salt, iv, ciphertext }`, all strings.
`StoredCredential` is `{ credentialId, userId, publicKey, signCount, transports }`.

## Routes

Paths are relative to `basePath`. All bodies are JSON.

| Route | Who may call | Description |
| --- | --- | --- |
| `GET /status` | Any | Passkey mode: `{ "mode": "passkey" }`. Custom mode: `{ "mode": "custom", "signedIn": false }`, or `{ "mode": "custom", "signedIn": true, "hasUser", "hasWallet" }`. |
| `POST /register/options` | `origins` | WebAuthn creation options for a new user, and a `challengeId`. Takes an optional `label`. Custom mode: `409` if the app user already has a wallet. |
| `POST /register/verify` | `origins` | Verifies the new passkey, creates the user, and starts a session. Returns `{ userId }`. |
| `POST /login/options` | `origins` | WebAuthn request options, and a `challengeId`. Takes an optional `credentialId`. Custom mode: `404` if the app user has no NorKey user. |
| `POST /login/verify` | `origins` | Verifies the assertion and starts a session. Returns `{ userId, wallet, wrap }`. Custom mode: `403` if the passkey belongs to another app user. |
| `POST /wallet` | `origins`, session | Stores the wallet `address` and its first `wrap`. Returns `201` with `{ address }`. `409` if the user has a wallet. |
| `GET /wallet` | Session | `{ address }`, or `404`. |
| `POST /passkeys/options` | `origins`, session from the last 5 minutes | WebAuthn creation options for one more passkey, and a `challengeId`. `409` if the user has no wallet. |
| `POST /passkeys` | `origins`, session from the last 5 minutes | Stores the new passkey and its `wrap`. Returns `201` with `{ credentialId }`. |
| `POST /logout` | `origins` or `appOrigins` | Deletes the session and expires its cookie. Returns `204`, with or without a session. |
| `POST /paymaster/<chainId>` | `appOrigins`, session, wallet | Relays one JSON-RPC request to the chain's `paymasterProxy` entry. `404` if the chain has none. |

A request other than `GET` from an origin not allowed for the route gets `403`. In custom mode, the register and login
routes answer `401` when the app user is signed out, and a session-gated route also needs the
session's user to match the app user.

### Paymaster proxy methods

| Method | Checks |
| --- | --- |
| `pm_getPaymasterStubData`, `pm_getPaymasterData` | The operation's `sender` is the user's wallet, the EntryPoint is v0.8, the chain id matches the route, and `allow` returns `true`. The entry's `context` replaces the client's. |
| `eth_estimateUserOperationGas`, `eth_sendUserOperation` | The operation's `sender` is the user's wallet and the EntryPoint is v0.8. A client state override is dropped. |
| `eth_getUserOperationReceipt` | The parameter is a 32-byte hash. |

Other methods get JSON-RPC error `-32601`. The upstream call times out after 30 seconds. Upstream
error messages are cut to their first line, and URLs and parts of the vendor URL are replaced with
`[url]`.

### Session cookie

`norkey_session`, with `Path=/`, `HttpOnly` and `SameSite=Lax`. `Secure` is set unless `rpId` is
`localhost`. `Domain` is set from `cookieDomain`. The server stores only the SHA-256 hash of the
token.

## norkey serve

```sh
npx --no-install norkey serve
```

Starts the handler on `node:http` in passkey auth mode, at the default `basePath` `/norkey`. Any
first argument other than `serve` prints usage and exits with code 1. It cannot run custom auth
mode, because `getUserId` is code. Mount `createNorKeyHandler` yourself for that.

| Variable | Description |
| --- | --- |
| `NORKEY_RP_ID` | Required. `rpId`. |
| `NORKEY_ORIGINS` | Required. `origins`, comma-separated. |
| `NORKEY_RP_NAME` | `rpName`. |
| `NORKEY_APP_ORIGINS` | `appOrigins`, comma-separated. Required when a paymaster is set. |
| `NORKEY_COOKIE_DOMAIN` | `cookieDomain`. |
| `NORKEY_DB` | SQLite file path. Default `./norkey.db`. |
| `DATABASE_URL` | Postgres URL. When set, the server uses Postgres and ignores `NORKEY_DB`. Install the optional peer dependency `postgres` (3.x) next to `@norkey/server` first. |
| `NORKEY_PORT` | Listen port. Default `8787`. |
| `NORKEY_PAYMASTER_<chainId>` | The paymaster and bundler URL for that chain. Adds a `paymasterProxy` entry. |
| `NORKEY_PAYMASTER_CONTEXT_<chainId>` | JSON sent as that chain's ERC-7677 context. Invalid JSON exits with code 1. |
| `NORKEY_PAYMASTER_ALLOW` | Must be `all` when any `NORKEY_PAYMASTER_<chainId>` is set, or the server exits with code 1. `all` sponsors every signed-in user. |

A missing required variable exits with code 1. The server logs `norkey listening on :<port>` when it
is ready.
