// RecordProviderDeaRegistration — record or renew a prescriber's DEA
// registration.
//
// This is the command that decides whether controlled prescriptions may
// be written, so it is the one place the three facts the old
// `Provider.deaNumber` column could not hold are captured: when the
// registration expires, what kind of registrant it belongs to, and
// which schedules it authorizes.
//
// RENEWAL IS AN UPDATE, NOT AN INSERT. `(organizationId, deaNumber)` is
// unique, so re-recording a number the org already knows updates that
// row's expiry and schedules. A renewal is the same registration with a
// later date — inserting a second row would leave two answers to "is
// this registration current", and the gate would take whichever it read
// first.
//
// SCHEDULES MUST BE STATED. There is no default. The onboarding path in
// `RegisterProvider` grants all four controlled schedules because it is
// preserving what the superseded column implicitly conferred, but an
// operator recording a registration deliberately has to say what it
// covers — silently granting Schedule II because a field was left blank
// is the mistake worth designing out.
//
// PHI: none, but a DEA number is a controlled-substance prescribing
// credential. It is redacted from `command_log`, kept out of audit
// metadata and out of the outbox payload; presence and authority are
// expressed there instead.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  ControlledSubstanceSchedule,
  CredentialStatus,
  CredentialVerificationMethod,
  Prisma,
  ProviderStatus,
} from "@pharmax/database";
import { errors, geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { validateDeaNumber } from "../dea/validate-dea-number.js";

export const RECORD_DEA_PROVIDER_NOT_FOUND = "RECORD_DEA_PROVIDER_NOT_FOUND";
export const RECORD_DEA_PROVIDER_INACTIVE = "RECORD_DEA_PROVIDER_INACTIVE";
export const RECORD_DEA_INVALID = "RECORD_DEA_INVALID";
export const RECORD_DEA_NUMBER_BELONGS_TO_ANOTHER_PROVIDER =
  "RECORD_DEA_NUMBER_BELONGS_TO_ANOTHER_PROVIDER";
export const RECORD_DEA_UNKNOWN_STATE = "RECORD_DEA_UNKNOWN_STATE";

/**
 * Only controlled schedules may be authorized. NON_CONTROLLED is a
 * member of the enum because a `Product` needs to say "not controlled",
 * but a DEA registration that authorizes it would be meaningless — and
 * accepting it would let a caller supply a schedule list that looks
 * populated while granting nothing.
 */
const CONTROLLED_ONLY = [
  ControlledSubstanceSchedule.CII,
  ControlledSubstanceSchedule.CIII,
  ControlledSubstanceSchedule.CIV,
  ControlledSubstanceSchedule.CV,
] as const;

const inputSchema = z
  .object({
    providerId: z.uuid(),
    /** Letter, letter-or-9, seven digits. Normalized in the handler. */
    deaNumber: z
      .string()
      .regex(/^[A-Za-z][A-Za-z9]\d{7}$/, "expected a letter, a letter or 9, then seven digits"),
    /** At least one, all controlled. See CONTROLLED_ONLY. */
    authorizedSchedules: z.array(z.enum(CONTROLLED_ONLY)).min(1),
    /** DEA registrations are site-specific; informational today. */
    issuedState: z.string().length(2).optional(),
    issuedAt: z.iso.date().optional(),
    /**
     * Optional because a pharmacy migrating on may not have it to
     * hand. Absent means "not recorded" and does not block prescribing;
     * see the model comment for why that is the safe default rather
     * than the lax one.
     */
    expiresAt: z.iso.date().optional(),
    verificationMethod: z.enum(CredentialVerificationMethod).optional(),
  })
  .strict();

export type RecordProviderDeaRegistrationInput = z.infer<typeof inputSchema>;

export interface RecordProviderDeaRegistrationOutput {
  readonly registrationId: string;
  readonly providerId: string;
  readonly registrantType: string;
  readonly authorizedSchedules: ReadonlyArray<ControlledSubstanceSchedule>;
  readonly expiresAt: string | null;
  /** True when an existing registration was renewed rather than added. */
  readonly renewed: boolean;
}

const REDACT_FIELDS = Object.freeze(["deaNumber"] as const);

export const RecordProviderDeaRegistration: Command<
  RecordProviderDeaRegistrationInput,
  RecordProviderDeaRegistrationOutput
> = {
  name: "RecordProviderDeaRegistration",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_CREDENTIALS_MANAGE,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<RecordProviderDeaRegistrationOutput>> {
    const provider = await tx.provider.findFirst({
      where: { id: input.providerId, organizationId: ctx.organizationId },
      select: { id: true, npi: true, lastName: true, status: true },
    });
    if (provider === null) {
      throw new errors.NotFoundError({
        code: RECORD_DEA_PROVIDER_NOT_FOUND,
        message: "Prescriber not found in this organization.",
        metadata: { providerId: input.providerId },
      });
    }
    if (provider.status !== ProviderStatus.ACTIVE) {
      throw new errors.ValidationError({
        code: RECORD_DEA_PROVIDER_INACTIVE,
        message: `Prescriber is ${provider.status}. Reactivate them before recording a credential.`,
        metadata: { providerId: provider.id, status: provider.status },
      });
    }

    // Offline validation: check digit, registrant type, and the
    // surname cross-check that catches a valid number belonging to a
    // different prescriber.
    const validation = validateDeaNumber({
      deaNumber: input.deaNumber,
      lastName: provider.lastName,
    });
    if (!validation.ok) {
      throw new errors.ValidationError({
        code: RECORD_DEA_INVALID,
        message: validation.message,
        issues: [{ path: ["deaNumber"], message: validation.message }],
        metadata: { reason: validation.code },
      });
    }
    if (!validation.canPrescribe) {
      throw new errors.ValidationError({
        code: RECORD_DEA_INVALID,
        message: `This DEA number is registered to a ${validation.registrantType
          .toLowerCase()
          .replace(/_/g, " ")}, which cannot write prescriptions.`,
        issues: [{ path: ["deaNumber"], message: "not a prescribing registrant type" }],
        metadata: { reason: "NOT_A_PRESCRIBING_REGISTRANT" },
      });
    }

    let issuedState: string | null = null;
    if (input.issuedState !== undefined) {
      issuedState = geo.normalizeJurisdictionCode(input.issuedState);
      if (issuedState === null) {
        throw new errors.ValidationError({
          code: RECORD_DEA_UNKNOWN_STATE,
          message: `"${input.issuedState}" is not a US state or territory code.`,
          issues: [{ path: ["issuedState"], message: "unknown jurisdiction" }],
        });
      }
    }

    // The number is unique per ORG, not per provider, so an existing
    // row may belong to someone else. That is a data-entry error worth
    // naming: silently moving a registration between prescribers would
    // transfer prescribing authority.
    const existing = await tx.providerDeaRegistration.findFirst({
      where: { organizationId: ctx.organizationId, deaNumber: validation.deaNumber },
      select: { id: true, providerId: true },
    });
    if (existing !== null && existing.providerId !== provider.id) {
      throw new errors.ConflictError({
        code: RECORD_DEA_NUMBER_BELONGS_TO_ANOTHER_PROVIDER,
        message:
          "This DEA number is already recorded against a different prescriber in this organization. Check which prescriber it belongs to.",
        metadata: { providerId: provider.id, conflictingProviderId: existing.providerId },
      });
    }

    const now = clock.now();
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    const issuedAt = input.issuedAt === undefined ? null : new Date(input.issuedAt);
    const verificationMethod = input.verificationMethod ?? CredentialVerificationMethod.ATTESTED;
    const renewed = existing !== null;

    let registrationId: string;
    if (existing !== null) {
      // Renewal. Status returns to ACTIVE: recording a current
      // registration over a revoked one is how a reinstatement is
      // entered, and leaving it REVOKED would keep refusing.
      await tx.providerDeaRegistration.update({
        where: { id: existing.id },
        data: {
          registrantType: validation.registrantType,
          authorizedSchedules: input.authorizedSchedules,
          issuedState,
          issuedAt,
          expiresAt,
          status: CredentialStatus.ACTIVE,
          verificationMethod,
          verifiedAt: verificationMethod === CredentialVerificationMethod.ATTESTED ? null : now,
          verifiedByUserId:
            verificationMethod === CredentialVerificationMethod.ATTESTED ? null : ctx.actor.userId,
          recordedByUserId: ctx.actor.userId,
        },
      });
      registrationId = existing.id;
    } else {
      try {
        const created = await tx.providerDeaRegistration.create({
          data: {
            organizationId: ctx.organizationId,
            providerId: provider.id,
            deaNumber: validation.deaNumber,
            registrantType: validation.registrantType,
            authorizedSchedules: input.authorizedSchedules,
            issuedState,
            issuedAt,
            expiresAt,
            status: CredentialStatus.ACTIVE,
            verificationMethod,
            verifiedAt: verificationMethod === CredentialVerificationMethod.ATTESTED ? null : now,
            verifiedByUserId:
              verificationMethod === CredentialVerificationMethod.ATTESTED
                ? null
                : ctx.actor.userId,
            recordedByUserId: ctx.actor.userId,
          },
          select: { id: true },
        });
        registrationId = created.id;
      } catch (cause) {
        if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
          throw new errors.ConflictError({
            code: RECORD_DEA_NUMBER_BELONGS_TO_ANOTHER_PROVIDER,
            message:
              "This DEA number was recorded concurrently. Reload the prescriber and check the registration.",
            metadata: { providerId: provider.id },
            cause,
          });
        }
        throw cause;
      }
    }

    const expiresAtIso = expiresAt === null ? null : expiresAt.toISOString().slice(0, 10);

    return {
      output: Object.freeze({
        registrationId,
        providerId: provider.id,
        registrantType: validation.registrantType,
        authorizedSchedules: Object.freeze([...input.authorizedSchedules]),
        expiresAt: expiresAtIso,
        renewed,
      }),
      audit: {
        action: "provider.dea_registration.recorded",
        resourceType: "ProviderDeaRegistration",
        resourceId: registrationId,
        metadata: {
          providerId: provider.id,
          // NPI is the public anchor; the DEA number never appears.
          npi: provider.npi,
          registrantType: validation.registrantType,
          authorizedSchedules: [...input.authorizedSchedules],
          expiresAt: expiresAtIso,
          hasExpiry: expiresAt !== null,
          verificationMethod,
          renewed,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.dea_registration.recorded.v1",
          aggregateType: "ProviderDeaRegistration",
          aggregateId: registrationId,
          payload: {
            organizationId: ctx.organizationId,
            registrationId,
            providerId: provider.id,
            npi: provider.npi,
            registrantType: validation.registrantType,
            authorizedSchedules: [...input.authorizedSchedules],
            expiresAt: expiresAtIso,
            renewed,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
