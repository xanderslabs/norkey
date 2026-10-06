import { type Address, createPublicClient, fallback, type Hex, http, numberToHex, type PublicClient } from "viem";
import { ProviderRpcError } from "./errors.js";
import { openPopup } from "./popup.js";
import type { PopupReply, PopupRequest, PreparedTx } from "./protocol.js";

export type NorKeyChain = { id: number; rpcUrls: string[]; gas: "native" };

export type NorKeyProviderConfig = {
  /** The boundary page origin, e.g. "https://accounts.app.com". */
  vaultOrigin: string;
  chains: NorKeyChain[];
  defaultChainId: number;
};

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

const ADDRESS_KEY = "norkey:address";
const SIGNING_METHODS = new Set(["personal_sign", "eth_sign", "eth_signTypedData_v4", "wallet_sendCalls"]);

function validate(config: NorKeyProviderConfig): void {
  if (new URL(config.vaultOrigin).origin !== config.vaultOrigin) {
    throw new Error(`NorKey: vaultOrigin "${config.vaultOrigin}" must be a bare origin`);
  }
  if (!config.chains.some((c) => c.id === config.defaultChainId)) {
    throw new Error(`NorKey: defaultChainId ${config.defaultChainId} is not in chains`);
  }
  for (const c of config.chains) {
    if (c.rpcUrls.length === 0) throw new Error(`NorKey: chain ${c.id} has no rpcUrls`);
    if (c.gas !== "native") throw new Error(`NorKey: chain ${c.id}: only gas "native" is supported in this version`);
  }
}

function load(): Address | null {
  try {
    return (localStorage.getItem(ADDRESS_KEY) as Address | null) ?? null;
  } catch {
    return null;
  }
}
function save(address: Address): void {
  try {
    localStorage.setItem(ADDRESS_KEY, address);
  } catch {}
}

export function createEip1193Provider(config: NorKeyProviderConfig): Eip1193Provider {
  validate(config);
  let chainId = config.defaultChainId;
  let address = load();
  const clients = new Map<number, PublicClient>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const emit = (event: string, ...args: unknown[]) => {
    for (const l of [...(listeners.get(event) ?? [])]) l(...args);
  };
  const reader = (): PublicClient => {
    let c = clients.get(chainId);
    if (!c) {
      const chain = config.chains.find((x) => x.id === chainId) as NorKeyChain;
      c = createPublicClient({ transport: fallback(chain.rpcUrls.map((u) => http(u))) }) as PublicClient;
      clients.set(chainId, c);
    }
    return c;
  };
  // Opens the popup synchronously (see openPopup), so call `ask` before awaiting anything.
  const ask = async <K extends PopupRequest["kind"]>(
    kind: K,
    prepare: (id: string) => Promise<PopupRequest & { kind: K }>,
  ) => {
    const id = crypto.randomUUID();
    const reply: PopupReply = await openPopup(config.vaultOrigin, id, () => prepare(id));
    if (!reply.ok) throw new ProviderRpcError(reply.code, reply.message);
    if (reply.kind !== kind) throw new ProviderRpcError(-32603, "The wallet replied to a different request.");
    return reply as Extract<PopupReply, { ok: true; kind: K }>;
  };

  async function sendTransaction(params: unknown[]): Promise<Hex> {
    const tx = (params[0] ?? {}) as { from?: string; to?: Address; value?: Hex; data?: Hex };
    if (!address || tx.from?.toLowerCase() !== address.toLowerCase()) {
      throw new ProviderRpcError(4100, "The requested account is not connected.");
    }
    if (!tx.to) throw new ProviderRpcError(-32602, "Contract creation is not supported.");
    const client = reader();
    const to = tx.to;
    const from = address;
    const value = tx.value ? BigInt(tx.value) : 0n;
    const data = tx.data ?? "0x";
    const { raw } = await ask("sign-tx", async (id) => {
      const [nonce, gas, fees] = await Promise.all([
        client.getTransactionCount({ address: from, blockTag: "pending" }),
        client.estimateGas({ account: from, to, value, data }),
        client.estimateFeesPerGas(),
      ]);
      const prepared: PreparedTx = {
        chainId,
        from,
        to,
        value: numberToHex(value),
        data,
        nonce,
        gas: numberToHex(gas),
        maxFeePerGas: numberToHex(fees.maxFeePerGas),
        maxPriorityFeePerGas: numberToHex(fees.maxPriorityFeePerGas),
      };
      return { v: 1, id, kind: "sign-tx", tx: prepared };
    });
    return client.sendRawTransaction({ serializedTransaction: raw });
  }

  async function request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_accounts":
        return address ? [address] : [];
      case "eth_requestAccounts": {
        if (address) return [address];
        const reply = await ask("connect", async (id) => ({ v: 1, id, kind: "connect" }));
        address = reply.address;
        save(address);
        emit("connect", { chainId: numberToHex(chainId) });
        emit("accountsChanged", [address]);
        return [address];
      }
      case "wallet_switchEthereumChain": {
        const id = Number((params[0] as { chainId?: string } | undefined)?.chainId);
        if (!config.chains.some((c) => c.id === id)) throw new ProviderRpcError(4902, "Chain not configured");
        if (id !== chainId) {
          chainId = id;
          emit("chainChanged", numberToHex(chainId));
        }
        return null;
      }
      case "eth_sendTransaction":
        return sendTransaction(params);
      default:
        if (SIGNING_METHODS.has(method)) throw new ProviderRpcError(4200, `${method} is not supported yet`);
        return reader().request({ method, params } as never);
    }
  }

  return {
    request,
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
}
