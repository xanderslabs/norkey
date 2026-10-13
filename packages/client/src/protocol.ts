/** The messages the app page and the boundary popup exchange. No message carries key material,
 *  and none carries a delegate address: the boundary page takes that from its own build config. */
export const PROTOCOL_VERSION = 2;

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

export type PopupRequest =
  | { v: 2; id: string; kind: "connect" }
  | { v: 2; id: string; kind: "sign-calls"; calls: PreparedCalls };

export type PopupReply =
  | { v: 2; id: string; ok: true; kind: "connect"; address: `0x${string}` }
  | { v: 2; id: string; ok: true; kind: "sign-calls"; raw: `0x${string}` }
  | { v: 2; id: string; ok: false; code: 4001 | 4100 | 4900 | -32602 | -32603; message: string };

export type PopupReady = { v: 2; kind: "ready" };
