// EndProviderClinicAffiliation — withdraw a prescriber's authority to
// write for a client practice.
//
// The row is transitioned to ENDED, never deleted. "Who was allowed to
// prescribe for this client last March" is a question an access review
// asks, and a deleted row cannot answer it. The table grants no DELETE
// to either database role for the same reason.
//
// A REASON IS REQUIRED, and unusually it is carried in the outbox
// payload as well as the audit row. This is the one direction of the
// grant where "why" is asked months later: a prescriber who left a
// practice and one who was removed for cause produce an identical row
// otherwise, and only the first is a routine roster change.
//
// SESSION REVOCATION. Ending an affiliation revokes every portal
// session still acting for that client on this prescriber's behalf, in
// the same transaction. Withdrawing authority while leaving a live,
// correctly-scoped session open would mean the revocation takes effect
// whenever the prescriber next signs in — which is to say, not when it
// was ordered. Note the filter is (activeClinicId, portalAccount ->
// providerId): only this prescriber's sessions for this client, never
// another prescriber's.
//
// PHI: none. `reason` describes a business relationship and must not
// describe a patient — reviewer-enforced, length-capped here.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { AuthSessionRevokeReason, ClinicProviderAffiliationStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const END_AFFILIATION_NOT_FOUND = "END_AFFILIATION_NOT_FOUND";
export const END_AFFILIATION_ALREADY_ENDED = "END_AFFILIATION_ALREADY_ENDED";

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    providerId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type EndProviderClinicAffiliationInput = z.infer<typeof inputSchema>;

export interface EndProviderClinicAffiliationOutput {
  readonly affiliationId: string;
  readonly clinicId: string;
  readonly providerId: string;
  readonly revokedPortalSessionCount: number;
}

export const EndProviderClinicAffiliation: Command<
  EndProviderClinicAffiliationInput,
  EndProviderClinicAffiliationOutput
> = {
  name: "EndProviderClinicAffiliation",
  inputSchema,
  permission: PERMISSIONS.CLINICS_AFFILIATE_PROVIDER,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<EndProviderClinicAffiliationOutput>> {
    const affiliation = await tx.clinicProviderAffiliation.findFirst({
      where: {
        organizationId: ctx.organizationId,
        clinicId: input.clinicId,
        providerId: input.providerId,
      },
      select: {
        id: true,
        status: true,
        clinic: { select: { id: true, code: true } },
        provider: { select: { id: true, npi: true } },
      },
    });
    if (affiliation === null) {
      throw new errors.NotFoundError({
        code: END_AFFILIATION_NOT_FOUND,
        message: "This prescriber is not affiliated with this client.",
        metadata: { clinicId: input.clinicId, providerId: input.providerId },
      });
    }
    if (affiliation.status === ClinicProviderAffiliationStatus.ENDED) {
      throw new errors.ValidationError({
        code: END_AFFILIATION_ALREADY_ENDED,
        message: "This affiliation has already been ended.",
        metadata: { affiliationId: affiliation.id },
      });
    }

    const now = clock.now();

    await tx.clinicProviderAffiliation.update({
      where: { id: affiliation.id },
      data: {
        status: ClinicProviderAffiliationStatus.ENDED,
        endedAt: now,
        endedReason: input.reason,
        endedByUserId: ctx.actor.userId,
      },
    });

    // Only THIS prescriber's sessions for THIS client. A shared filter
    // on activeClinicId alone would sign out every prescriber at the
    // client because one of them lost access.
    const revoked = await tx.portalSession.updateMany({
      where: {
        organizationId: ctx.organizationId,
        activeClinicId: affiliation.clinic.id,
        revokedAt: null,
        portalAccount: { providerId: affiliation.provider.id },
      },
      data: {
        revokedAt: now,
        revokedReason: AuthSessionRevokeReason.ADMIN_REVOKED,
      },
    });

    return {
      output: Object.freeze({
        affiliationId: affiliation.id,
        clinicId: affiliation.clinic.id,
        providerId: affiliation.provider.id,
        revokedPortalSessionCount: revoked.count,
      }),
      audit: {
        action: "org.clinic_provider_affiliation.ended",
        resourceType: "ClinicProviderAffiliation",
        resourceId: affiliation.id,
        metadata: {
          clinicId: affiliation.clinic.id,
          clinicCode: affiliation.clinic.code,
          providerId: affiliation.provider.id,
          npi: affiliation.provider.npi,
          reason: input.reason,
          revokedPortalSessionCount: revoked.count,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.clinic_provider_affiliation.ended.v1",
          aggregateType: "ClinicProviderAffiliation",
          aggregateId: affiliation.id,
          payload: {
            organizationId: ctx.organizationId,
            affiliationId: affiliation.id,
            clinicId: affiliation.clinic.id,
            providerId: affiliation.provider.id,
            npi: affiliation.provider.npi,
            reason: input.reason,
            revokedPortalSessionCount: revoked.count,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
