// Two entries. Opened by an app, the page serves that app's requests. Visited directly, it is the
// settings page, where the user adds a passkey or exports the wallet key (slice 4).
import { startRequests } from "./requests.js";
import { startSettings } from "./settings.js";

if (window.opener) startRequests();
else startSettings();
