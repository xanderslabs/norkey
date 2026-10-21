// Pack smoke test. A published npm version cannot be reused, so
// this is the only check that runs the three packages the way a developer gets them: packed into
// tarballs, installed with npm into an empty folder, then imported, built and started.
//
// Why it matters: the workspace links hide a missing `files` entry, a wrong `exports` path and an
// undeclared dependency. This test fails on each of those before a version is published.
//
// Needs the network: npm installs the third-party dependencies. Run it with `pnpm pack:smoke`.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "norkey-smoke-"));
const app = join(tmp, "app");
const PORT = "8799";
let server;

/** Runs a command and throws a message that names the step, with the command's output. */
function run(step, cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`${step} failed: ${cmd} ${args.join(" ")}\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}
function check(step, ok, detail) {
  if (!ok) throw new Error(`${step} failed: ${detail}`);
}

try {
  console.log(`temp folder: ${tmp}`);

  console.log("1. build and pack");
  run("build", "pnpm", ["build"], root);
  const tarballs = ["client", "server", "vault"].map((name) => {
    const out = run(
      `pack ${name}`,
      "pnpm",
      ["pack", "--pack-destination", join(tmp, "tgz")],
      join(root, "packages", name),
    );
    return out.trim().split("\n").pop();
  });

  console.log("2. npm install the tarballs");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module", private: true }));
  run("npm install", "npm", ["install", ...tarballs], app);

  console.log("3. import the entry points");
  run(
    "import",
    "node",
    [
      "--input-type=module",
      "-e",
      "import { createNorKeyProvider } from '@norkey/client'; import '@norkey/client/protocol'; import '@norkey/client/calibur'; import { createNorKeyHandler } from '@norkey/server'; if (typeof createNorKeyProvider !== 'function' || typeof createNorKeyHandler !== 'function') process.exit(1)",
    ],
    app,
  );

  console.log("4. build the boundary page");
  writeFileSync(
    join(tmp, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
  );
  const vault = join(tmp, "vault");
  run(
    "vault build",
    "npx",
    [
      "--no-install",
      "norkey-vault",
      "build",
      "--rp-id",
      "localhost",
      "--api",
      `http://localhost:${PORT}/norkey`,
      "--app-origin",
      "http://localhost:5173",
      "--chains",
      "11155111",
      "--rp-name",
      "Smoke",
      "--logo",
      join(tmp, "logo.svg"),
      "--out",
      vault,
    ],
    app,
  );
  const html = readFileSync(join(vault, "index.html"), "utf8");
  check("vault build", html.includes('"rpName":"Smoke"'), 'index.html has no "rpName":"Smoke"');
  check("vault build", html.includes("data:image/svg+xml;base64,"), "index.html has no inlined logo");
  const headers = readFileSync(join(vault, "_headers"), "utf8");
  check("vault build", headers.includes("Content-Security-Policy"), "_headers has no Content-Security-Policy");

  console.log("5. start the server");
  // detached makes the child a process group leader, so the kill below reaches node under npx.
  // The caller's DATABASE_URL and NORKEY_* variables are dropped: DATABASE_URL would switch the server to
  // Postgres, and a NORKEY_PAYMASTER_* variable would make it exit.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) if (/^NORKEY_/.test(key)) delete env[key];
  server = spawn("npx", ["--no-install", "norkey", "serve"], {
    cwd: app,
    detached: true,
    env: {
      ...env,
      NORKEY_RP_ID: "localhost",
      NORKEY_ORIGINS: "http://localhost:5174",
      NORKEY_PORT: PORT,
      NORKEY_DB: join(tmp, "smoke.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (d) => (output += d));
  server.stderr.on("data", (d) => (output += d));
  let exited = false;
  server.on("exit", () => (exited = true));
  for (let i = 0; i < 60 && !output.includes("listening") && !exited; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check("serve", output.includes("listening"), `no "listening" line.\n${output}`);
  const res = await fetch(`http://localhost:${PORT}/norkey/status`);
  const body = await res.text();
  check(
    "serve",
    res.status === 200 && JSON.stringify(JSON.parse(body)) === '{"mode":"passkey"}',
    `GET /status answered ${res.status} ${body}`,
  );

  console.log("PACK SMOKE PASS");
} catch (e) {
  console.error(`PACK SMOKE FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
}
