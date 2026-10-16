import { randomBytes, randomUUID } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { ResolvedConfig } from "../config.js";
import type { StoredCredential } from "../storage/types.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LABEL_MAX = 64;

export class AuthError extends Error {
  constructor() {
    super("passkey verification failed");
    this.name = "AuthError";
  }
}

/** The passkey's display name in the browser's picker. The app's label, trimmed, without control or
 *  bidirectional control characters, at most 64 characters. Empty or missing gives "NorKey wallet"
 *  and the first 6 hex characters of the random user id. Display only: not unique, not stored. */
function passkeyName(label: unknown, userID: Uint8Array): string {
  const clean =
    typeof label === "string"
      ? Array.from(label.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim())
          .slice(0, LABEL_MAX)
          .join("")
          .trim()
      : "";
  return clean || `NorKey wallet ${Buffer.from(userID).toString("hex").slice(0, 6)}`;
}

export async function registerOptions(config: ResolvedConfig, label?: unknown) {
  const userID = randomBytes(16);
  const options = await generateRegistrationOptions({
    rpName: config.rpName ?? config.rpId,
    rpID: config.rpId,
    userName: passkeyName(label, userID),
    userID,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
  });
  const challengeId = randomUUID();
  await config.storage.putChallenge({
    id: challengeId,
    challenge: options.challenge,
    userId: options.user.id,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

/** Creation options for one more passkey on an existing user (slice 4). The user id is the account's,
 *  so the new passkey signs in to the same user. Every credential the user has is excluded, and no
 *  authenticatorAttachment is set, so another provider or a hardware key can hold the new one. */
export async function addPasskeyOptions(config: ResolvedConfig, userId: string) {
  const userID = Buffer.from(userId, "base64url");
  const options = await generateRegistrationOptions({
    rpName: config.rpName ?? config.rpId,
    rpID: config.rpId,
    userName: passkeyName(undefined, userID),
    userID,
    attestationType: "none",
    excludeCredentials: (await config.storage.listCredentialIds(userId)).map((id) => ({ id })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = randomUUID();
  await config.storage.putChallenge({
    id: challengeId,
    challenge: options.challenge,
    userId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

/** Verifies a new passkey's registration against a challenge the caller has already taken and matched
 *  to `userId`. Returns the credential, not yet stored. */
export async function verifyNewPasskey(
  config: ResolvedConfig,
  challenge: string,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<StoredCredential> {
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new AuthError();
  }
  if (!verification.verified || !verification.registrationInfo) throw new AuthError();
  const { credential } = verification.registrationInfo;
  return {
    credentialId: credential.id,
    userId,
    publicKey: credential.publicKey,
    signCount: credential.counter,
    transports: credential.transports ?? [],
  };
}

/** Verifies a registration and creates the user and credential. Returns the new user id. */
export async function registerVerify(
  config: ResolvedConfig,
  challengeId: string,
  response: RegistrationResponseJSON,
): Promise<string> {
  const stored = await config.storage.takeChallenge(challengeId);
  if (!stored?.userId) throw new AuthError();
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new AuthError();
  }
  if (!verification.verified || !verification.registrationInfo) throw new AuthError();
  const { credential } = verification.registrationInfo;
  await config.storage.createUserWithCredential({
    credentialId: credential.id,
    userId: stored.userId,
    publicKey: credential.publicKey,
    signCount: credential.counter,
    transports: credential.transports ?? [],
  });
  return stored.userId;
}

export async function loginOptions(config: ResolvedConfig, credentialId?: string) {
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: "required",
    allowCredentials: credentialId ? [{ id: credentialId }] : undefined,
  });
  const challengeId = randomUUID();
  await config.storage.putChallenge({
    id: challengeId,
    challenge: options.challenge,
    userId: null,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

/** Verifies an assertion. Returns the user id and the credential id that signed it. */
export async function loginVerify(
  config: ResolvedConfig,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ userId: string; credentialId: string }> {
  const stored = await config.storage.takeChallenge(challengeId);
  if (!stored) throw new AuthError();
  const credential = await config.storage.getCredential(response.id);
  if (!credential) throw new AuthError();
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.signCount,
        transports: credential.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    });
  } catch {
    throw new AuthError();
  }
  if (!verification.verified) throw new AuthError();
  await config.storage.setSignCount(credential.credentialId, verification.authenticationInfo.newCounter);
  return { userId: credential.userId, credentialId: credential.credentialId };
}
