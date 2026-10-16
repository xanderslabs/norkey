// Why: the boundary page is the only code that holds the wallet key. If any module other than
// channel.ts can post to the opener, or channel.ts can reach the key modules, a future change could
// leak K to the app page. If the page accepted requests from any origin, any website could open it
// and ask the user to sign.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const pageDir = join(import.meta.dirname, "../page");
const files = readdirSync(pageDir).filter((f) => f.endsWith(".ts"));
const src = (f: string) => readFileSync(join(pageDir, f), "utf8");

describe("boundary guardrails", () => {
  it("only channel.ts calls postMessage", () => {
    const offenders = files.filter((f) => f !== "channel.ts" && /postMessage\s*\(/.test(src(f)));
    expect(offenders).toEqual([]);
  });

  it("channel.ts imports nothing that touches key material", () => {
    const imports = [...src("channel.ts").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const banned of ["./wrap.js", "./key-account.js", "./passkey.js", "./flows.js"]) {
      expect(imports).not.toContain(banned);
    }
  });

  it("export is reachable only from the settings page", () => {
    // Why: export hands out K itself, and it cannot be revoked. The settings page is a direct visit
    // with no app behind it. If the popup's request handler or channel.ts could reach the export
    // flow, a request from the app page (or XSS on it) could open the export screen in the popup.
    const importsOf = (f: string) => [...src(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const importers = (target: string) => files.filter((f) => importsOf(f).includes(target));
    expect(importers("./export.js")).toEqual(["settings.ts"]);
    expect(importers("./settings.js")).toEqual(["main.ts"]);
    for (const f of ["channel.ts", "requests.ts"]) {
      expect(importsOf(f), f).not.toContain("./export.js");
      expect(importsOf(f), f).not.toContain("./settings.js");
    }
  });

  it("api.ts sends no PRF output or key fields", () => {
    expect(src("api.ts")).not.toMatch(/prfOutput|walletKey|\bkek\b/i);
  });

  it("ignores requests from origins not in appOrigins", async () => {
    const opener = { postMessage: vi.fn() };
    vi.stubGlobal("window", { opener, addEventListener: vi.fn() });
    const { acceptRequest } = await import("../page/channel.js");
    const request = { v: 3, id: "x", kind: "connect" };
    const evil = acceptRequest({ origin: "https://evil.example", source: opener, data: request } as never, [
      "https://app.example",
    ]);
    const good = acceptRequest({ origin: "https://app.example", source: opener, data: request } as never, [
      "https://app.example",
    ]);
    expect(evil).toBeNull();
    expect(good).toEqual(request);
    vi.unstubAllGlobals();
  });
});
