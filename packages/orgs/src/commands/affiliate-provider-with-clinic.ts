// AffiliateProviderWithClinic — grant a prescriber authority to write
// for a client practice.
//
// One prescriber commonly writes for several clients. Before this
// command, `Provider` was org-wide with no client dimension at all, so
// the product could not express "Dr. Chen writes for Valley Wellness
// but not for Coastal Med" — and the portal had no basis on which to
// scope what a signed-in prescriber could see.
//
// UPSERT, NOT INSERT. `(organizationId, clinicId, providerId)` is
// unique, so re-affiliating a prescriber whose affiliation was ended
// flips the existing row back to ACTIVE rather than inserting a
// second one. Two rows for one relationship would make "is this
// prescriber authorized" a question about which row you happened to
// read, and would scatter the history of a single relationship.
//
// The reactivation path must clear `endedAt`, `endedReason` and
// `endedByUserId` — the table's CHECK constraint refuses a row that is
// ACTIVE while still carrying an ending.
//
// Guards:
//   1. Client exists in the actor's org and is ACTIVE. Affiliating to a
//      deactivated client would create authority to write for a client
//      that cannot receive orders.
//   2. Prescriber exists in the actor's org and is ACTIVE. An INACTIVE
//      prescriber is one the pharmacy has deliberately stopped
//      accepting; granting them a client is a contradiction.
//   3. Not already ACTIVE — surfaced as a conflict, not a silent no-op.
//
// PHI: none. Prescriber identity is public NPI-registry data.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  ClinicProviderAffiliationStatus,
  ClinicStatus,
  Prisma,
  ProviderStatus,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const AFFILIATE_PROVIDER_CLINIC_NOT_FOUND = "AFFILIATE_PROVIDER_CLINIC_NOT_FOUND";
export const AFFILIATE_PROVIDER_CLINIC_NOT_ACTIVE = "AFFILIATE_PROVIDER_CLINIC_NOT_ACTIVE";
export const AFFILIATE_PROVIDER_NOT_FOUND = "AFFILIATE_PROVIDER_NOT_FOUND";
export const AFFILIATE_PROVIDER_NOT_ACTIVE = "AFFILIATE_PROVIDER_NOT_ACTIVE";
export const AFFILIATE_PROVIDER_ALREADY_AFFILIATED = "AFFILIATE_PROVIDER_ALREADY_AFFILIATED";

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    providerId: z.uuid(),
  })
  .strict();

export type AffiliateProviderWithClinicInput = z.infer<typeof inputSchema>;

export interface AffiliateProviderWithClinicOutput {
  readonly affiliationId: string;
  readonly clinicId: string;
  readonly providerId: string;
  /** True when a previously-ended affiliation was restored. */
  readonly reactivated: boolean;
}

export const AffiliateProviderWithClinic: Command<
  AffiliateProviderWithClinicInput,
  AffiliateProviderWithClinicOutput
> = {
  name: "AffiliateProviderWithClinic",
  inputSchema,
  permission: PERMISSIONS.CLINICS_AFFILIATE_PROVIDER,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<AffiliateProviderWithClinicOutput>> {
    const clinic = await tx.clinic.findFirst({
      where: { id: input.clinicId, organizationId: ctx.organizationId },
      select: { id: true, code: true, status: true },
    });
    if (clinic === null) {
      throw new errors.NotFoundError({
        code: AFFILIATE_PROVIDER_CLINIC_NOT_FOUND,
        message: "Client not found in this organization.",
        metadata: { clinicId: input.clinicId },
      });
    }
    if (clinic.status !== ClinicStatus.ACTIVE) {
      throw new errors.ValidationError({
        code: AFFILIATE_PROVIDER_CLINIC_NOT_ACTIVE,
        message: `Client is ${clinic.status}. Reactivate it before affiliating prescribers.`,
        metadata: { clinicId: clinic.id, status: clinic.status },
      });
    }

    const provider = await tx.provider.findFirst({
      where: { id: input.providerId, organizationId: ctx.organizationId },
      select: { id: true, npi: true, status: true },
    });
    if (provider === null) {
      throw new errors.NotFoundError({
        code: AFFILIATE_PROVIDER_NOT_FOUND,
        message: "Prescriber not found in this organization.",
        metadata: { providerId: input.providerId },
      });
    }
    if (provider.status !== ProviderStatus.ACTIVE) {
      throw new errors.ValidationError({
        code: AFFILIATE_PROVIDER_NOT_ACTIVE,
        message: `Prescriber is ${provider.status}. Reactivate the prescriber before affiliating them with a client.`,
        metadata: { providerId: provider.id, status: provider.status },
      });
    }

    const existing = await tx.clinicProviderAffiliation.findFirst({
      where: {
        organizationId: ctx.organizationId,
        clinicId: clinic.id,
        providerId: provider.id,
      },
      select: { id: true, status: true },
    });

    if (existing !== null && existing.status === ClinicProviderAffiliationStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: AFFILIATE_PROVIDER_ALREADY_AFFILIATED,
        message: "This prescriber is already affiliated with this client.",
        metadata: { affiliationId: existing.id, clinicId: clinic.id, providerId: provider.id },
      });
    }

    const now = clock.now();
    let affiliationId: string;
    const reactivated = existing !== null;

    if (existing !== null) {
      // ENDED -> ACTIVE. The ending must be cleared or the CHECK
      // constraint refuses the row.
      await tx.clinicProviderAffiliation.update({
        where: { id: existing.id },
        data: {
          status: ClinicProviderAffiliationStatus.ACTIVE,
          affiliatedAt: now,
          endedAt: null,
          endedReason: null,
          endedByUserId: null,
          createdByUserId: ctx.actor.userId,
        },
      });
      affiliationId = existing.id;
    } else {
      try {
        const created = await tx.clinicProviderAffiliation.create({
          data: {
            organizationId: ctx.organizationId,
            clinicId: clinic.id,
            providerId: provider.id,
            status: ClinicProviderAffiliationStatus.ACTIVE,
            affiliatedAt: now,
            createdByUserId: ctx.actor.userId,
          },
          select: { id: true },
        });
        affiliationId = created.id;
      } catch (cause) {
        // Concurrent affiliation of the same pair. The read above did
        // not see it, so this is a genuine race rather than a stale
        // form; either way the caller's intent is already satisfied.
        if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
          throw new errors.ConflictError({
            code: AFFILIATE_PROVIDER_ALREADY_AFFILIATED,
            message: "This prescriber is already affiliated with this client.",
            metadata: { clinicId: clinic.id, providerId: provider.id },
            cause,
          });
        }
        throw cause;
      }
    }

    return {
      output: Object.freeze({
        affiliationId,
        clinicId: clinic.id,
        providerId: provider.id,
        reactivated,
      }),
      audit: {
        action: "org.clinic_provider_affiliation.created",
        resourceType: "ClinicProviderAffiliation",
        resourceId: affiliationId,
        metadata: {
          clinicId: clinic.id,
          clinicCode: clinic.code,
          providerId: provider.id,
          npi: provider.npi,
          reactivated,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.clinic_provider_affiliation.created.v1",
          aggregateType: "ClinicProviderAffiliation",
          aggregateId: affiliationId,
          payload: {
            organizationId: ctx.organizationId,
            affiliationId,
            clinicId: clinic.id,
            providerId: provider.id,
            npi: provider.npi,
            reactivated,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
