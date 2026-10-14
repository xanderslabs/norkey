import { createNorKeyProvider } from "@norkey/client";
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

const norkey = createNorKeyProvider({
  vaultOrigin,
  chains: Object.entries(rpcs).map(([id, url]) => ({ id: Number(id), rpcUrls: [url], gas: "native" as const })),
  defaultChainId: sepolia.id,
});
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

$("refresh").addEventListener("click", () => refresh().catch(report));

$("send").addEventListener("click", async () => {
  if (!account) return log("connect first");
  try {
    const to = ($("to") as HTMLInputElement).value.trim() as Address;
    const value = parseEther(($("amount") as HTMLInputElement).value.trim());
    const hash = await wallet.sendTransaction({ account, chain, to, value });
    log(`sent ${hash} ${chain.blockExplorers?.default.url}/tx/${hash}`);
    const receipt = await reader().waitForTransactionReceipt({ hash });
    log(`confirmed in block ${receipt.blockNumber} (${receipt.status})`);
    const sent = await reader().getTransaction({ hash });
    log(`type ${sent.type}${sent.type === "eip7702" ? " (delegated to Calibur in this transaction)" : ""}`);
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
