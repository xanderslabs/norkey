// Two entries. Opened by an app, the page serves that app's requests. Visited directly, it is the
// settings page, where the user adds a passkey or exports the wallet key.
import { readConfig } from "./config.js";
import { startRequests } from "./requests.js";
import { startSettings } from "./settings.js";
import { el } from "./view.js";

// The name goes in as text and the logo through img.src: Trusted Types forbids innerHTML.
const { rpName, logo } = readConfig();
document.title = `${rpName} wallet`;
const brand = document.getElementById("brand") as HTMLElement;
if (logo) {
  const img = el("img");
  img.src = logo;
  img.alt = "";
  brand.append(img);
}
brand.append(el("span", rpName));

if (window.opener) startRequests();
else startSettings();
