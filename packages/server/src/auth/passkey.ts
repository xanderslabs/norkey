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

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class AuthError extends Error {
  constructor() {
    super("passkey verification failed");
    this.name = "AuthError";
  }
}

export async function registerOptions(config: ResolvedConfig) {
  const options = await generateRegistrationOptions({
    rpName: config.rpName ?? config.rpId,
    rpID: config.rpId,
    userName: "NorKey wallet",
    userID: randomBytes(16),
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
  await config.storage.createUser(stored.userId);
  await config.storage.addCredential({
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
