/** The messages the app page and the boundary popup exchange. No message carries key material. */
export const PROTOCOL_VERSION = 1;

/** A transaction the app page prepared and the popup will show and sign. Quantities are hex. */
export type PreparedTx = {
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

export type PopupRequest =
  | { v: 1; id: string; kind: "connect" }
  | { v: 1; id: string; kind: "sign-tx"; tx: PreparedTx };

export type PopupReply =
  | { v: 1; id: string; ok: true; kind: "connect"; address: `0x${string}` }
  | { v: 1; id: string; ok: true; kind: "sign-tx"; raw: `0x${string}` }
  | { v: 1; id: string; ok: false; code: 4001 | 4100 | 4900 | -32603; message: string };

export type PopupReady = { v: 1; kind: "ready" };
