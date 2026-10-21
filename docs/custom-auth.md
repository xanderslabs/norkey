# Use your app's sign-in

This guide shows how to make your app's own sign-in decide who the user is, in place of NorKey's
passkey sign-in. This is custom auth mode. Each app user gets at most one wallet, and the user still
approves every wallet operation with a passkey.

Before you start, finish the [quick start](quickstart.md) or have the boundary page and the app
running. Stop the quick start's `norkey serve` first, because the server below uses the same port,
8787. Your app must set the session cookie that the example's `getUserId` reads.

## Mount the handler yourself

`norkey serve` cannot run custom mode, because `getUserId` is code. Mount `createNorKeyHandler` in
your own Node server:

```js
import { createServer } from "node:http";
import { createNorKeyHandler, nodeListener, sqlite } from "@norkey/server";

// Stand-in for your app's session lookup: returns the user id for a session token, or null.
async function findUserBySession(token) {
  return token === "t1" ? "user-1" : null;
}

async function getUserId(req) {
  const cookie = req.headers.get("cookie") ?? "";
  const token = /(?:^|;\s*)app_session=([^;]+)/.exec(cookie)?.[1];
  return token ? findUserBySession(token) : null;
}

const handler = createNorKeyHandler({
  rpId: "localhost",
  origins: ["http://localhost:5174"],
  appOrigins: ["http://localhost:5173"],
  auth: { mode: "custom", getUserId },
  storage: sqlite("./custom.db"),
});

createServer(nodeListener(handler)).listen(8787);
```

Replace `findUserBySession` with your app's own session lookup. `createNorKeyHandler` returns a
Web-standard fetch handler, so you can also mount it in any framework that takes a `Request` and
returns a `Response`. See the [server reference](reference/server.md).

Check the mode. With no app session, the server reports the user as signed out:

```sh
curl http://localhost:8787/norkey/status
```

```json
{"mode":"custom","signedIn":false}
```

## Write getUserId

`getUserId(req)` receives the request as a `Request`. It returns the app's user id, or `null` when
the app user is signed out. It can return a promise.

- NorKey trims the id. Anything other than a non-empty string counts as signed out.
- An error thrown by `getUserId` fails the request with `500`.
- The id decides whose wallet the request reaches. NorKey stores it as `external_id` and keeps its
  own random user id. Your id never reaches an authenticator.

When the app user is signed out, the popup says "Sign in to the app first." and the provider
rejects the request with code `4100`. Custom mode never falls back to NorKey's own sign-in.

## Set your session cookie for the boundary page

The boundary page calls the handler from its own origin, so your app's session cookie must reach the
handler from there too. Set the cookie from your app's server with `Domain=<registrable domain>`
and `SameSite=Lax`. For an app at `app.com` with the boundary page at `accounts.app.com`:

```http
Set-Cookie: app_session=<token>; Domain=app.com; Path=/; SameSite=Lax
```

The boundary page and the handler are same-site, so `SameSite=Lax` is enough. NorKey never reads the
token. Only your `getUserId` does.

On `localhost`, a cookie is shared across ports, so you can leave out `Domain` while you develop.

## Sign the wallet out when the app user signs out

Call `wallet_revokePermissions` on the provider when the app user signs out:

```js
await provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
```

The provider posts to `<apiUrl>/logout`, which deletes the NorKey session, and forgets the
remembered address. Without this call, `eth_requestAccounts` returns the remembered address from
`localStorage` without a popup, so the next app user on the device gets the previous user's
address. Put the app's origin in `appOrigins`, or the server refuses the `/logout` call.

## Choose the mode once per database

Passkey mode stores users with a null `external_id`, and custom mode finds users only by
`external_id`. If you switch a database from passkey mode to custom mode, the existing users can no
longer be reached. Nothing in the code detects this. Pick the mode before the first user signs up.

## Free a squatted account

An attacker who holds an app user's session before that user's first use of NorKey can register their own
passkey and wallet under that app account. The real user then sees **Unlock your wallet** and cannot
open it. See [Security](security.md#custom-auth-mode) for why.

To free the account, delete that NorKey user and its rows:

1. Find the user's `id` by `external_id` in `users` (`norkey_users` on Postgres).
2. Check that the wallet's address holds no funds. The wraps are the only copy of its key that
   NorKey keeps.
3. Delete the user's rows from `wraps`, `credentials`, `wallets` and `sessions`, in that order.
4. Delete the `users` row.

On Postgres, each table name starts with `norkey_`.
