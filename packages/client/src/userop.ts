import { type Address, type Hex, numberToHex, type PublicClient, parseAbi, type SignedAuthorization } from "viem";
import { formatUserOperationRequest, type UserOperation } from "viem/account-abstraction";
import { type Call, ENTRY_POINT, encodeExecuteUserOp, isDelegatedTo, userOperationFrom } from "./calibur.js";
import { ProviderRpcError } from "./errors.js";
import type { AuthorizationReply, PreparedUserOp } from "./protocol.js";

/** The proxy needs the NorKey session cookie, and it has expired. The provider forgets the address. */
export class SessionExpiredError extends ProviderRpcError {
  constructor() {
    super(4100, "Your wallet session expired. Connect again.");
    this.name = "SessionExpiredError";
  }
}

/** A 65-byte signature of the right shape, so the gas estimate covers real verification. */
const STUB_SIGNATURE: Hex = `0x${"fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7"}${"7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7"}1b`;
const GET_NONCE = parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]);

type PaymasterFields = {
  paymaster?: Address;
  paymasterData?: Hex;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
  isFinal?: boolean;
};
type GasFields = {
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  paymasterVerificationGasLimit?: Hex;
};
export type RpcUserOpReceipt = {
  success: boolean;
  receipt: {
    logs: { address: Hex; data: Hex; topics: Hex[] }[];
    status: Hex;
    blockHash: Hex;
    blockNumber: Hex;
    gasUsed: Hex;
    transactionHash: Hex;
  };
};

/** One JSON-RPC call through the NorKey paymaster proxy, with the session cookie. */
async function proxyRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw new ProviderRpcError(-32603, "The paymaster proxy did not answer.");
  }
  if (res.status === 401) throw new SessionExpiredError();
  if (res.status === 403) throw new ProviderRpcError(4100, "This app does not sponsor this transaction.");
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
  // A JSON-RPC error object is the paymaster's or bundler's refusal, relayed whatever the HTTP status.
  // The proxy's own failures (400, 404, 500) carry a plain string instead and fall through to the status.
  const error = body?.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    throw new ProviderRpcError(
      -32603,
      `The paymaster or bundler refused: ${typeof message === "string" ? message : "no reason given"}`,
    );
  }
  if (!res.ok || !body) throw new ProviderRpcError(-32603, `The paymaster proxy answered ${res.status}.`);
  return body.result;
}

/** Stands in for the authorization until the boundary page signs the real one. Candide's public
 *  bundler and paymaster on Sepolia, and Alto with Pimlico's mock paymaster, accept it. A state
 *  override in its place does not work: Candide's paymaster refuses it. It leaves the userOpHash as
 *  it is: with no factory field, viem 2.57 hashes an empty initCode, so the hash covers no part of
 *  the authorization. */
function placeholderAuthorization(calibur: Address, chainId: number, nonce: number): SignedAuthorization {
  return { address: calibur, chainId, nonce, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 0 };
}

function withPaymaster(op: UserOperation<"0.8">, r: PaymasterFields | null): UserOperation<"0.8"> {
  if (!r?.paymaster) throw new ProviderRpcError(-32603, "The paymaster returned no paymaster address.");
  return {
    ...op,
    paymaster: r.paymaster,
    paymasterData: r.paymasterData ?? "0x",
    paymasterVerificationGasLimit: r.paymasterVerificationGasLimit
      ? BigInt(r.paymasterVerificationGasLimit)
      : (op.paymasterVerificationGasLimit ?? 0n),
    paymasterPostOpGasLimit: r.paymasterPostOpGasLimit
      ? BigInt(r.paymasterPostOpGasLimit)
      : (op.paymasterPostOpGasLimit ?? 0n),
  };
}

/**
 * Build a sponsored user operation for the boundary page: chain reads, then the ERC-7677 stub, the
 * bundler's gas estimate, and the final paymaster data, all through the proxy. The page signs after
 * this, because the v0.8 hash covers the final paymaster data.
 */
