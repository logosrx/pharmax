// EnrollMfa — begin TOTP enrollment (self-service).
//
// Generates a fresh secret, seals it with the KMS envelope, and stores
// an UNVERIFIED enrollment row. Returns the provisioning URI + base32
// secret for the QR code / manual entry. The enrollment is not active
// until `ConfirmMfa` verifies a code. Re-enrolling replaces any prior
// unverified attempt; an already-ACTIVE authenticator blocks re-enroll
// (disable first).
//
// PHI: none. The secret + URI are sensitive credential material and are
// on the redaction allowlist so they never reach `command_log`.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { mfaAlreadyEnrolledError } from "../errors.js";
import { buildTotpKeyUri, generateTotpSecretBase32 } from "../mfa/totp.js";
import { sealTotpSecret } from "../mfa/secret-seal.js";

const inputSchema = z.object({}).strict();

export type EnrollMfaInput = z.infer<typeof inputSchema>;

export interface EnrollMfaOutput {
  readonly enrollmentId: string;
  /** otpauth:// URI for the QR code. Sensitive — redacted from logs. */
  readonly otpauthUri: string;
  /** Base32 secret for manual entry. Sensitive — redacted from logs. */
  readonly secretBase32: string;
}

export const EnrollMfa: Command<EnrollMfaInput, EnrollMfaOutput> = {
  name: "EnrollMfa",
  inputSchema,
  permission: null,
  redactFields: ["otpauthUri", "secretBase32"],

  async handle({ ctx, tx, commandLogId, clock }): Promise<HandlerResult<EnrollMfaOutput>> {
    const config = getAuthConfiguration();
    const userId = ctx.actor.userId;
    const now = clock.now();

    const active = await tx.mfaEnrollment.findFirst({
      where: { userId, disabledAt: null, verifiedAt: { not: null } },
      select: { id: true },
    });
    if (active !== null) {
      throw mfaAlreadyEnrolledError({ userId });
    }

    // Replace any prior unverified attempt so a user can restart cleanly.
    await tx.mfaEnrollment.deleteMany({ where: { userId, verifiedAt: null } });

    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    const secretBase32 = generateTotpSecretBase32();
    const secretCiphertext = await sealTotpSecret({
      secretBase32,
      organizationId: ctx.organizationId,
      userId,
    });

    const enrollment = await tx.mfaEnrollment.create({
      data: {
        organizationId: ctx.organizationId,
        userId,
        secretCiphertext,
        createdAt: now,
      },
      select: { id: true },
    });

    const otpauthUri = buildTotpKeyUri({
      secretBase32,
      issuer: config.mfa.issuer,
      accountName: user.email,
    });

    return {
      output: Object.freeze({ enrollmentId: enrollment.id, otpauthUri, secretBase32 }),
      audit: {
        action: "user.mfa.enrollment_started",
        resourceType: "User",
        resourceId: userId,
        // No secret in the audit trail — only the enrollment id.
        metadata: { userId, enrollmentId: enrollment.id, commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.mfa.enrollment_started.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            organizationId: ctx.organizationId,
            userId,
            enrollmentId: enrollment.id,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
