// The settings page: a direct visit to the boundary page, with no app behind it. A user signs in here
// to add a passkey or export the wallet key (slice 4). It is the only module that imports export.ts
// (guardrail test). Every passkey prompt here passes no hints, so another device's provider or a
// hardware key can answer.
import type { Address } from "viem";
import { createApi } from "./api.js";
import { readConfig } from "./config.js";
import { showExport } from "./export.js";
import { addPasskey, explain, signIn, withUnlockedKey } from "./flows.js";
import { showBusy, showMessage, showSettings } from "./view.js";

const config = readConfig();
const api = createApi(config.apiUrl);

function home(): void {
  showMessage("Wallet settings", "Sign in to manage the passkeys that open your wallet.", [
    ["Sign in with your passkey", () => void start()],
  ]);
}

/** Shows the error, or goes `back` when the user cancelled the prompt. */
function failed(e: unknown, back: () => void): void {
  const message = explain(e);
  if (message === null) back();
  else showMessage("Something went wrong", message, [["Back", back]], true);
}

async function start(): Promise<void> {
  showBusy("Waiting for your passkey...");
  try {
    const address = await signIn(api, undefined, false);
    if (address) signedIn(address);
    else showMessage("No wallet", "This passkey has no wallet. Open your app to create one.");
  } catch (e) {
    failed(e, home);
  }
}

/** Sign-in never unwraps, so it cannot show that a passkey opens the wallet. This does: the user picks
 *  any passkey, and withUnlockedKey unwraps K, checks it opens `address`, and zeroes it. K lives for
 *  this one gesture, as in export. */
async function test(address: Address): Promise<void> {
  showBusy("Choose the passkey to test.");
  try {
    await withUnlockedKey(api, address, async () => {}, { local: false, pick: true });
    showMessage("Passkey works", "This passkey opens your wallet.", [["Back", () => signedIn(address)]]);
  } catch (e) {
    failed(e, () => signedIn(address));
  }
}

function signedIn(address: Address): void {
  showSettings(address, {
    add: async () => {
      showBusy(
        "Follow your browser's prompts: create the new passkey, confirm it, then unlock with a passkey you already had.",
      );
      try {
        await addPasskey(api, config.rpId, address);
        showMessage(
          "Passkey added",
          "Added. Test it now with Test a passkey, and on each device you will use it from.",
          [
            ["Test a passkey", () => void test(address)],
            ["Back", () => signedIn(address)],
          ],
        );
      } catch (e) {
        failed(e, () => signedIn(address));
      }
    },
    test: () => void test(address),
    exportKey: () => showExport(api, address, () => signedIn(address)),
  });
}

export function startSettings(): void {
  home();
}
