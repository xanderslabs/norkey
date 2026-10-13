import { type Address, createPublicClient, fallback, type Hex, http, numberToHex, type PublicClient } from "viem";
import { CALIBUR_ADDRESS, type Call, isDelegatedTo } from "./calibur.js";
import { ProviderRpcError } from "./errors.js";
import { estimateCallsGas } from "./gas.js";
import { openPopup } from "./popup.js";
import { MAX_CALLS, type PopupReply, type PopupRequest, PROTOCOL_VERSION } from "./protocol.js";

export type NorKeyChain = {
  id: number;
  rpcUrls: string[];
  gas: "native";
  /** The delegate this provider checks for. Default: Uniswap's Calibur. The boundary page signs only
   *  for the address in its own build config, so this setting cannot redirect a delegation. */
  calibur?: Address;
};

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

type CallInput = { to?: Address; value?: Hex; data?: Hex };

const ADDRESS_KEY = "norkey:address";
const UNSUPPORTED = new Set(["personal_sign", "eth_sign", "eth_signTypedData_v4", "wallet_showCallsStatus"]);

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
  const chainOf = (id: number): NorKeyChain => config.chains.find((x) => x.id === id) as NorKeyChain;
  const readerFor = (id: number): PublicClient => {
    let c = clients.get(id);
    if (!c) {
      c = createPublicClient({ transport: fallback(chainOf(id).rpcUrls.map((u) => http(u))) }) as PublicClient;
      clients.set(id, c);
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

  /** The one send path for eth_sendTransaction and wallet_sendCalls. Nothing here awaits before
   *  `ask`, so the popup opens inside the click's user activation. */
  async function sendCalls(from: string | undefined, input: CallInput[]): Promise<{ chainId: number; hash: Hex }> {
    if (!address || from?.toLowerCase() !== address.toLowerCase()) {
      throw new ProviderRpcError(4100, "The requested account is not connected.");
    }
    if (input.length === 0 || input.length > MAX_CALLS) {
      throw new ProviderRpcError(-32602, `Send between 1 and ${MAX_CALLS} calls.`);
    }
    if (input.some((c) => !c.to)) throw new ProviderRpcError(-32602, "Contract creation is not supported.");
    const sender = address;
    const id = chainId;
    const client = readerFor(id);
    const calibur = chainOf(id).calibur ?? CALIBUR_ADDRESS;
    const calls: Call[] = input.map((c) => ({
      to: c.to as Address,
      value: c.value ? BigInt(c.value) : 0n,
      data: c.data ?? "0x",
    }));
    const { raw } = await ask("sign-calls", async (rid) => {
      const [code, nonce, fees] = await Promise.all([
        client.getCode({ address: sender }),
        client.getTransactionCount({ address: sender, blockTag: "pending" }),
        client.estimateFeesPerGas(),
      ]);
      const delegate = !isDelegatedTo(code, calibur);
      const gas = await estimateCallsGas(client, { from: sender, calls, delegate, calibur });
      return {
        v: PROTOCOL_VERSION,
        id: rid,
        kind: "sign-calls",
        calls: {
          chainId: id,
          from: sender,
          calls: calls.map((c) => ({ to: c.to, value: numberToHex(c.value), data: c.data })),
          nonce,
          gas: numberToHex(gas),
          maxFeePerGas: numberToHex(fees.maxFeePerGas),
          maxPriorityFeePerGas: numberToHex(fees.maxPriorityFeePerGas),
          delegate,
        },
      };
    });
    return { chainId: id, hash: await client.sendRawTransaction({ serializedTransaction: raw }) };
  }

  async function request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_accounts":
        return address ? [address] : [];
      case "eth_requestAccounts": {
        if (address) return [address];
        const reply = await ask("connect", async (id) => ({ v: PROTOCOL_VERSION, id, kind: "connect" }));
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
      case "eth_sendTransaction": {
        const tx = (params[0] ?? {}) as CallInput & { from?: string };
        return (await sendCalls(tx.from, [tx])).hash;
      }
      default:
        if (UNSUPPORTED.has(method)) throw new ProviderRpcError(4200, `${method} is not supported yet`);
        return readerFor(chainId).request({ method, params } as never);
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
