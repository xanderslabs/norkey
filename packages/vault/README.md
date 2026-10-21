# @norkey/vault

The `norkey-vault` command. It builds the NorKey boundary page, the only page that decrypts a wallet
key, with your app's name, logo, chains and server URL baked in. It writes the page and the security
headers to serve it with, and it can serve the result for local development.

```sh
npm install @norkey/vault
npx norkey-vault build --rp-id localhost --api http://localhost:8787/norkey \
  --app-origin http://localhost:5173 --chains 11155111
npx norkey-vault serve --port 5174
```

Docs: the [quick start](https://github.com/xanderslabs/norkey/blob/main/docs/quickstart.md) and the
[vault CLI reference](https://github.com/xanderslabs/norkey/blob/main/docs/reference/vault-cli.md).
