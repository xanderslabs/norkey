import { parseArgs } from "node:util";
import { buildVault } from "./build.js";
import { serveVault } from "./serve-static.js";

const USAGE = `Usage:
  norkey-vault build --rp-id <id> --api <url> --app-origin <origin>[,<origin>] [--rp-name <name>] [--out dist-vault]
  norkey-vault serve [--dir dist-vault] [--port 5174]`;

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "rp-id": { type: "string" },
      "rp-name": { type: "string" },
      api: { type: "string" },
      "app-origin": { type: "string" },
      out: { type: "string", default: "dist-vault" },
      dir: { type: "string", default: "dist-vault" },
      port: { type: "string", default: "5174" },
    },
  });
  if (command === "build") {
    const rpId = values["rp-id"];
    const apiUrl = values.api;
    const appOrigins = values["app-origin"]?.split(",").map((s) => s.trim());
    if (!rpId || !apiUrl || !appOrigins?.length) throw new Error(USAGE);
    for (const o of appOrigins) {
      if (new URL(o).origin !== o) throw new Error(`--app-origin "${o}" must be a bare origin`);
    }
    const built = await buildVault({ rpId, rpName: values["rp-name"] ?? rpId, apiUrl, appOrigins }, values.out);
    console.log(`norkey-vault: wrote ${values.out}/index.html and _headers`);
    console.log(`CSP: ${built.csp}`);
    return;
  }
  if (command === "serve") return serveVault(values.dir, Number(values.port));
  throw new Error(USAGE);
}
