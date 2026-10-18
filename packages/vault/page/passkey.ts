import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { base64UrlToBytes, bytesToArrayBuffer, bytesToBase64Url } from "./encoding.js";
import { PRF_INPUT } from "./wrap.js";

export class NoPrfError extends Error {
  constructor() {
    super("This passkey provider cannot unlock a NorKey wallet. Try iCloud Keychain or Google Password Manager.");
    this.name = "NoPrfError";
  }
}

/** The browser returned no credential: the user dismissed the prompt. Replies 4001. */
export class CancelledError extends Error {
  constructor() {
    super("User rejected the request.");
    this.name = "CancelledError";
  }
}

/** A passkey problem the user should read, such as a passkey on another device. Replies -32603. */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

export const CROSS_DEVICE_REJECTED = "This wallet's passkey is not on this device. Use a passkey saved on this device.";
const NO_PRF = "This passkey cannot open the wallet: it returned no PRF.";
const LOCAL_HINTS = ["client-device"] as const;
const prfExtension = { prf: { eval: { first: bytesToArrayBuffer(PRF_INPUT) } } };

function readPrf(credential: PublicKeyCredential): ArrayBuffer | undefined {
  return (credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results
    ?.first;
}

function descriptor(d: PublicKeyCredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    type: "public-key",
    id: bytesToArrayBuffer(base64UrlToBytes(d.id)),
    ...(d.transports?.length ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  };
}

function registrationJSON(c: PublicKeyCredential): RegistrationResponseJSON {
  const r = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    rawId: bytesToBase64Url(new Uint8Array(c.rawId)),
    type: "public-key",
    authenticatorAttachment: (c.authenticatorAttachment ?? undefined) as AuthenticatorAttachment | undefined,
    response: {
      clientDataJSON: bytesToBase64Url(new Uint8Array(r.clientDataJSON)),
      attestationObject: bytesToBase64Url(new Uint8Array(r.attestationObject)),
      transports: (r.getTransports?.() ?? []) as AuthenticatorTransportFuture[],
    },
    // PRF results are secret. They never leave this module except as prfOutput.
    clientExtensionResults: {},
  };
}

function authenticationJSON(c: PublicKeyCredential): AuthenticationResponseJSON {
  const r = c.response as AuthenticatorAssertionResponse;
  return {
    id: c.id,
    rawId: bytesToBase64Url(new Uint8Array(c.rawId)),
    type: "public-key",
    authenticatorAttachment: (c.authenticatorAttachment ?? undefined) as AuthenticatorAttachment | undefined,
    response: {
      clientDataJSON: bytesToBase64Url(new Uint8Array(r.clientDataJSON)),
      authenticatorData: bytesToBase64Url(new Uint8Array(r.authenticatorData)),
      signature: bytesToBase64Url(new Uint8Array(r.signature)),
      userHandle: r.userHandle ? bytesToBase64Url(new Uint8Array(r.userHandle)) : undefined,
    },
    clientExtensionResults: {},
  };
}

/** Create a passkey from server options. `prfOutput` is undefined when the authenticator gave none
 *  at creation; the caller then runs `getPasskey` once on the new credential. */
export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<{ response: RegistrationResponseJSON; prfOutput: ArrayBuffer | undefined }> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: options.rp,
      user: {
        id: bytesToArrayBuffer(base64UrlToBytes(options.user.id)),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      challenge: bytesToArrayBuffer(base64UrlToBytes(options.challenge)),
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      excludeCredentials: options.excludeCredentials?.map(descriptor),
      authenticatorSelection: options.authenticatorSelection,
      attestation: options.attestation,
      extensions: prfExtension as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new CancelledError();
  return { response: registrationJSON(credential), prfOutput: readPrf(credential) };
}

/** Run a passkey assertion from server options and evaluate PRF in the same gesture. `local` asks the
 *  browser for a passkey on this device, for app requests. The settings page and add-a-passkey pass
 *  false, so another device's provider or a hardware key can answer. */
export async function getPasskey(
  options: PublicKeyCredentialRequestOptionsJSON,
  local = true,
): Promise<{ response: AuthenticationResponseJSON; prfOutput: ArrayBuffer }> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId: options.rpId,
      challenge: bytesToArrayBuffer(base64UrlToBytes(options.challenge)),
      timeout: options.timeout,
      allowCredentials: options.allowCredentials?.map(descriptor),
      userVerification: options.userVerification ?? "required",
      ...(local ? { hints: LOCAL_HINTS } : {}),
      extensions: prfExtension,
    } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!assertion) throw new CancelledError();
  const prfOutput = readPrf(assertion);
  if (!prfOutput) {
    // App requests ask for a passkey on this device, so a cross-platform one gets today's message. The
    // settings page and add-a-passkey accept one, so there the message names the real cause.
    if (assertion.authenticatorAttachment === "cross-platform") {
      throw new PasskeyError(local ? CROSS_DEVICE_REJECTED : NO_PRF);
    }
    throw new NoPrfError();
  }
  // Slice 4, decision 6: a passkey from another device or a hardware key goes on when it returns PRF
  // output. The wrap's AES-GCM check then decides whether it opens the wallet.
  return { response: authenticationJSON(assertion), prfOutput };
}
