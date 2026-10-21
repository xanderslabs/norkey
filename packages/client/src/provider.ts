import {
  type Address,
  createPublicClient,
  fallback,
  type Hex,
  http,
  isAddress,
  isHex,
  numberToHex,
  type PublicClient,
  zeroAddress,
} from "viem";
import { CALIBUR_ADDRESS, type Call, isDelegatedTo } from "./calibur.js";
import { callsId, callsStatus, parseCallsId, userOpCallsStatus } from "./eip5792.js";
import { ProviderRpcError } from "./errors.js";
import { estimateCallsGas } from "./gas.js";
import { openPopup } from "./popup.js";
import { MAX_CALLS, type PopupReply, type PopupRequest, PROTOCOL_VERSION, type PreparedUserOp } from "./protocol.js";
import { prepareUserOp, SessionExpiredError, submitUserOp, waitForUserOpTransaction } from "./userop.js";

type ChainBase = {
  id: number;
  rpcUrls: string[];
  /** The delegate this provider checks for. Default: Uniswap's Calibur. The boundary page signs only
   *  for the address in its own build config, so this setting cannot redirect a delegation. Set it to
   *  the page's `--calibur` for this chain: if they differ, every send delegates again. */
  calibur?: Address;
};

export type NorKeyChain =
  | (ChainBase & { gas: "native" })
  | (ChainBase & {
      gas: "sponsored";
      /** The NorKey paymaster proxy for this chain, e.g. "/norkey/paymaster/11155111". A relative URL
       *  resolves against the app page. It serves both the paymaster and the bundler methods. */
      paymasterUrl: string;
    });

