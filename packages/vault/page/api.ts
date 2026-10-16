import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Address } from "viem";
import type { Wrap } from "./wrap.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type LoginResult = { userId: string; wallet: { address: Address } | null; wrap: Wrap | null };

/** Calls to the NorKey server. Every parameter is public data: passkey responses without extension
 *  results, wraps (ciphertext), addresses, and ids. */
export function createApi(apiUrl: string) {
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`);
    return json as T;
  }
  return {
    registerOptions: (label?: string) =>
      call<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
        "/register/options",
        label === undefined ? {} : { label },
      ),
    registerVerify: (challengeId: string, response: RegistrationResponseJSON) =>
      call<{ userId: string }>("/register/verify", { challengeId, response }),
    loginOptions: (credentialId?: string) =>
      call<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
        "/login/options",
        credentialId ? { credentialId } : {},
      ),
    loginVerify: (challengeId: string, response: AuthenticationResponseJSON) =>
      call<LoginResult>("/login/verify", { challengeId, response }),
    createWallet: (address: Address, wrap: Wrap) => call<{ address: Address }>("/wallet", { address, wrap }),
    passkeyOptions: () =>
      call<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>("/passkeys/options", {}),
    addPasskey: (challengeId: string, response: RegistrationResponseJSON, wrap: Wrap) =>
      call<{ credentialId: string }>("/passkeys", { challengeId, response, wrap }),
  };
}
export type Api = ReturnType<typeof createApi>;
