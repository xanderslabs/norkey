// Why: norkey serve is the whole backend for developers with no server of their own. One oversized
// body must not take it down or fill its memory. And a registration that fails halfway must not
// leave a user row behind: that row would block the same user id and leave a passkey with no account.
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createNorKeyHandler, MAX_BODY_BYTES, nodeListener, sqlite } from "../src/index.js";

const credential = (credentialId: string, userId: string) => ({
  credentialId,
  userId,
  publicKey: new Uint8Array([1]),
  signCount: 0,
  transports: [],
});

describe("server hardening", () => {
  it("answers an oversized body with 413 and keeps serving", async () => {
    const handler = createNorKeyHandler({
      rpId: "localhost",
      origins: ["http://localhost:5174"],
      storage: sqlite(":memory:"),
    });
    const server = createServer(nodeListener(handler)).listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/norkey`;
    try {
      const big = await fetch(`${base}/register/options`, {
        method: "POST",
        headers: { origin: "http://localhost:5174", "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES + 1) }),
      });
      expect(big.status).toBe(413);
      const after = await fetch(`${base}/wallet`);
      expect(after.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("leaves no user row when the credential insert fails", async () => {
    const storage = sqlite(":memory:");
    await storage.createUserWithCredential(credential("dup", "alice"));
    await expect(storage.createUserWithCredential(credential("dup", "bob"))).rejects.toThrow();
    // If "bob" had been left behind, this insert would hit the users primary key.
    await expect(storage.createUserWithCredential(credential("fresh", "bob"))).resolves.toBeUndefined();
  });
});
