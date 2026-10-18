// The export screen, ported from Avok (62fbcdd). Only settings.ts imports it, so no popup request can
// reach it (guardrail test). One passkey gesture unlocks K; the hex string is the only copy kept, and
// withUnlockedKey zeroes the key bytes. Leaving the screen, Hide, or 60 seconds idle wipes the hex and
// the QR and returns to the warnings.
import { toCanvas } from "qrcode";
import { type Address, bytesToHex } from "viem";
import type { Api } from "./api.js";
import { explain, withUnlockedKey } from "./flows.js";
import { button, el, screen } from "./view.js";

const IDLE_WIPE_MS = 60_000;

const WARNINGS = [
  "This is your wallet's private key. Anyone who has it controls your wallet on every chain, forever. It cannot be revoked or changed. After a leak, the only remedy is to move your assets to a new wallet.",
  "Export works only while this app's domain is online. If the app goes away, export cannot help anyone afterwards. Do it before.",
  "Neither the app nor NorKey sees this key. Do not paste it anywhere you would not paste your bank password.",
];

export function showExport(api: Api, address: Address, back: () => void): void {
  let hex = "";
  let idle: ReturnType<typeof setTimeout> | undefined;
  let left = false;

  const warnings = el("ul");
  for (const w of WARNINGS) warnings.append(el("li", w));
  const ack = el("input");
  ack.type = "checkbox";
  const ackLabel = el("label", undefined, "ack");
  ackLabel.append(ack, "I understand");
  const reveal = button("Show my key (passkey)", () => void show(), true);
  reveal.disabled = true;
  const code = el("code", undefined, "key");
  const qr = el("div", undefined, "qr");
  const shown = el("div");
  shown.hidden = true;
  shown.append(
    code,
    qr,
    button("Copy", () => void copy()),
    button("Hide", () => wipe("Hidden. Showing the key again needs your passkey.")),
  );
  const status = el("p", undefined, "muted");
  status.setAttribute("role", "status");

  /** Drops the only copy of the hex and the QR, and returns to the warnings. */
  function wipe(note = ""): void {
    clearTimeout(idle);
    hex = "";
    code.textContent = "";
    qr.replaceChildren();
    shown.hidden = true;
    ack.checked = false;
    reveal.disabled = true;
    status.textContent = note;
  }

  function armIdleWipe(): void {
    clearTimeout(idle);
    idle = setTimeout(() => wipe("Hidden after 60 seconds."), IDLE_WIPE_MS);
  }

  const onHidden = () => {
    if (document.visibilityState === "hidden") wipe();
  };

  async function show(): Promise<void> {
    reveal.disabled = true;
    status.textContent = "Confirm with your passkey...";
    try {
      await withUnlockedKey(
        api,
        address,
        async (key) => {
          hex = bytesToHex(key);
        },
        { local: false },
      );
    } catch (e) {
      wipe(explain(e) ?? "");
      return;
    }
    // The user went Back, or the tab was hidden, while the passkey prompt was open: keep nothing. On
    // return the user shows the key again.
    if (left || document.visibilityState === "hidden") {
      hex = "";
      return;
    }
    code.textContent = hex;
    const canvas = el("canvas");
    // The QR is a convenience: the hex is the source.
    toCanvas(canvas, hex, { errorCorrectionLevel: "M", margin: 1, width: 220 })
      .then(() => {
        if (hex) qr.replaceChildren(canvas);
      })
      .catch(() => qr.replaceChildren());
    shown.hidden = false;
    status.textContent = `This is the private key for ${address}.`;
    armIdleWipe();
  }

  async function copy(): Promise<void> {
    if (!hex) return;
    try {
      await navigator.clipboard.writeText(hex);
      status.textContent = "Copied. Clear your clipboard when you are done.";
      armIdleWipe();
    } catch {
      status.textContent = "Copy failed. Select the text instead.";
    }
  }

  ack.addEventListener("change", () => {
    reveal.disabled = !ack.checked;
  });
  document.addEventListener("visibilitychange", onHidden);
  screen(
    el("h1", "Export wallet key"),
    warnings,
    ackLabel,
    reveal,
    shown,
    status,
    button("Back", () => {
      left = true;
      wipe();
      document.removeEventListener("visibilitychange", onHidden);
      back();
    }),
  );
}
