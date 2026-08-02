// ConfirmWebAuthnCredential — verify the authenticator's attestation
// and activate the credential (self-service, ADR-0036 slice 1).
//
// Consumes the single-use REGISTRATION challenge in the same tx as the
// cryptographic verification, stores the credential row (public key +
// counter — public material, not KMS-sealed), and flips
// `user.mfaEnrolled`. If this is the account's FIRST authenticator of
// any kind (no active TOTP enrollment, no other credential), a fresh
// recovery-code set is minted — recovery codes are the lost-
// authenticator backstop for both factor types. An account that
// already has a factor keeps its existing codes untouched.
//
// PHI: none. The ceremony response and recovery codes are on the
// redaction allowlist.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { WebAuthnCeremony } from "@pharmax/database";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { webAuthnRegistrationFailedError } from "../errors.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../mfa/recovery-codes.js";
import { consumeWebAuthnChallenge } from "../mfa/webauthn-challenge.js";

const inputSchema = z
  .object({
    challengeId: z.string().uuid(),
    /** Relying-party id + origin, resolved by the web tier — not the browser. */
    rpId: z.string().min(1).max(253),
    origin: z.string().url().max(512),
    /** User-visible label ("YubiKey 5C", "MacBook Touch ID"). */
    label: z.string().min(1).max(64),
    /** The browser's `startRegistration()` response JSON (untrusted). */
    response: z.unknown(),
  })
  .strict();

export type ConfirmWebAuthnCredentialInput = z.infer<typeof inputSchema>;

export interface ConfirmWebAuthnCredentialOutput {
  readonly credentialRowId: string;
  /**
   * Recovery codes, minted ONLY when this is the account's first
   * authenticator. Shown once; redacted from logs. Empty otherwise.
   */
  readonly recoveryCodes: ReadonlyArray<string>;
}

export const ConfirmWebAuthnCredential: Command<
  ConfirmWebAuthnCredentialInput,
  ConfirmWebAuthnCredentialOutput
> = {
  name: "ConfirmWebAuthnCredential",
  inputSchema,
  permission: null,
  redactFields: ["response", "recoveryCodes"],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<ConfirmWebAuthnCredentialOutput>> {
    const config = getAuthConfiguration();
    const userId = ctx.actor.userId;
    const now = clock.now();

    // Single-use gate FIRST — a replayed response dies here before any
    // cryptographic work.
    const { challenge } = await consumeWebAuthnChallenge({
      tx,
      challengeId: input.challengeId,
      userId,
      purpose: WebAuthnCeremony.REGISTRATION,
      now,
    });

    const result = await config.webauthn.adapter.verifyRegistration({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: input.origin,
      expectedRpId: input.rpId,
    });
    if (!result.verified) {
      throw webAuthnRegistrationFailedError();
    }

    // First-authenticator check BEFORE inserting the new credential.
    const [priorCredential, priorTotp] = await Promise.all([
      tx.webAuthnCredential.findFirst({
        where: { userId, disabledAt: null },
        select: { id: true },
      }),
      tx.mfaEnrollment.findFirst({
        where: { userId, disabledAt: null, verifiedAt: { not: null } },
        select: { id: true },
      }),
    ]);
    const firstAuthenticator = priorCredential === null && priorTotp === null;

    const credential = await tx.webAuthnCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userId,
        credentialId: result.credentialId,
        publicKey: result.publicKey,
        counter: result.counter,
        transports: [...result.transports],
        aaguid: result.aaguid,
        label: input.label,
        createdAt: now,
      },
      select: { id: true },
    });

    await tx.user.update({ where: { id: userId }, data: { mfaEnrolled: true } });

    let recoveryCodes: ReadonlyArray<string> = [];
    if (firstAuthenticator) {
      await tx.recoveryCode.deleteMany({ where: { userId, usedAt: null } });
      const minted = generateRecoveryCodes(config.mfa.recoveryCodeCount);
      for (const code of minted) {
        const codeHash = await hashRecoveryCode(config.hasher, code);
        await tx.recoveryCode.create({
          data: { organizationId: ctx.organizationId, userId, codeHash, createdAt: now },
        });
      }
      recoveryCodes = minted;
    }

    return {
      output: Object.freeze({
        credentialRowId: credential.id,
        recoveryCodes: Object.freeze(recoveryCodes),
      }),
      audit: {
        action: "user.webauthn.credential_enrolled",
        resourceType: "User",
        resourceId: userId,
        metadata: {
          userId,
          credentialRowId: credential.id,
          aaguid: result.aaguid,
          firstAuthenticator,
          recoveryCodesIssued: recoveryCodes.length,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "user.webauthn.credential_enrolled.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            organizationId: ctx.organizationId,
            userId,
            credentialRowId: credential.id,
            aaguid: result.aaguid,
            firstAuthenticator,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