export async function prepareUserOp(a: {
  client: PublicClient;
  proxyUrl: string;
  chainId: number;
  sender: Address;
  calls: Call[];
  calibur: Address;
}): Promise<PreparedUserOp> {
  const [code, eoaNonce, nonce, fees] = await Promise.all([
    a.client.getCode({ address: a.sender }),
    a.client.getTransactionCount({ address: a.sender, blockTag: "pending" }),
    a.client.readContract({ address: ENTRY_POINT, abi: GET_NONCE, functionName: "getNonce", args: [a.sender, 0n] }),
    a.client.estimateFeesPerGas(),
  ]);
  const authorizationNonce = isDelegatedTo(code, a.calibur) ? null : eoaNonce;
  const hexChain = numberToHex(a.chainId);
  let op: UserOperation<"0.8"> = {
    sender: a.sender,
    nonce,
    callData: encodeExecuteUserOp(a.calls),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    // Twice the estimate leaves room for a rising base fee. The sponsor pays only what is used.
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: STUB_SIGNATURE,
    ...(authorizationNonce === null
      ? {}
      : { authorization: placeholderAuthorization(a.calibur, a.chainId, authorizationNonce) }),
  };
  // The proxy replaces this empty context with the server's.
  const stub = (await proxyRpc(a.proxyUrl, "pm_getPaymasterStubData", [
    formatUserOperationRequest(op),
    ENTRY_POINT,
    hexChain,
    {},
  ])) as PaymasterFields | null;
  op = withPaymaster(op, stub);
  const gas = (await proxyRpc(a.proxyUrl, "eth_estimateUserOperationGas", [
    formatUserOperationRequest(op),
    ENTRY_POINT,
  ])) as GasFields;
  op = {
    ...op,
    callGasLimit: BigInt(gas.callGasLimit),
    verificationGasLimit: BigInt(gas.verificationGasLimit),
    preVerificationGas: BigInt(gas.preVerificationGas),
    // The post-op limit stays the paymaster's: Alto's estimate returned 0x1 for it in testing.
    ...(gas.paymasterVerificationGasLimit
      ? { paymasterVerificationGasLimit: BigInt(gas.paymasterVerificationGasLimit) }
      : {}),
  };
  if (!stub?.isFinal) {
    const final = (await proxyRpc(a.proxyUrl, "pm_getPaymasterData", [
      formatUserOperationRequest(op),
      ENTRY_POINT,
      hexChain,
      {},
    ])) as PaymasterFields | null;
    op = withPaymaster(op, final);
  }
  return {
    chainId: a.chainId,
    sender: a.sender,
    calls: a.calls.map((c) => ({ to: c.to, value: numberToHex(c.value), data: c.data })),
    nonce: numberToHex(op.nonce),
    callGasLimit: numberToHex(op.callGasLimit),
    verificationGasLimit: numberToHex(op.verificationGasLimit),
    preVerificationGas: numberToHex(op.preVerificationGas),
    maxFeePerGas: numberToHex(op.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(op.maxPriorityFeePerGas),
    paymaster: op.paymaster as Address,
    paymasterVerificationGasLimit: numberToHex(op.paymasterVerificationGasLimit ?? 0n),
    paymasterPostOpGasLimit: numberToHex(op.paymasterPostOpGasLimit ?? 0n),
    paymasterData: op.paymasterData ?? "0x",
    authorizationNonce,
  };
}

/** Submit what the page signed. Built with userOperationFrom, as the page built it. */
export async function submitUserOp(
  proxyUrl: string,
  p: PreparedUserOp,
  signature: Hex,
  authorization: AuthorizationReply | null,
): Promise<Hex> {
  const op = { ...userOperationFrom(p, authorization ?? undefined), signature };
  return (await proxyRpc(proxyUrl, "eth_sendUserOperation", [formatUserOperationRequest(op), ENTRY_POINT])) as Hex;
}

export async function getUserOpReceipt(proxyUrl: string, hash: Hex): Promise<RpcUserOpReceipt | null> {
  return (await proxyRpc(proxyUrl, "eth_getUserOperationReceipt", [hash])) as RpcUserOpReceipt | null;
}

/** eth_sendTransaction must return a transaction hash: wait up to 60 s for the bundle that holds the
 *  operation. A bundle can succeed while the operation inside reverts, so that throws. The operation
 *  is already sent, so a failed status check (a 401 included) does not end the wait: only the deadline
 *  does. A 401 here must not reach request() as SessionExpiredError, or the payment that may land
 *  would forget the account. */
export async function waitForUserOpTransaction(proxyUrl: string, hash: Hex, chainId: number): Promise<Hex> {
  for (let i = 0; i < 30; i++) {
    const r = await getUserOpReceipt(proxyUrl, hash).catch(() => null);
    if (r) {
      if (!r.success) {
        throw new ProviderRpcError(
          -32603,
          `The user operation reverted on chain in transaction ${r.receipt.transactionHash}.`,
        );
      }
      return r.receipt.transactionHash;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Formatted as callsId in eip5792.ts formats it. Importing it here would be an import cycle.
  throw new ProviderRpcError(
    -32603,
    `The user operation ${hash} was not bundled within 60 seconds. Check it later with wallet_getCallsStatus and the id ${numberToHex(chainId)}:op:${hash}.`,
  );
}
