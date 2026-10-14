import type { PreparedCalls } from "@norkey/client/protocol";
import { formatEther } from "viem";
import { chainName, describeCall } from "./decode.js";

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

export function showConsent(
  origin: string,
  p: PreparedCalls,
  calibur: string,
  actions: { approve: () => void; reject: () => void },
) {
  const name = chainName(p.chainId);
  const many = p.calls.length > 1;
  const header = el("div", undefined, "details");
  header.append(row("Chain", `${name} (${p.chainId})`), row("From", p.from));
  const parts: Node[] = [
    el("h1", many ? `Approve ${p.calls.length} calls` : "Approve transaction"),
    el("p", `Requested by ${origin}`),
    header,
  ];
  if (p.delegate) {
    parts.push(
      el(
        "p",
        `This transaction upgrades your wallet on ${name} with Uniswap's Calibur contract (${calibur}), which lets it batch calls. It replaces any earlier upgrade and stays in place until it is replaced.`,
        "notice",
      ),
    );
  }
  p.calls.forEach((call, i) => {
    const view = describeCall(call);
    const box = el("div", undefined, "details");
    box.append(el("p", many ? `${i + 1}. ${view.title}` : view.title, "label"));
    for (const [label, value] of view.rows) box.append(row(label, value));
    if (view.raw) box.append(el("pre", view.raw, "calldata"));
    parts.push(box);
  });
  const fee = el("div", undefined, "details");
  fee.append(row("Max network fee", `${formatEther(BigInt(p.gas) * BigInt(p.maxFeePerGas))} ETH`));
  parts.push(fee, button("Approve with passkey", actions.approve, true), button("Reject", actions.reject));
  screen(...parts);
}
