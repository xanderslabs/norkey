// The demo's server in custom auth mode: NorKey trusts the app's own sign-in instead of running its
// own. `norkey serve` cannot do this, because getUserId is code. Run it with
// `pnpm --filter demo custom-server`, after `pnpm build`.
//
// The app here is a stub: the demo page sets a `demo_user` cookie to whatever name you type. A real
// app reads its own session cookie in getUserId, and its server sets that cookie with
// `Domain=<registrable domain>` so it also reaches this handler from the boundary page's origin.
import { createServer } from "node:http";
import { createNorKeyHandler, nodeListener, sqlite } from "@norkey/server";

/** The demo app's user: the `demo_user` cookie, or null when the app is signed out. */
function getUserId(req) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== "demo_user") continue;
    try {
      return decodeURIComponent(rest.join("=")) || null;
    } catch {
      return null;
    }
  }
  return null;
}

// A dynamic import, so this script runs on SQLite before the Postgres adapter exists.
const storage = process.env.DATABASE_URL
  ? (await import("@norkey/server/postgres")).postgres(process.env.DATABASE_URL)
  : sqlite(process.env.NORKEY_DB ?? "./custom.db");

const handler = createNorKeyHandler({
  rpId: "localhost",
  origins: ["http://localhost:5174"],
  appOrigins: ["http://localhost:5173"],
  auth: { mode: "custom", getUserId },
  storage,
});

createServer(nodeListener(handler)).listen(8787, () => console.log("norkey (custom auth) listening on :8787"));
