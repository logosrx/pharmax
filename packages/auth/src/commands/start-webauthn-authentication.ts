// StartWebAuthnAuthentication — mint an assertion challenge at sign-in
// (ADR-0036 slice 1).
//
// A SYSTEM command (no tenancy context exists yet at sign-in), like
// SignIn. The WebAuthn assertion ceremony needs a server round-trip
// BEFORE `navigator.credentials.get`, so this command:
//
//   1. Verifies the FIRST factor (email + password) — credential ids
//      are never enumerable without it.
//   2. Mints a single-use AUTHENTICATION challenge (5-min TTL).
//   3. Returns the request options (allowCredentials = the user's
//      active credential ids).
//
// The client completes the ceremony and re-submits `SignIn` with the
// assertion; the session is minted there, never here. Fronted by the
// same rate-limit + lockout gates as `signIn` via the
// `startWebAuthnSignIn` wrapper (../webauthn-sign-in.ts).
//
// PHI: none. `password` (input) and `optionsJSON` (embeds the
// challenge) are on the redaction allowlist.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { WebAuthnCeremony } from "@pharmax/database";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { webAuthnNotEnrolledError } from "../errors.js";
import { mintWebAuthnChallenge } from "../mfa/webauthn-challenge.js";
import type { WebAuthnOptionsJSON } from "../mfa/webauthn.js";
import { verifyFirstFactor } from "../password/verify-first-factor.js";

const inputSchema = z
  .object({
    organizationId: z.string().uuid(),
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    /** Relying-party id (sign-in hostname), resolved by the web tier. */
    rpId: z.string().min(1).max(253),
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

export type StartWebAuthnAuthenticationInput = z.infer<typeof inputSchema>;

export interface StartWebAuthnAuthenticationOutput {
  readonly userId: string;
  readonly challengeId: string;
  /** PublicKeyCredentialRequestOptions JSON for the browser ceremony. */
  readonly optionsJSON: WebAuthnOptionsJSON;
}

export const StartWebAuthnAuthentication: SystemCommand<
  StartWebAuthnAuthenticationInput,
  StartWebAuthnAuthenticationOutput
> = {
  name: "StartWebAuthnAuthentication",
  inputSchema,
  redactFields: ["password", "optionsJSON"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
  }): Promise<SystemHandlerResult<StartWebAuthnAuthenticationOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();
    const email = input.email.toLowerCase();

    const firstFactor = await verifyFirstFactor({
      tx,
      organizationId: input.organizationId,
      email,
      password: input.password,
    });

    const credentials = await tx.webAuthnCredential.findMany({
      where: { userId: firstFactor.userId, disabledAt: null },
      select: { credentialId: true, transports: true },
    });
    if (credentials.length === 0) {
      throw webAuthnNotEnrolledError({ userId: firstFactor.userId });
    }

    const generated = await config.webauthn.adapter.generateAuthenticationOptions({
      rpId: input.rpId,
      allowCredentials: credentials.map((c) => ({
        credentialId: c.credentialId,
        transports: c.transports,
      })),
    });

    const { challengeId } = await mintWebAuthnChallenge({
      tx,
      organizationId: input.organizationId,
      userId: firstFactor.userId,
      purpose: WebAuthnCeremony.AUTHENTICATION,
      challenge: generated.challenge,
      now,
      ttlMs: config.webauthn.challengeTtlMs,
    });

    return {
      output: {
        userId: firstFactor.userId,
        challengeId,
        optionsJSON: generated.optionsJSON,
      },
      targetOrganizationId: input.organizationId,
      audit: {
        action: "user.webauthn.authentication_started",
        resourceType: "User",
        resourceId: firstFactor.userId,
        metadata: { challengeId, credentialCount: credentials.length, commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.webauthn.authentication_started.v1",
          aggregateType: "User",
          aggregateId: firstFactor.userId,
          payload: {
            organizationId: input.organizationId,
            userId: firstFactor.userId,
            challengeId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
