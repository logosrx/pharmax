// RegisterProvider — the prescriber-registration command.
//
// Why this is simpler than RegisterPatient:
//
//   - Provider data is plaintext on purpose. NPI is a public CMS
//     registry identifier. Practice contact info is the prescriber's
//     office, not patient data. No encryption, no blind indexes.
//
//   - The one credential we treat as confidential is `deaNumber`.
//     It's not technically PHI, but it IS a controlled-substance
//     prescribing credential. Leaking it into command_log makes a
//     forensic dump of that log a tool for prescription fraud. We:
//       * redact `deaNumber` from command_log.requestPayload
//         (top-level key, picked up by the bus's per-command
//         redactFields list),
//       * keep `deaNumber` OUT of audit metadata and outbox payload
//         (we expose `hasDea` as a boolean instead).
//
//   - NPI is intentionally KEPT in audit metadata and the outbox
//     payload. The whole point of `provider.registered.v1` is "we
//     added this NPI to the directory"; consumers (and SOC 2
//     reviewers) need the NPI for the event to be useful.
//
// Uniqueness:
//   - The schema enforces `@@unique([organizationId, npi])`. Two
//     orgs can each have their own row for the same prescriber
//     (they're separate tenants); within one org, NPI is unique.
//   - Prisma raises P2002 on conflict; we translate to a typed
//     ConflictError(PROVIDER_NPI_TAKEN) the API layer can map to 409.
//
// What this DOES NOT do:
//   - NPI registry lookup. Production will validate `npi` against
//     a snapshot of the CMS NPI registry to fail fast on typos and
//     auto-fill name/credential. That's a future enhancement; for
//     now we trust the operator and let the unique constraint catch
//     accidental duplicates.
//
//   - DEA checksum validation. The DEA's two-letter + 7-digit format
//     has a checksum on the last digit; we accept the regex shape and
//     defer the checksum check to a future hardening pass so a
//     malformed-but-shape-valid DEA doesn't block intake.

import { randomUUID } from "node:crypto";

import { errors } from "@pharmax/platform-core";
import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  ControlledSubstanceSchedule,
  CredentialStatus,
  CredentialVerificationMethod,
  Prisma,
  ProviderStatus,
} from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { validateDeaNumber, type DeaValidationSuccess } from "../dea/validate-dea-number.js";

/** A supplied DEA number failed offline validation. */
export const PROVIDER_DEA_INVALID = "PROVIDER_DEA_INVALID";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    // 10 digits, no separators. CMS NPI is exactly 10.
    npi: z.string().regex(/^\d{10}$/, "expected exactly 10 digits"),

    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),

    // Free-text credential (MD, DO, NP, PA, PharmD, etc.). We cap
    // length to keep storage predictable; we don't enum it because
    // the long tail of valid credentials is large and ever-growing.
    credential: z.string().min(1).max(40).optional(),

    // Optional convenience: onboarding usually has the DEA number to
    // hand, and making the operator run a second command for it is
    // friction with no safety benefit. Shape is checked here; the
    // checksum, registrant type and surname cross-check run in the
    // handler via `validateDeaNumber`, which also accepts the `9`
    // second character this regex used to refuse.
    //
    // Expiry and per-schedule authority are NOT inputs here. Those are
    // what `RecordProviderDeaRegistration` is for — a registration
    // recorded at onboarding gets every controlled schedule and no
    // expiry, matching what the old `deaNumber` column conferred.
    deaNumber: z
      .string()
      .regex(/^[A-Za-z][A-Za-z9]\d{7}$/, "expected a letter, a letter or 9, then seven digits")
      .optional(),

    // Practice contact (public, not PHI).
    phone: z.string().min(7).max(40).optional(),
    email: z.email().max(320).optional(),
    addressLine1: z.string().min(1).max(200).optional(),
    addressLine2: z.string().min(1).max(200).optional(),
    city: z.string().min(1).max(100).optional(),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, "expected 2-letter state code")
      .optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}(-\d{4})?$/, "expected ZIP or ZIP+4")
      .optional(),
  })
  .strict();

export type RegisterProviderInput = z.infer<typeof inputSchema>;

export interface RegisterProviderOutput {
  readonly providerId: string;
}

