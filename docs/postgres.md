# Store data in Postgres

This guide shows how to keep NorKey's data in Postgres in place of SQLite. The tables can share a
database with your app: their names start with `norkey_`.

The Postgres adapter is run and tested on Node only. Bun, Deno and Cloudflare Workers are not
verified.

## Install postgres.js

The adapter runs on postgres.js, an optional peer dependency of `@norkey/server`. Install it next to
`@norkey/server`:

```sh
npm install postgres@3
```

## Use Postgres with norkey serve

Set `DATABASE_URL`. The server then uses Postgres and ignores `NORKEY_DB`:

```sh
DATABASE_URL=postgres://norkey:norkey@localhost:54329/norkey \
NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 npx norkey serve
```

NorKey creates its tables on first use.

## Use Postgres in your own server

Import the adapter from its own entry point, `@norkey/server/postgres`. An app on SQLite never loads
it, so it does not need postgres.js.

```js
import { createNorKeyHandler } from "@norkey/server";
import { postgres } from "@norkey/server/postgres";

const storage = postgres(process.env.DATABASE_URL);
const handler = createNorKeyHandler({
  rpId: "localhost",
  origins: ["http://localhost:5174"],
  storage,
});
```

`postgres(url)` returns the storage with one more method, `close()`, which ends the connection pool.
Call it when your server shuts down.

## Run your own migrations

If your team applies every schema change through its own migrations, take NorKey's tables from
`POSTGRES_SCHEMA`. It holds the SQL that creates `norkey_users`, `norkey_credentials`,
`norkey_wallets`, `norkey_wraps`, `norkey_challenges` and `norkey_sessions`.

1. Write the SQL to a file:

   ```sh
   node --input-type=module -e "import { POSTGRES_SCHEMA } from '@norkey/server/postgres'; console.log(POSTGRES_SCHEMA)" > norkey-schema.sql
   ```

2. Add `norkey-schema.sql` to your migrations, and apply it.

Each statement is `CREATE TABLE IF NOT EXISTS`. The adapter still runs them on first use, and they
leave existing tables as they are.

See [Storage](reference/server.md#storage) in the server reference for the adapter and the storage
interface.
