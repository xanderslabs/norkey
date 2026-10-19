import { createNorKeyProvider, type NorKeyChain } from "@norkey/client";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  type PublicClient,
  parseEther,
} from "viem";
import { sepolia, unichainSepolia } from "viem/chains";

const rpcs: Record<number, string> = {
  [sepolia.id]: import.meta.env.VITE_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
  [unichainSepolia.id]: import.meta.env.VITE_UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org",
};
const chains: Record<number, Chain> = { [sepolia.id]: sepolia, [unichainSepolia.id]: unichainSepolia };
const vaultOrigin: string = import.meta.env.VITE_VAULT_ORIGIN ?? "http://localhost:5174";

// Comma-separated chain ids whose sends the paymaster pays for, e.g. "11155111".
const sponsored = new Set((import.meta.env.VITE_SPONSORED ?? "").split(",").filter(Boolean).map(Number));
const api: string = import.meta.env.VITE_API ?? "http://localhost:8787/norkey";
const norkeyChains = Object.entries(rpcs).map(
  ([id, url]): NorKeyChain =>
    sponsored.has(Number(id))
      ? { id: Number(id), rpcUrls: [url], gas: "sponsored", paymasterUrl: `${api}/paymaster/${id}` }
      : { id: Number(id), rpcUrls: [url], gas: "native" },
);
const norkey = createNorKeyProvider({ vaultOrigin, apiUrl: api, chains: norkeyChains, defaultChainId: sepolia.id });
const wallet = createWalletClient({ transport: custom(norkey) });
const readers = new Map<number, PublicClient>();
let chain: Chain = sepolia;
const reader = (): PublicClient => {
  let r = readers.get(chain.id);
  if (!r) {
    r = createPublicClient({ chain, transport: http(rpcs[chain.id]) }) as PublicClient;
    readers.set(chain.id, r);
  }
  return r;
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
// The boundary page opened with no opener is the settings page: add a passkey, export the key.
($("settings") as HTMLAnchorElement).href = vaultOrigin;
const log = (line: string) => {
  $("log").textContent += `${line}\n`;
};
let account: Address | undefined;

async function refresh(): Promise<void> {
  if (!account) return;
  $("balance").textContent = `${formatEther(await reader().getBalance({ address: account }))} ETH`;
}

function report(e: unknown): void {
  const err = e as { code?: number; message?: string; cause?: { code?: number } };
  const code = err.code ?? err.cause?.code;
  log(`error ${code ?? ""}: ${err.message ?? String(e)}`);
}

$("connect").addEventListener("click", async () => {
  try {
    [account] = await wallet.requestAddresses();
    $("address").textContent = account;
    log(`connected ${account}`);
    await refresh();
  } catch (e) {
    report(e);
  }
});

$("disconnect").addEventListener("click", async () => {
  try {
    await norkey.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    log("disconnected");
  } catch (e) {
    report(e);
  } finally {
    // The provider forgets the account even when the server call fails.
    account = undefined;
    $("address").textContent = "not connected";
    $("balance").textContent = "-";
  }
});

$("refresh").addEventListener("click", () => refresh().catch(report));

// A stub app login for custom auth mode (VITE_CUSTOM_AUTH=1, with custom-server.mjs). The NorKey server
// reads the app's user from the demo_user cookie. A real app sets this cookie from its server,
// HttpOnly, with Domain=<registrable domain> so it reaches the NorKey handler from the boundary page's
// origin too. On localhost a cookie is shared across ports, so this one set by the page is enough.
if (import.meta.env.VITE_CUSTOM_AUTH === "1") {
  $("app-login").hidden = false;
  const showAppUser = () => {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith("demo_user="))
      ?.slice("demo_user=".length);
    $("app-current").textContent = raw ? decodeURIComponent(raw) : "signed out";
  };
  showAppUser();
  $("app-sign-in").addEventListener("click", () => {
    const name = ($("app-user") as HTMLInputElement).value.trim();
    if (!name) return log("type an app user name first");
    document.cookie = `demo_user=${encodeURIComponent(name)}; Path=/; SameSite=Lax`;
    showAppUser();
    log(`app user ${name} signed in`);
  });
  $("app-sign-out").addEventListener("click", async () => {
    // An app in custom mode disconnects NorKey on sign-out, so the next user does not get this
    // user's address (slice 5, decision 15).
    try {
      await norkey.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {}
    document.cookie = "demo_user=; Path=/; Max-Age=0; SameSite=Lax";
    account = undefined;
    $("address").textContent = "not connected";
    $("balance").textContent = "-";
    showAppUser();
    log("app user signed out");
  });
}

$("send").addEventListener("click", async () => {
  if (!account) return log("connect first");
  try {
    const to = ($("to") as HTMLInputElement).value.trim() as Address;
    const value = parseEther(($("amount") as HTMLInputElement).value.trim());
    // Nothing is awaited before sendTransaction, so the popup opens inside the click's user activation.
    const hash = await wallet.sendTransaction({ account, chain, to, value });
    log(`sent ${hash} ${chain.blockExplorers?.default.url}/tx/${hash}`);
    const receipt = await reader().waitForTransactionReceipt({ hash });
    log(`confirmed in block ${receipt.blockNumber} (${receipt.status})`);
    const sent = await reader().getTransaction({ hash });
    log(`type ${sent.type}${sent.type === "eip7702" ? " (delegated to Calibur in this transaction)" : ""}`);
    const before = await reader().getBalance({ address: account, blockNumber: receipt.blockNumber - 1n });
    const after = await reader().getBalance({ address: account, blockNumber: receipt.blockNumber });
    log(`ETH spent on gas: ${formatEther(before - after - value)}`);
    await refresh();
  } catch (e) {
    report(e);
  }
});

$("batch").addEventListener("click", async () => {
  if (!account) return log("connect first");
  try {
    const value = parseEther(($("amount") as HTMLInputElement).value.trim());
    const recipients = [($("to") as HTMLInputElement).value.trim(), ($("to2") as HTMLInputElement).value.trim()];
    const { id } = await wallet.sendCalls({
      account,
      chain,
      calls: recipients.map((to) => ({ to: to as Address, value })),
    });
    log(`batch ${id}`);
    const status = await wallet.waitForCallsStatus({ id });
    const hash = status.receipts?.[0]?.transactionHash;
    log(`batch ${status.status} in block ${status.receipts?.[0]?.blockNumber}`);
    if (hash) {
      const sent = await reader().getTransaction({ hash });
      log(`type ${sent.type}${sent.type === "eip7702" ? " (delegated to Calibur in this transaction)" : ""}`);
    }
    await refresh();
  } catch (e) {
    report(e);
  }
});

$("chain").addEventListener("change", async (e) => {
  try {
    const id = Number((e.target as HTMLSelectElement).value);
    await wallet.switchChain({ id });
    chain = chains[id] as Chain;
    log(`switched to ${chain.name}`);
    await refresh();
  } catch (err) {
    report(err);
  }
});

(async () => {
  const [existing] = (await norkey.request({ method: "eth_accounts" })) as Address[];
  if (existing) {
    account = existing;
    $("address").textContent = existing;
    await refresh();
  }
})().catch(report);
