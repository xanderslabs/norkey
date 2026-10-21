import type { PreparedCalls } from "@norkey/client/protocol";
import { formatEther } from "viem";
import { readConfig } from "./config.js";
import { chainName, describeCall } from "./decode.js";

const root = () => document.getElementById("app") as HTMLElement;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el("button", label, primary ? "primary" : "secondary");
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function screen(...children: Node[]): void {
  root().replaceChildren(...children);
}

function row(label: string, value: string): HTMLElement {
  const r = el("div", undefined, "row");
  r.append(el("span", label, "label"), el("span", value, "value"));
  return r;
}

export function showWaiting(message = "Waiting for the app..."): void {
  screen(el("p", message, "muted"));
}

export function showBusy(message: string): void {
  screen(el("p", message, "muted"));
}

export function showError(message: string): void {
  screen(el("h1", "Something went wrong"), el("p", message, "error"));
}

/** A title, a message and buttons; the first button is the primary one. */
export function showMessage(title: string, message: string, actions: [string, () => void][] = [], error = false) {
  screen(
    el("h1", title),
    el("p", message, error ? "error" : undefined),
    ...actions.map(([label, onClick], i) => button(label, onClick, i === 0)),
  );
}

/** The rule every backup screen states (slice 4). */
const LOSS_RULE =
  "Each passkey you add can open this wallet. If you lose every passkey and never exported your key, the wallet is lost.";

export function showSettings(address: string, actions: { add: () => void; test: () => void; exportKey: () => void }) {
  const details = el("div", undefined, "details");
  details.append(row("Address", address));
  screen(
    el("h1", "Your wallet"),
    details,
    el("p", LOSS_RULE),
    button("Add a passkey", actions.add, true),
    button("Test a passkey", actions.test),
    button("Export wallet key", actions.exportKey),
  );
}

export function showBackupOffer(actions: { add: () => void; skip: () => void }) {
  screen(
    el("h1", "Add a backup passkey"),
    el(
      "p",
      "Your wallet is ready. A second passkey opens it if you lose this one. It can be in another passkey provider, in another device's provider, or on a hardware security key.",
    ),
    el("p", LOSS_RULE),
    button("Add a backup passkey", actions.add, true),
    button("Skip", actions.skip),
  );
}

export function showConnect(origin: string, actions: { create: () => void; existing: () => void; cancel: () => void }) {
  screen(
    el("h1", "Connect a wallet"),
    el("p", `${origin} wants to connect your ${readConfig().rpName} wallet.`),
    button("Create a new wallet", actions.create, true),
    button("Use my passkey", actions.existing),
    button("Cancel", actions.cancel),
  );
}

/** What the consent screen shows, for both request kinds. */
export type Consent = {
  chainId: number;
  from: string;
  calls: PreparedCalls["calls"];
  /** True when the transaction carries a 7702 authorization. */
  delegate: boolean;
  fee:
    | { kind: "native"; gas: string; maxFeePerGas: string }
    | { kind: "sponsored"; paymaster: string; nonce: string; paymasterData: string };
};

export function showConsent(
  origin: string,
  c: Consent,
  calibur: string,
  actions: { approve: () => void; reject: () => void },
) {
  const name = chainName(c.chainId);
  const many = c.calls.length > 1;
  const header = el("div", undefined, "details");
  header.append(row("Chain", `${name} (${c.chainId})`), row("From", c.from));
  const parts: Node[] = [
    el("h1", many ? `Approve ${c.calls.length} calls` : "Approve transaction"),
    el("p", `Requested by ${origin}`),
    header,
  ];
  if (c.delegate) {
    parts.push(
      el(
        "p",
        `This transaction upgrades your wallet on ${name} with Uniswap's Calibur contract (${calibur}), which lets it batch calls. It replaces any earlier upgrade and stays in place until it is replaced.`,
        "notice",
      ),
    );
  }
  c.calls.forEach((call, i) => {
    const view = describeCall(call);
    const box = el("div", undefined, "details");
    box.append(el("p", many ? `${i + 1}. ${view.title}` : view.title, "label"));
    for (const [label, value] of view.rows) box.append(row(label, value));
    if (view.raw) box.append(el("pre", view.raw, "calldata"));
    parts.push(box);
  });
  const fee = el("div", undefined, "details");
  if (c.fee.kind === "native") {
    fee.append(row("Max network fee", `${formatEther(BigInt(c.fee.gas) * BigInt(c.fee.maxFeePerGas))} ETH`));
  } else {
    // The vendor's sponsor name reaches the page only through the app, so it is not shown.
    fee.append(el("p", `Network fee: paid by paymaster ${c.fee.paymaster}. Your wallet pays no ETH for gas.`));
    const more = el("details");
    more.append(
      el("summary", "Details"),
      row("EntryPoint nonce", c.fee.nonce),
      el("pre", c.fee.paymasterData, "calldata"),
    );
    fee.append(more);
  }
  parts.push(fee, button("Approve with passkey", actions.approve, true), button("Reject", actions.reject));
  screen(...parts);
}