// The only field we redact from command_log.requestPayload. NPI is
// intentionally NOT redacted (it's a public identifier and the audit
// trail's primary anchor for this command).
const REDACT_FIELDS = Object.freeze(["deaNumber"] as const);

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const RegisterProvider: Command<RegisterProviderInput, RegisterProviderOutput> = {
  name: "RegisterProvider",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_CREATE,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RegisterProviderOutput>> {
    const now = clock.now();
    const providerId = randomUUID();

    // Validate before writing anything: a bad check digit should refuse
    // the whole registration rather than leave a prescriber row behind
    // with no credential and no explanation.
    let deaValidation: DeaValidationSuccess | null = null;
    if (input.deaNumber !== undefined) {
      const result = validateDeaNumber({
        deaNumber: input.deaNumber,
        lastName: input.lastName,
      });
      if (!result.ok) {
        throw new errors.ValidationError({
          code: PROVIDER_DEA_INVALID,
          message: result.message,
          issues: [{ path: ["deaNumber"], message: result.message }],
          // The number itself stays out of the error: it is redacted
          // from command_log for the same reason.
          metadata: { reason: result.code },
        });
      }
      if (!result.canPrescribe) {
        throw new errors.ValidationError({
          code: PROVIDER_DEA_INVALID,
          message: `This DEA number is registered to a ${result.registrantType.toLowerCase().replace(/_/g, " ")}, which cannot write prescriptions.`,
          issues: [{ path: ["deaNumber"], message: "not a prescribing registrant type" }],
          metadata: { reason: "NOT_A_PRESCRIBING_REGISTRANT" },
        });
      }
      deaValidation = result;
    }

    // Single-row insert. organizationId is auto-injected by the
    // tenancy extension, but we set it explicitly so the row data
    // is self-documenting at the call site (and so test fakes that
    // don't run the extension still receive the correct value).
    try {
      await tx.provider.create({
        data: {
          id: providerId,
          organizationId: ctx.organizationId,
          npi: input.npi,
          firstName: input.firstName,
          lastName: input.lastName,
          ...(input.credential === undefined ? {} : { credential: input.credential }),
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.addressLine1 === undefined ? {} : { addressLine1: input.addressLine1 }),
          ...(input.addressLine2 === undefined ? {} : { addressLine2: input.addressLine2 }),
          ...(input.city === undefined ? {} : { city: input.city }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.postalCode === undefined ? {} : { postalCode: input.postalCode }),
          status: ProviderStatus.ACTIVE,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // The only unique constraint on Provider is
        // `@@unique([organizationId, npi])`. Surface a typed
        // conflict so the API layer can map to 409 + the right
        // operator-facing message.
        throw new errors.ConflictError({
          code: "PROVIDER_NPI_TAKEN",
          cause: err,
          message: `A provider with NPI ${input.npi} is already registered in this organization.`,
          metadata: { npi: input.npi },
        });
      }
      throw err;
    }

    // Same transaction as the provider row: a prescriber who appears
    // registered but whose DEA silently failed to save is the state
    // that produces an unexplained refusal at PV1.
    if (deaValidation !== null) {
      await tx.providerDeaRegistration.create({
        data: {
          organizationId: ctx.organizationId,
          providerId,
          deaNumber: deaValidation.deaNumber,
          registrantType: deaValidation.registrantType,
          // Every controlled schedule, matching exactly what the
          // superseded `deaNumber` column conferred. Narrowing at
          // onboarding would refuse prescriptions the old code allowed.
          authorizedSchedules: [
            ControlledSubstanceSchedule.CII,
            ControlledSubstanceSchedule.CIII,
            ControlledSubstanceSchedule.CIV,
            ControlledSubstanceSchedule.CV,
          ],
          status: CredentialStatus.ACTIVE,
          verificationMethod: CredentialVerificationMethod.ATTESTED,
          recordedByUserId: ctx.actor.userId,
        },
      });
    }

    const hasContact = input.phone !== undefined || input.email !== undefined;
    const hasAddress =
      input.addressLine1 !== undefined ||
      input.addressLine2 !== undefined ||
      input.city !== undefined ||
      input.state !== undefined ||
      input.postalCode !== undefined;

    return {
      output: { providerId },
      audit: {
        action: "provider.registered",
        resourceType: "Provider",
        resourceId: providerId,
        metadata: {
          // NPI in audit is intentional (see file comment); DEA is
          // expressed as a presence boolean only.
          npi: input.npi,
          hasDea: input.deaNumber !== undefined,
          hasCredential: input.credential !== undefined,
          hasContact,
          hasAddress,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.registered.v1",
          aggregateType: "Provider",
          aggregateId: providerId,
          payload: {
            providerId,
            organizationId: ctx.organizationId,
            npi: input.npi,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
