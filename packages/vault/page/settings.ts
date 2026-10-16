// The settings page: a direct visit to the boundary page, with no app behind it. A user signs in here
// to add a passkey (slice 4). Every passkey prompt here passes no hints, so another device's provider
// or a hardware key can answer.
import type { Address } from "viem";
import { createApi } from "./api.js";
import { readConfig } from "./config.js";
import { addPasskey, explain, signIn } from "./flows.js";
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

function signedIn(address: Address): void {
  showSettings(address, {
    add: async () => {
      showBusy(
        "Follow your browser's prompts: create the new passkey, confirm it, then unlock with a passkey you already had.",
      );
      try {
        await addPasskey(api, config.rpId, address);
        showMessage("Passkey added", "Added. Test it: sign in with the new passkey on the settings page.", [
          ["Sign in again", home],
          ["Back", () => signedIn(address)],
        ]);
      } catch (e) {
        failed(e, () => signedIn(address));
      }
    },
  });
}

export function startSettings(): void {
  home();
}
