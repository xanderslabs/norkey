# @norkey/server

The NorKey server. It stores users, passkey credentials, wallet addresses and encrypted key wraps
in your own database, SQLite or Postgres. It never receives a plaintext key. Run it with
`norkey serve`, or mount its fetch handler in your own server.

```sh
npm install @norkey/server
NORKEY_RP_ID=localhost NORKEY_ORIGINS=http://localhost:5174 npx norkey serve
```

Docs: the [quick start](https://github.com/xanderslabs/norkey/blob/main/docs/quickstart.md) and the
[server reference](https://github.com/xanderslabs/norkey/blob/main/docs/reference/server.md).
