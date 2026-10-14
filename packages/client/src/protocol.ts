/** The messages the app page and the boundary popup exchange. No message carries key material,
 *  and none carries a delegate address: the boundary page takes that from its own build config. */
export const PROTOCOL_VERSION = 3;

/** The most calls one request may carry. */
export const MAX_CALLS = 10;

/** Calls the app page prepared and the popup will show, encode and sign. Quantities are hex. */
export type PreparedCalls = {
  chainId: number;
  from: `0x${string}`;
  calls: { to: `0x${string}`; value: string; data: `0x${string}` }[];
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** The app's reading of eth_getCode: true when the account is not delegated to this chain's Calibur. */
  delegate: boolean;
};

/** A sponsored user operation the app prepared. The page encodes callData itself from `calls`, and
 *  hashes the operation itself: no message carries a hash or an EntryPoint. Quantities are hex. */
export type PreparedUserOp = {
  chainId: number;
  sender: `0x${string}`;
  calls: { to: `0x${string}`; value: string; data: `0x${string}` }[];
  /** EntryPoint nonce. */
  nonce: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster: `0x${string}`;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  /** Final, from pm_getPaymasterData (or the stub when it said isFinal). */
  paymasterData: `0x${string}`;
  /** The EOA's transaction nonce when the account is not delegated to this chain's Calibur; else null. */
  authorizationNonce: number | null;
};

/** A signed 7702 authorization as it crosses the channel. The delegate is always the page's Calibur. */
export type AuthorizationReply = {
  chainId: number;
  address: `0x${string}`;
  nonce: number;
  yParity: number;
  r: `0x${string}`;
  s: `0x${string}`;
};

export type PopupRequest =
  | { v: 3; id: string; kind: "connect" }
  | { v: 3; id: string; kind: "sign-calls"; calls: PreparedCalls }
  | { v: 3; id: string; kind: "sign-userop"; op: PreparedUserOp };

export type PopupReply =
  | { v: 3; id: string; ok: true; kind: "connect"; address: `0x${string}` }
  | { v: 3; id: string; ok: true; kind: "sign-calls"; raw: `0x${string}` }
  | {
      v: 3;
      id: string;
      ok: true;
      kind: "sign-userop";
      signature: `0x${string}`;
      authorization: AuthorizationReply | null;
    }
  | { v: 3; id: string; ok: false; code: 4001 | 4100 | 4900 | -32602 | -32603; message: string };

export type PopupReady = { v: 3; kind: "ready" };
