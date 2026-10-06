import type { PreparedTx } from "@norkey/client/protocol";
import { formatEther } from "viem";

const root = () => document.getElementById("app") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el("button", label, primary ? "primary" : "secondary");
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function screen(...children: Node[]): void {
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

export function showConnect(origin: string, actions: { create: () => void; existing: () => void; cancel: () => void }) {
  screen(
    el("h1", "Connect a wallet"),
    el("p", `${origin} wants to connect a NorKey wallet.`),
    button("Create a new wallet", actions.create, true),
    button("Use my passkey", actions.existing),
    button("Cancel", actions.cancel),
  );
}

export function showConsent(origin: string, tx: PreparedTx, actions: { approve: () => void; reject: () => void }) {
  const maxFee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
  const details = el("div", undefined, "details");
  details.append(
    row("Chain", String(tx.chainId)),
    row("From", tx.from),
    row("To", tx.to),
    row("Amount", `${formatEther(BigInt(tx.value))} ETH`),
    row("Max network fee", `${formatEther(maxFee)} ETH`),
  );
  const parts: Node[] = [el("h1", "Approve transaction"), el("p", `Requested by ${origin}`), details];
  if (tx.data !== "0x") {
    parts.push(el("p", "Unknown call data", "label"), el("pre", tx.data, "calldata"));
  }
  parts.push(button("Approve with passkey", actions.approve, true), button("Reject", actions.reject));
  screen(...parts);
}
