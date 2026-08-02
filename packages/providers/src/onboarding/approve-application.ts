// ApproveProviderOnboardingApplication — a human reviewer approves
// a NEEDS_REVIEW application from the ops queue (ADR-0033).
//
// The automated path (proofing PASS) never comes through here — it
// approves inside RecordProviderOnboardingProofing. This command is
// exclusively the human override for applications the NPPES check
// could not cleanly verify, so it requires a reason code: the
// reviewer is attesting to identity the registry could not confirm.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ProviderOnboardingStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { provisionPortalAccountInTx } from "../portal/provision.js";
import {
  createRosterRowFromApplication,
  portalAccountProvisionedDraft,
  PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND,
  PROVIDER_ONBOARDING_INVALID_STATE,
  PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED,
  providerRegisteredDraft,
} from "./shared.js";

const inputSchema = z
  .object({
    applicationId: z.uuid(),
    /** Why the reviewer is approving despite the non-PASS proofing outcome. */
    reasonCode: z.string().min(1).max(100),
  })
  .strict();

export type ApproveProviderOnboardingApplicationInput = z.infer<typeof inputSchema>;

export interface ApproveProviderOnboardingApplicationOutput {
  readonly applicationId: string;
  readonly status: "APPROVED";
  readonly providerId: string;
  /**
   * The PENDING_SETUP portal credential slot provisioned with the
   * approval (ADR-0033 slice 2). Null when the application email is
   * already taken by another portal account in the org. The route's
   * post-commit hook issues the setup token via
   * `issuePortalSetupToken`.
   */
  readonly portalAccountId: string | null;
}

export const ApproveProviderOnboardingApplication: Command<
  ApproveProviderOnboardingApplicationInput,
  ApproveProviderOnboardingApplicationOutput
> = {
  name: "ApproveProviderOnboardingApplication",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<ApproveProviderOnboardingApplicationOutput>> {
    const app = await tx.providerOnboardingApplication.findUnique({
      where: { id: input.applicationId },
      select: {
        id: true,
        status: true,
        npi: true,
        firstName: true,
        lastName: true,
        credential: true,
        email: true,
        phone: true,
        proofingOutcome: true,
      },
    });
    if (app === null) {
      throw new errors.NotFoundError({
        code: PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND,
        message: "Onboarding application not found.",
        metadata: { applicationId: input.applicationId },
      });
    }
    if (app.status !== ProviderOnboardingStatus.NEEDS_REVIEW) {
      throw new errors.ConflictError({
        code: PROVIDER_ONBOARDING_INVALID_STATE,
        message: `Application is ${app.status}; only NEEDS_REVIEW applications can be approved by review.`,
        metadata: { applicationId: input.applicationId, status: app.status },
      });
    }

    // Roster gate — the reviewer can't approve a duplicate into a
    // unique-constraint failure; they get an actionable 409 and
    // reject the application as a duplicate instead.
    const existingProvider = await tx.provider.findUnique({
      where: { organizationId_npi: { organizationId: ctx.organizationId, npi: app.npi } },
      select: { id: true },
    });
    if (existingProvider !== null) {
      throw new errors.ConflictError({
        code: PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED,
        message: `NPI ${app.npi} is already on this organization's roster. Reject the application as a duplicate instead.`,
        metadata: { applicationId: input.applicationId, npi: app.npi },
      });
    }

    const now = clock.now();
    const occurredAt = now.toISOString();
    const providerId = await createRosterRowFromApplication(tx, ctx.organizationId, app);

    await tx.providerOnboardingApplication.update({
      where: { id: app.id },
      data: {
        status: ProviderOnboardingStatus.APPROVED,
        providerId,
        decidedByUserId: ctx.actor.userId,
        decidedAt: now,
        decisionReasonCode: input.reasonCode,
      },
      select: { id: true },
    });

    // Portal credential slot (ADR-0033 slice 2): atomic with the
    // roster row. Setup token minted post-commit by the route hook.
    const portal = await provisionPortalAccountInTx(tx, {
      organizationId: ctx.organizationId,
      providerId,
      applicationId: app.id,
      email: app.email,
      now,
    });

    return {
      output: {
        applicationId: app.id,
        status: "APPROVED",
        providerId,
        portalAccountId: portal.provisioned ? portal.portalAccountId : null,
      },
      audit: {
        action: "provider.onboarding.approved_by_review",
        resourceType: "ProviderOnboardingApplication",
        resourceId: app.id,
        metadata: {
          npi: app.npi,
          providerId,
          reasonCode: input.reasonCode,
          proofingOutcome: app.proofingOutcome,
          portalAccountProvisioned: portal.provisioned,
          ...(portal.provisioned ? {} : { portalSkipReason: portal.reason }),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.onboarding.approved.v1",
          aggregateType: "ProviderOnboardingApplication",
          aggregateId: app.id,
          payload: {
            applicationId: app.id,
            organizationId: ctx.organizationId,
            npi: app.npi,
            providerId,
            autoApproved: false,
            decidedByUserId: ctx.actor.userId,
            occurredAt,
          },
        },
        providerRegisteredDraft({
          providerId,
          organizationId: ctx.organizationId,
          npi: app.npi,
          occurredAt,
        }),
        ...(portal.provisioned
          ? [
              portalAccountProvisionedDraft({
                portalAccountId: portal.portalAccountId,
                organizationId: ctx.organizationId,
                providerId,
                applicationId: app.id,
                occurredAt,
              }),
            ]
          : []),
      ],
    };
  },
};