export type NorKeyProviderConfig = {
  /** The boundary page origin, e.g. "https://accounts.app.com". */
  vaultOrigin: string;
  /** The NorKey server handler's base, e.g. "/norkey", the same value the boundary page is built with
   *  (`--api`). A relative URL resolves against the app page. Disconnect calls `<apiUrl>/logout`. */
  apiUrl: string;
  chains: NorKeyChain[];
  defaultChainId: number;
  /** The app's wallet name, shown in wallet pickers (EIP-6963). */
  name: string;
  /** A `data:` URI. Defaults to a neutral wallet icon. */
  icon?: string;
  /** Names a new wallet's passkey in the browser's picker, e.g. the signed-in user's email. Called when
   *  the connect popup opens. Missing or blank gives the server's `rpName` and 6 random hex characters. */
  label?: () => string | undefined;
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
  // Passkeys and crypto.randomUUID need a secure context. Fail here with the cause, not later.
  if (globalThis.isSecureContext === false) {
    throw new Error("NorKey: serve the app over HTTPS or from localhost (this page is not a secure context)");
  }
  if (new URL(config.vaultOrigin).origin !== config.vaultOrigin) {
    throw new Error(`NorKey: vaultOrigin "${config.vaultOrigin}" must be a bare origin`);
  }
  if (typeof config.apiUrl !== "string" || config.apiUrl === "") {
    throw new Error('NorKey: apiUrl is required, e.g. "/norkey"');
  }
  if (!config.chains.some((c) => c.id === config.defaultChainId)) {
    throw new Error(`NorKey: defaultChainId ${config.defaultChainId} is not in chains`);
  }
  for (const c of config.chains) {
    if (c.rpcUrls.length === 0) throw new Error(`NorKey: chain ${c.id} has no rpcUrls`);
    if (c.gas === "sponsored") {
      if (typeof c.paymasterUrl !== "string" || c.paymasterUrl === "") {
        throw new Error(`NorKey: chain ${c.id} has gas "sponsored" but no paymasterUrl`);
      }
    } else if (c.gas !== "native") {
      // Unreachable for typed callers: this catches a gas value from untyped JavaScript.
      const bad = c as { id: number; gas: unknown };
      throw new Error(`NorKey: chain ${bad.id}: gas "${String(bad.gas)}" is not supported in this version`);
    }
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
function forget(): void {
  try {
    localStorage.removeItem(ADDRESS_KEY);
  } catch {}
}

export function createEip1193Provider(config: NorKeyProviderConfig): Eip1193Provider {
  validate(config);
  let chainId = config.defaultChainId;
  let address = load();
  const clients = new Map<number, PublicClient>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  /** The sponsored operation still pending, per "<chainId>:<account>". Two in a row would read the same
   *  EntryPoint nonce, and the bundler would refuse the second after the user approved it. In memory
   *  only: a reload or the end of the 60 second wait falls back to that refusal. */
  const pending = new Map<string, Hex>();
  const pendingKey = (id: number, account: string) => `${id}:${account.toLowerCase()}`;
  const clearPending = (hash: Hex) => {
    for (const [k, h] of pending) if (h.toLowerCase() === hash.toLowerCase()) pending.delete(k);
  };

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
  const proxyFor = (chain: NorKeyChain & { gas: "sponsored" }): string =>
    new URL(chain.paymasterUrl, globalThis.location?.href).href;
  const forgetAccount = () => {
    address = null;
    forget();
    emit("accountsChanged", []);
  };
  // Opens the popup synchronously (see openPopup), so call `ask` before awaiting anything.
  const ask = async <K extends PopupRequest["kind"]>(
    kind: K,
    prepare: (id: string) => Promise<PopupRequest & { kind: K }>,
  ) => {
    const id = crypto.randomUUID();
    const reply: PopupReply = await openPopup(config.vaultOrigin, id, () => prepare(id));
    if (!reply.ok) {
      // The popup replies 4100 when the app's user is signed out (custom mode). Forget the address so
      // the next app user does not get this one (slice 5, decision 15).
      if (reply.code === 4100) forgetAccount();
      throw new ProviderRpcError(reply.code, reply.message);
    }
    if (reply.kind !== kind) throw new ProviderRpcError(-32603, "The wallet replied to a different request.");
    return reply as Extract<PopupReply, { ok: true; kind: K }>;
  };

  /** The one send path for eth_sendTransaction and wallet_sendCalls. Nothing here awaits before
   *  `ask`, so the popup opens inside the click's user activation. */
  async function sendCalls(
    from: string | undefined,
    input: CallInput[],
  ): Promise<{ chainId: number; hash: Hex; op: boolean; landed?: Promise<Hex> }> {
    if (!address || from?.toLowerCase() !== address.toLowerCase()) {
      throw new ProviderRpcError(4100, "The requested account is not connected.");
    }
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CALLS) {
      throw new ProviderRpcError(-32602, `Send between 1 and ${MAX_CALLS} calls.`);
    }
    for (const c of input as unknown[]) {
      if (typeof c !== "object" || c === null) throw new ProviderRpcError(-32602, "A call is not an object.");
      const { to, value, data } = c as Record<string, unknown>;
      if (!to) throw new ProviderRpcError(-32602, "Contract creation is not supported.");
      if (typeof to !== "string" || !isAddress(to, { strict: false })) {
        throw new ProviderRpcError(-32602, "A call's recipient is not an address.");
      }
      // The boundary page refuses these too: as the account itself, a call could reach Calibur's admin functions.
      if (to.toLowerCase() === address.toLowerCase() || to.toLowerCase() === zeroAddress) {
        throw new ProviderRpcError(-32602, "A call to the wallet itself is not supported.");
      }
      if (value !== undefined && (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))) {
        throw new ProviderRpcError(-32602, "A call's value is not a hex quantity.");
      }
      if (data !== undefined && (typeof data !== "string" || !isHex(data) || data.length % 2 !== 0)) {
        throw new ProviderRpcError(-32602, "A call's data is not whole bytes of hex.");
      }
    }
    const sender = address;
    const id = chainId;
    const client = readerFor(id);
    const calibur = chainOf(id).calibur ?? CALIBUR_ADDRESS;
    const calls: Call[] = input.map((c) => ({
      to: c.to as Address,
      value: c.value ? BigInt(c.value) : 0n,
      data: c.data ?? "0x",
    }));
    const chain = chainOf(id);
    if (chain.gas === "sponsored") {
      // Refused before ask, so no popup opens and no passkey prompt is wasted.
      if (pending.has(pendingKey(id, sender))) {
        throw new ProviderRpcError(
          -32603,
          "Your last transaction on this chain is still pending. Try again when it lands.",
        );
      }
      const proxyUrl = proxyFor(chain);
      let prepared: PreparedUserOp | undefined;
      const reply = await ask("sign-userop", async (rid) => {
        prepared = await prepareUserOp({ client, proxyUrl, chainId: id, sender, calls, calibur });
        return { v: PROTOCOL_VERSION, id: rid, kind: "sign-userop", op: prepared };
      });
      // ask resolves only after prepare ran, so prepared is set.
      const hash = await submitUserOp(proxyUrl, prepared as PreparedUserOp, reply.signature, reply.authorization);
      pending.set(pendingKey(id, sender), hash);
      // One wait per operation: eth_sendTransaction returns it, wallet_sendCalls leaves it running in
      // the background. This handler is attached first, so the flag clears before the app sees the result.
      const landed = waitForUserOpTransaction(proxyUrl, hash, id);
      landed.then(
        () => clearPending(hash),
        () => clearPending(hash),
      );
      return { chainId: id, hash, op: true, landed };
    }
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
    return { chainId: id, hash: await client.sendRawTransaction({ serializedTransaction: raw }), op: false };
  }

  /** A 401 from the paymaster proxy, on any call, clears the cached address, so the next
   *  eth_requestAccounts opens the popup. */
  async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    try {
      return await dispatch(args);
    } catch (e) {
      if (e instanceof SessionExpiredError) forgetAccount();
      throw e;
    }
  }

  async function dispatch({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_accounts":
        return address ? [address] : [];
      case "eth_requestAccounts": {
        if (address) return [address];
        const label = config.label?.();
        const reply = await ask("connect", async (id) => ({
          v: PROTOCOL_VERSION,
          id,
          kind: "connect",
          ...(typeof label === "string" ? { label } : {}),
        }));
        address = reply.address;
        save(address);
        emit("connect", { chainId: numberToHex(chainId) });
        emit("accountsChanged", [address]);
        return [address];
      }
      case "wallet_revokePermissions": {
        // EIP-2255 disconnect. The page forgets the account even when the server call fails, then says so.
        let ended = false;
        try {
          const url = new URL(`${config.apiUrl.replace(/\/$/, "")}/logout`, globalThis.location?.href);
          ended = (await fetch(url.href, { method: "POST", credentials: "include" })).ok;
        } catch {}
        forgetAccount();
        if (!ended) {
          throw new ProviderRpcError(-32603, "Disconnected on this page, but the server session could not be ended.");
        }
        return null;
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
        const sent = await sendCalls(tx.from, [tx]);
        return sent.landed ?? sent.hash;
      }
      case "wallet_sendCalls": {
        const p = (params[0] ?? {}) as {
          chainId?: Hex;
          from?: string;
          calls?: CallInput[];
          capabilities?: Record<string, { optional?: boolean } | undefined>;
        };
        if (p.chainId !== undefined && Number(p.chainId) !== chainId) {
          throw new ProviderRpcError(4902, `Switch to chain ${Number(p.chainId)} before sending calls to it.`);
        }
        for (const [name, cap] of Object.entries(p.capabilities ?? {})) {
          if (!cap?.optional) throw new ProviderRpcError(5700, `The capability "${name}" is not supported.`);
        }
        // Every batch is atomic (Calibur BATCHED_CALL), so atomicRequired is always met.
        const sent = await sendCalls(p.from ?? address ?? undefined, p.calls ?? []);
        return { id: callsId(sent.chainId, sent.hash, sent.op) };
      }
      case "wallet_getCallsStatus": {
        const parsed = parseCallsId(params[0]);
        if (!parsed || !config.chains.some((c) => c.id === parsed.chainId)) {
          throw new ProviderRpcError(5730, "Unknown bundle id.");
        }
        const chain = chainOf(parsed.chainId);
        if (parsed.op) {
          if (chain.gas !== "sponsored") throw new ProviderRpcError(5730, "Unknown bundle id.");
          const status = await userOpCallsStatus(proxyFor(chain), params[0] as string, parsed.chainId, parsed.hash);
          // The app can see the operation land before the background wait does.
          if (status.status !== 100) clearPending(parsed.hash);
          return status;
        }
        return callsStatus(readerFor(parsed.chainId), params[0] as string, parsed.chainId, parsed.hash);
      }
      case "wallet_getCapabilities": {
        const requested = (params[1] as Hex[] | undefined)?.map((h) => Number(h)) ?? config.chains.map((c) => c.id);
        const out: Record<string, unknown> = {};
        for (const id of requested) {
          if (config.chains.some((c) => c.id === id)) out[numberToHex(id)] = { atomic: { status: "supported" } };
        }
        return out;
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
