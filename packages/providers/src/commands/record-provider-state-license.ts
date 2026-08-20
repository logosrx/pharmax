// RecordProviderStateLicense — record or renew a prescriber's state
// licence to practise.
//
// The companion question to the DEA registration: that one authorizes
// controlled substances federally, this authorizes practising at all. A
// prescriber holding a current DEA and a lapsed state licence is the
// combination worth catching, and neither model could see the other
// before both existed.
//
// RENEWAL IS AN UPDATE, keyed on `(organizationId, providerId, state,
// licenseNumber)`. A renewal is the same licence with a later date;
// inserting a second row would leave two answers to "is this licence
// current". A genuinely NEW licence number in the same state — which
// happens when a board reissues rather than renews — is a new row, and
// the old one is revoked with a reason.
//
// PHI: none, and unlike the DEA model this one carries its number in
// audit and outbox. State boards publish licence numbers in searchable
// public directories, so the number is already public; a DEA number is
// not published by the DEA.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  CredentialStatus,
  CredentialVerificationMethod,
  Prisma,
  ProviderStatus,
} from "@pharmax/database";
import { errors, geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const RECORD_LICENSE_PROVIDER_NOT_FOUND = "RECORD_LICENSE_PROVIDER_NOT_FOUND";
export const RECORD_LICENSE_PROVIDER_INACTIVE = "RECORD_LICENSE_PROVIDER_INACTIVE";
export const RECORD_LICENSE_UNKNOWN_STATE = "RECORD_LICENSE_UNKNOWN_STATE";
export const RECORD_LICENSE_EXPIRY_BEFORE_ISSUE = "RECORD_LICENSE_EXPIRY_BEFORE_ISSUE";

const inputSchema = z
  .object({
    providerId: z.uuid(),
    /** US state or territory code; validated against the real set. */
    state: z.string().length(2),
    licenseNumber: z.string().trim().min(1).max(64),
    /** Board-specific class, e.g. "MD", "DO", "NP", "PA-C". */
    licenseType: z.string().trim().min(1).max(64).optional(),
    issuedAt: z.iso.date().optional(),
    /** Absent means not recorded, which does not block. */
    expiresAt: z.iso.date().optional(),
    verificationMethod: z.enum(CredentialVerificationMethod).optional(),
  })
  .strict();

export type RecordProviderStateLicenseInput = z.infer<typeof inputSchema>;

export interface RecordProviderStateLicenseOutput {
  readonly licenseId: string;
  readonly providerId: string;
  readonly state: string;
  readonly licenseNumber: string;
  readonly expiresAt: string | null;
  readonly renewed: boolean;
}

export const RecordProviderStateLicense: Command<
  RecordProviderStateLicenseInput,
  RecordProviderStateLicenseOutput
> = {
  name: "RecordProviderStateLicense",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_CREDENTIALS_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<RecordProviderStateLicenseOutput>> {
    const state = geo.normalizeJurisdictionCode(input.state);
    if (state === null) {
      throw new errors.ValidationError({
        code: RECORD_LICENSE_UNKNOWN_STATE,
        message: `"${input.state}" is not a US state or territory code.`,
        issues: [{ path: ["state"], message: "unknown jurisdiction" }],
      });
    }

    const provider = await tx.provider.findFirst({
      where: { id: input.providerId, organizationId: ctx.organizationId },
      select: { id: true, npi: true, status: true },
    });
    if (provider === null) {
      throw new errors.NotFoundError({
        code: RECORD_LICENSE_PROVIDER_NOT_FOUND,
        message: "Prescriber not found in this organization.",
        metadata: { providerId: input.providerId },
      });
    }
    if (provider.status !== ProviderStatus.ACTIVE) {
      throw new errors.ValidationError({
        code: RECORD_LICENSE_PROVIDER_INACTIVE,
        message: `Prescriber is ${provider.status}. Reactivate them before recording a credential.`,
        metadata: { providerId: provider.id, status: provider.status },
      });
    }

    const issuedAt = input.issuedAt === undefined ? null : new Date(input.issuedAt);
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    if (issuedAt !== null && expiresAt !== null && expiresAt.getTime() < issuedAt.getTime()) {
      // Almost always a transposed pair of dates. Catching it here
      // beats storing a licence that reads as permanently lapsed.
      throw new errors.ValidationError({
        code: RECORD_LICENSE_EXPIRY_BEFORE_ISSUE,
        message: "The licence expiry date is before its issue date. Check the two dates.",
        issues: [{ path: ["expiresAt"], message: "before issuedAt" }],
      });
    }

    const licenseNumber = input.licenseNumber.trim();
    const existing = await tx.providerStateLicense.findFirst({
      where: {
        organizationId: ctx.organizationId,
        providerId: provider.id,
        state,
        licenseNumber,
      },
      select: { id: true },
    });

    const now = clock.now();
    const verificationMethod = input.verificationMethod ?? CredentialVerificationMethod.ATTESTED;
    const verified = verificationMethod !== CredentialVerificationMethod.ATTESTED;
    const renewed = existing !== null;

    const data = {
      ...(input.licenseType === undefined ? {} : { licenseType: input.licenseType.trim() }),
      issuedAt,
      expiresAt,
      status: CredentialStatus.ACTIVE,
      verificationMethod,
      verifiedAt: verified ? now : null,
      verifiedByUserId: verified ? ctx.actor.userId : null,
      recordedByUserId: ctx.actor.userId,
    };

    let licenseId: string;
    if (existing !== null) {
      await tx.providerStateLicense.update({ where: { id: existing.id }, data });
      licenseId = existing.id;
    } else {
      try {
        const created = await tx.providerStateLicense.create({
          data: {
            organizationId: ctx.organizationId,
            providerId: provider.id,
            state,
            licenseNumber,
            ...data,
          },
          select: { id: true },
        });
        licenseId = created.id;
      } catch (cause) {
        if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
          // Concurrent record of the same licence. The caller's intent
          // is already satisfied; surface it rather than a raw P2002.
          throw new errors.ConflictError({
            code: "RECORD_LICENSE_CONCURRENT",
            message: "This licence was recorded concurrently. Reload the prescriber.",
            metadata: { providerId: provider.id, state },
            cause,
          });
        }
        throw cause;
      }
    }

    const expiresAtIso = expiresAt === null ? null : expiresAt.toISOString().slice(0, 10);
    const licenseType = input.licenseType === undefined ? null : input.licenseType.trim();

    return {
      output: Object.freeze({
        licenseId,
        providerId: provider.id,
        state,
        licenseNumber,
        expiresAt: expiresAtIso,
        renewed,
      }),
      audit: {
        action: "provider.state_license.recorded",
        resourceType: "ProviderStateLicense",
        resourceId: licenseId,
        metadata: {
          providerId: provider.id,
          npi: provider.npi,
          state,
          licenseNumber,
          licenseType,
          expiresAt: expiresAtIso,
          hasExpiry: expiresAt !== null,
          verificationMethod,
          renewed,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.state_license.recorded.v1",
          aggregateType: "ProviderStateLicense",
          aggregateId: licenseId,
          payload: {
            organizationId: ctx.organizationId,
            licenseId,
            providerId: provider.id,
            npi: provider.npi,
            state,
            licenseNumber,
            licenseType,
            expiresAt: expiresAtIso,
            renewed,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
