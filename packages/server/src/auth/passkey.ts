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
import { ExternalIdTakenError, type StoredCredential } from "../storage/types.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LABEL_MAX = 64;

export class AuthError extends Error {
  constructor() {
    super("passkey verification failed");
    this.name = "AuthError";
  }
}

/** A request that conflicts with the account's state, answered with 409 and this message. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
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

/** Creation options for a new user's first passkey. In custom mode, `existingUserId` is the app user's
 *  NorKey user when it has no wallet yet (slice 5, decision 7): the new passkey lands on that user.
 *  No excludeCredentials, so the user can retry in the provider that failed. */
export async function registerOptions(config: ResolvedConfig, label?: unknown, existingUserId?: string) {
  const userID = existingUserId ? Buffer.from(existingUserId, "base64url") : randomBytes(16);
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

/** Verifies a registration and creates the user and credential. Returns the user id. In custom mode,
 *  `externalId` is the app's user: an existing NorKey user of that app user gets the credential only
 *  if the challenge was issued to it and it has no wallet; otherwise the user is created with that
 *  external id. A second tab that got there first answers ConflictError. */
export async function registerVerify(
  config: ResolvedConfig,
  challengeId: string,
  response: RegistrationResponseJSON,
  externalId?: string,
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
  const c: StoredCredential = {
    credentialId: credential.id,
    userId: stored.userId,
    publicKey: credential.publicKey,
    signCount: credential.counter,
    transports: credential.transports ?? [],
  };
  if (externalId === undefined) {
    // A challenge from /passkeys/options names the signed-in user, who has credentials. Replaying it
    // here cannot create that user again.
    if ((await config.storage.listCredentialIds(stored.userId)).length > 0) {
      throw new ConflictError("this account already has a NorKey user");
    }
    await config.storage.createUserWithCredential(c);
    return stored.userId;
  }
  const mapped = await config.storage.getUserIdByExternalId(externalId);
  if (mapped) {
    if (mapped !== stored.userId) throw new ConflictError("this account already has a NorKey user");
    if (await config.storage.getWallet(mapped)) throw new ConflictError("this account already has a wallet");
    await config.storage.addCredential(c);
    return mapped;
  }
  // A challenge issued to an existing user (another app user's, or a /passkeys/options one) cannot
  // create a new user under this app user. The built-in branch above applies the same check.
  if ((await config.storage.listCredentialIds(stored.userId)).length > 0) {
    throw new ConflictError("this account already has a NorKey user");
  }
  try {
    await config.storage.createUserWithCredential(c, externalId);
  } catch (e) {
    if (e instanceof ExternalIdTakenError) throw new ConflictError("this account already has a NorKey user");
    throw e;
  }
  return stored.userId;
}

/** Request options for a sign-in. In custom mode, `allowIds` is every credential of the app user's
 *  NorKey user, so the picker shows only those (slice 5, decision 6); `credentialId` narrows it only
 *  if it is one of them. */
export async function loginOptions(config: ResolvedConfig, credentialId?: string, allowIds?: string[]) {
  const allow = allowIds
    ? credentialId && allowIds.includes(credentialId)
      ? [credentialId]
      : allowIds
    : credentialId
      ? [credentialId]
      : undefined;
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: "required",
    allowCredentials: allow?.map((id) => ({ id })),
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
