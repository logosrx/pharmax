// RejectProviderOnboardingApplication — a human reviewer rejects a
// NEEDS_REVIEW application from the ops queue (ADR-0033).
//
// There is no automated rejection anywhere in the pipeline: every
// rejection carries a human user stamp and a reason code. Rejection
// is terminal for THIS application but not for the prescriber —
// the partial unique index only spans open applications, so a
// rejected applicant may reapply.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ProviderOnboardingStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND,
  PROVIDER_ONBOARDING_INVALID_STATE,
} from "./shared.js";

const inputSchema = z
  .object({
    applicationId: z.uuid(),
    reasonCode: z.string().min(1).max(100),
  })
  .strict();

export type RejectProviderOnboardingApplicationInput = z.infer<typeof inputSchema>;

export interface RejectProviderOnboardingApplicationOutput {
  readonly applicationId: string;
  readonly status: "REJECTED";
}

export const RejectProviderOnboardingApplication: Command<
  RejectProviderOnboardingApplicationInput,
  RejectProviderOnboardingApplicationOutput
> = {
  name: "RejectProviderOnboardingApplication",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RejectProviderOnboardingApplicationOutput>> {
    const app = await tx.providerOnboardingApplication.findUnique({
      where: { id: input.applicationId },
      select: { id: true, status: true, npi: true, proofingOutcome: true },
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
        message: `Application is ${app.status}; only NEEDS_REVIEW applications can be rejected.`,
        metadata: { applicationId: input.applicationId, status: app.status },
      });
    }

    const now = clock.now();
    await tx.providerOnboardingApplication.update({
      where: { id: app.id },
      data: {
        status: ProviderOnboardingStatus.REJECTED,
        decidedByUserId: ctx.actor.userId,
        decidedAt: now,
        decisionReasonCode: input.reasonCode,
      },
      select: { id: true },
    });

    return {
      output: { applicationId: app.id, status: "REJECTED" },
      audit: {
        action: "provider.onboarding.rejected",
        resourceType: "ProviderOnboardingApplication",
        resourceId: app.id,
        metadata: {
          npi: app.npi,
          reasonCode: input.reasonCode,
          proofingOutcome: app.proofingOutcome,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.onboarding.rejected.v1",
          aggregateType: "ProviderOnboardingApplication",
          aggregateId: app.id,
          payload: {
            applicationId: app.id,
            organizationId: ctx.organizationId,
            npi: app.npi,
            decidedByUserId: ctx.actor.userId,
            reasonCode: input.reasonCode,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
