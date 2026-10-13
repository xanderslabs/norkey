import { createNorKeyProvider } from "@norkey/client";
import { type Address, createPublicClient, createWalletClient, custom, formatEther, http, parseEther } from "viem";
import { sepolia } from "viem/chains";

const rpc: string = import.meta.env.VITE_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const vaultOrigin: string = import.meta.env.VITE_VAULT_ORIGIN ?? "http://localhost:5174";

const norkey = createNorKeyProvider({
  vaultOrigin,
  chains: [{ id: sepolia.id, rpcUrls: [rpc], gas: "native" }],
  defaultChainId: sepolia.id,
});
const wallet = createWalletClient({ chain: sepolia, transport: custom(norkey) });
const reader = createPublicClient({ chain: sepolia, transport: http(rpc) });

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const log = (line: string) => {
  $("log").textContent += `${line}\n`;
};
let account: Address | undefined;

async function refresh(): Promise<void> {
  if (!account) return;
  $("balance").textContent = `${formatEther(await reader.getBalance({ address: account }))} ETH`;
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
    const hash = await wallet.sendTransaction({ account, to, value });
    log(`sent ${hash} https://sepolia.etherscan.io/tx/${hash}`);
    const receipt = await reader.waitForTransactionReceipt({ hash });
    log(`confirmed in block ${receipt.blockNumber} (${receipt.status})`);
    const sent = await reader.getTransaction({ hash });
    log(`type ${sent.type}${sent.type === "eip7702" ? " (first send on this chain: delegated to Calibur)" : ""}`);
    await refresh();
  } catch (e) {
    report(e);
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
