# Quick start

In this tutorial, you build a small web app that creates a wallet with a passkey and sends Sepolia
ETH from it. Everything runs on your machine, in three processes:

- The server, on port 8787. It stores users, passkey credentials and the encrypted wallet key in
  SQLite.
- The boundary page, on port 5174. It is the only page that decrypts the wallet key. The app opens
  it as a popup.
- Your app, a Vite page that uses wagmi, on port 5173.

## Before you begin

- Install Node.js 24 or later.
- Use Chrome, or another browser with a passkey provider that supports the WebAuthn PRF extension,
  such as iCloud Keychain or Google Password Manager.
- For the last step, get some Sepolia ETH from a faucet.

## Create the project

Create a folder and install the three NorKey packages, wagmi, viem and Vite:

```sh
mkdir my-app && cd my-app
npm init -y
npm install @norkey/client @norkey/server @norkey/vault
npm install @wagmi/core viem
npm install -D vite
```

## Start the server

In `my-app`, start the server:

```sh
NORKEY_RP_ID=localhost NORKEY_RP_NAME="My App" NORKEY_ORIGINS=http://localhost:5174 \
NORKEY_APP_ORIGINS=http://localhost:5173 npx --no-install norkey serve
```

The `--no-install` flag makes npx run only the package installed in this folder. It never downloads
another package with the same name.

The server prints `norkey listening on :8787`. It keeps its data in `./norkey.db`.

- `NORKEY_RP_ID` is the WebAuthn relying party ID. On your machine, it is `localhost`.
- `NORKEY_RP_NAME` is your app's name. New passkeys are named after it.
- `NORKEY_ORIGINS` is the boundary page's origin. Only that origin may create a wallet or open it.
- `NORKEY_APP_ORIGINS` is your app's origin. It lets the app end the server session, for example
  when the user disconnects.

Leave the server running. In another terminal, check that it answers:

```sh
curl http://localhost:8787/norkey/status
```

The answer is `{"mode":"passkey"}`.

## Build and serve the boundary page

In a second terminal, in `my-app`, build the boundary page and serve it:

```sh
npx --no-install norkey-vault build --rp-id localhost --api http://localhost:8787/norkey \
  --app-origin http://localhost:5173 --chains 11155111 --rp-name "My App"
npx --no-install norkey-vault serve --port 5174
```

The build writes the page to `dist-vault`, with the settings baked in, and prints
`norkey-vault: wrote dist-vault/index.html and _headers`. The second command prints
`norkey-vault serving dist-vault on :5174`. Leave it running.

- `--api` is the absolute URL of the server. The page's Content Security Policy allows requests to
  that origin only.
- `--app-origin` is your app's origin. The page refuses requests from any other origin.
- `--chains 11155111` is Sepolia, the one chain this page signs for.

## Write the app

Create `index.html` in `my-app`:

```html
<!doctype html>
<html>
  <body>
    <button id="connect">Connect</button>
    <p>Address: <span id="address">not connected</span></p>
    <p>Balance: <span id="balance"></span></p>
    <input id="to" placeholder="Recipient address" size="44" />
    <button id="send">Send 0.0001 ETH</button>
    <pre id="log"></pre>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `src/main.ts`:

```ts
import { createNorKeyProvider } from "@norkey/client";
import { connect, createConfig, getBalance, getConnectors, http, sendTransaction, waitForTransactionReceipt } from "@wagmi/core";
import { sepolia } from "@wagmi/core/chains";
import { formatEther, parseEther } from "viem";

const NAME = "My App";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";

// Create the provider before the wagmi config, so wagmi finds it through EIP-6963.
createNorKeyProvider({
  name: NAME,
  vaultOrigin: "http://localhost:5174",
  apiUrl: "http://localhost:8787/norkey",
  chains: [{ id: sepolia.id, rpcUrls: [RPC], gas: "native" }],
  defaultChainId: sepolia.id,
});

const config = createConfig({ chains: [sepolia], transports: { [sepolia.id]: http(RPC) } });

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const log = (line: string) => {
  $("log").textContent += `${line}\n`;
};
let address: `0x${string}` | undefined;

async function showBalance() {
  if (!address) return;
  const { value } = await getBalance(config, { address });
  $("balance").textContent = `${formatEther(value)} ETH`;
}

$("connect").onclick = async () => {
  try {
    const connector = getConnectors(config).find((c) => c.name === NAME);
    if (!connector) throw new Error(`${NAME} wallet not found`);
    const result = await connect(config, { connector });
    address = result.accounts[0];
    $("address").textContent = address;
    await showBalance();
  } catch (e) {
    log(`error: ${(e as Error).message}`);
  }
};

$("send").onclick = async () => {
  try {
    const hash = await sendTransaction(config, { to: $("to").value as `0x${string}`, value: parseEther("0.0001") });
    log(`sent ${hash}`);
    await waitForTransactionReceipt(config, { hash });
    log("confirmed");
    await showBalance();
  } catch (e) {
    log(`error: ${(e as Error).message}`);
  }
};
```

`createNorKeyProvider` returns an EIP-1193 provider and announces it through EIP-6963 under
`name`. wagmi listens for these announcements by default and adds the wallet to its connectors, so
the app finds it by name.

- `vaultOrigin` is the boundary page's origin, where the popup opens.
- `apiUrl` is the server. The app runs on another port, so it is an absolute URL here.
- `gas: "native"` means the wallet pays its own gas.

In a third terminal, in `my-app`, start Vite:

```sh
npx vite --port 5173 --strictPort
```

## Create a wallet

1. Open http://localhost:5173 in your browser.
2. Click **Connect**. A popup titled **My App wallet** opens and says
   "http://localhost:5173 wants to connect your My App wallet."
3. Click **Create a new wallet**, and follow your browser's passkey prompts.
4. The popup offers to add a backup passkey. Click **Skip** for now.

The popup closes. The app shows the wallet's address and a balance of `0 ETH`.

## Send Sepolia ETH

1. Send some Sepolia ETH from a faucet to the address the app shows.
2. Reload the app and click **Connect**. The provider remembers the address, so no popup opens, and
   the app shows the new balance.
3. Paste a recipient address into the box. It cannot be the wallet's own address.
4. Click **Send 0.0001 ETH**. The popup shows **Approve transaction**, with the chain, the
   recipient, the amount and the maximum network fee. This first send on Sepolia also upgrades the
   wallet with Uniswap's Calibur contract through EIP-7702, and the popup says so.
5. Click **Approve with passkey**, and use your passkey.

The app logs `sent` with the transaction hash, then `confirmed`.

## Next steps

- Open http://localhost:5174 directly to reach the wallet settings page. There you can add a backup
  passkey, test a passkey, or export the wallet key.
- [Deploy](deploy.md) the server and the boundary page on your own domain.
- Use your app's own sign-in with [custom auth](custom-auth.md).
- Pay your users' gas with a [paymaster](sponsored-gas.md).
- Store data in [Postgres](postgres.md).
- Read the [security model](security.md) before real funds go into a wallet.
- Look up every option in the [client](reference/client.md), [server](reference/server.md) and
  [vault CLI](reference/vault-cli.md) references.
