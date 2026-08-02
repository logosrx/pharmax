// RecordProviderOnboardingProofing — the automated NPPES proofing
// verdict for a SUBMITTED application (ADR-0033, slice 1).
//
// Dispatched by the worker's proofing drain as the org's
// ProviderOnboardingService machine user. The drain computed the
// outcome with `evaluateProofing` (pure NPPES match rules); this
// command applies it:
//
//   - PASS  → APPROVED, and the roster row is created in the SAME
//     transaction (this is the "self-serve, no staff in the loop"
//     path). `decidedByUserId` stays null — the audit trail makes
//     automated approvals distinguishable from human ones.
//   - anything else → NEEDS_REVIEW with the outcome + evidence
//     snapshot; a human decides from the ops queue. The system
//     never hard-rejects on registry data alone.
//
// One in-command downgrade: a PASS whose NPI gained a roster row
// between submission and proofing (operator registered the
// prescriber manually in the window) becomes ALREADY_REGISTERED →
// NEEDS_REVIEW, so the reviewer can reject the application as a
// duplicate instead of the drain crashing on the unique constraint.

import type { Command, HandlerResult, OutboxEventDraft } from "@pharmax/command-bus";
import type { Prisma } from "@pharmax/database";
import { ProviderOnboardingProofingOutcome, ProviderOnboardingStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { provisionPortalAccountInTx } from "../portal/provision.js";
import {
  createRosterRowFromApplication,
  portalAccountProvisionedDraft,
  PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND,
  PROVIDER_ONBOARDING_INVALID_STATE,
  providerRegisteredDraft,
} from "./shared.js";

const inputSchema = z
  .object({
    applicationId: z.uuid(),
    // ALREADY_REGISTERED is intentionally absent: it is derived
    // in-command from the roster check, never asserted by the drain.
    outcome: z.enum([
      "PASS",
      "NOT_FOUND",
      "NOT_INDIVIDUAL",
      "DEACTIVATED",
      "NAME_MISMATCH",
      "REGISTRY_UNAVAILABLE",
    ]),
    /**
     * Normalized public NPPES record that drove the verdict
     * (`buildProofingSnapshotJson`). Absent for NOT_FOUND /
     * REGISTRY_UNAVAILABLE — there is no record to snapshot.
     */
    snapshot: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type RecordProviderOnboardingProofingInput = z.infer<typeof inputSchema>;

export interface RecordProviderOnboardingProofingOutput {
  readonly applicationId: string;
  readonly status: "APPROVED" | "NEEDS_REVIEW";
  readonly proofingOutcome: ProviderOnboardingProofingOutcome;
  /** Set only on the APPROVED path. */
  readonly providerId: string | null;
  /**
   * The PENDING_SETUP portal credential slot provisioned with the
   * approval (ADR-0033 slice 2). Null on the NEEDS_REVIEW path, and
   * null on APPROVED when the application email is already taken by
   * another portal account in the org (provisioning skipped; ops can
   * provision manually). The caller issues the one-time setup token
   * post-commit via `issuePortalSetupToken`.
   */
  readonly portalAccountId: string | null;
}

export const RecordProviderOnboardingProofing: Command<
  RecordProviderOnboardingProofingInput,
  RecordProviderOnboardingProofingOutput
> = {
  name: "RecordProviderOnboardingProofing",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RecordProviderOnboardingProofingOutput>> {
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
      },
    });
    if (app === null) {
      throw new errors.NotFoundError({
        code: PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND,
        message: "Onboarding application not found.",
        metadata: { applicationId: input.applicationId },
      });
    }
    if (app.status !== ProviderOnboardingStatus.SUBMITTED) {
      // A sibling worker pod won the race, or a reviewer already
      // decided. Benign for retries under the same idempotency key
      // (the bus replays); a conflicting NEW dispatch is a real 409.
      throw new errors.ConflictError({
        code: PROVIDER_ONBOARDING_INVALID_STATE,
        message: `Application is ${app.status}; proofing applies only to SUBMITTED applications.`,
        metadata: { applicationId: input.applicationId, status: app.status },
      });
    }

    const now = clock.now();
    const occurredAt = now.toISOString();
    const snapshotJson = (input.snapshot ?? null) as Prisma.InputJsonValue | null;

    // PASS requires the roster slot to still be free.
    let effectiveOutcome: ProviderOnboardingProofingOutcome =
      ProviderOnboardingProofingOutcome[input.outcome];
    if (input.outcome === "PASS") {
      const existingProvider = await tx.provider.findUnique({
        where: { organizationId_npi: { organizationId: ctx.organizationId, npi: app.npi } },
        select: { id: true },
      });
      if (existingProvider !== null) {
        effectiveOutcome = ProviderOnboardingProofingOutcome.ALREADY_REGISTERED;
      }
    }

    if (effectiveOutcome === ProviderOnboardingProofingOutcome.PASS) {
      const providerId = await createRosterRowFromApplication(tx, ctx.organizationId, app);
      await tx.providerOnboardingApplication.update({
        where: { id: app.id },
        data: {
          status: ProviderOnboardingStatus.APPROVED,
          proofingOutcome: effectiveOutcome,
          ...(snapshotJson === null ? {} : { proofingSnapshot: snapshotJson }),
          proofedAt: now,
          providerId,
          decidedAt: now,
          // decidedByUserId stays null — automated approval.
        },
        select: { id: true },
      });

      // Portal credential slot (ADR-0033 slice 2): atomic with the
      // roster row. Setup token minted post-commit by the caller.
      const portal = await provisionPortalAccountInTx(tx, {
        organizationId: ctx.organizationId,
        providerId,
        applicationId: app.id,
        email: app.email,
        now,
      });

      const approvedEvent: OutboxEventDraft = {
        eventType: "provider.onboarding.approved.v1",
        aggregateType: "ProviderOnboardingApplication",
        aggregateId: app.id,
        payload: {
          applicationId: app.id,
          organizationId: ctx.organizationId,
          npi: app.npi,
          providerId,
          autoApproved: true,
          decidedByUserId: null,
          occurredAt,
        },
      };

      return {
        output: {
          applicationId: app.id,
          status: "APPROVED",
          proofingOutcome: effectiveOutcome,
          providerId,
          portalAccountId: portal.provisioned ? portal.portalAccountId : null,
        },
        audit: {
          action: "provider.onboarding.auto_approved",
          resourceType: "ProviderOnboardingApplication",
          resourceId: app.id,
          metadata: {
            npi: app.npi,
            providerId,
            proofingOutcome: effectiveOutcome,
            portalAccountProvisioned: portal.provisioned,
            ...(portal.provisioned ? {} : { portalSkipReason: portal.reason }),
            commandLogId,
          },
        },
        outboxEvents: [
          approvedEvent,
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
    }

    // Non-PASS (including the ALREADY_REGISTERED downgrade) →
    // review queue.
    await tx.providerOnboardingApplication.update({
      where: { id: app.id },
      data: {
        status: ProviderOnboardingStatus.NEEDS_REVIEW,
        proofingOutcome: effectiveOutcome,
        ...(snapshotJson === null ? {} : { proofingSnapshot: snapshotJson }),
        proofedAt: now,
      },
      select: { id: true },
    });

    return {
      output: {
        applicationId: app.id,
        status: "NEEDS_REVIEW",
        proofingOutcome: effectiveOutcome,
        providerId: null,
        portalAccountId: null,
      },
      audit: {
        action: "provider.onboarding.review_required",
        resourceType: "ProviderOnboardingApplication",
        resourceId: app.id,
        metadata: {
          npi: app.npi,
          proofingOutcome: effectiveOutcome,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.onboarding.review_required.v1",
          aggregateType: "ProviderOnboardingApplication",
          aggregateId: app.id,
          payload: {
            applicationId: app.id,
            organizationId: ctx.organizationId,
            npi: app.npi,
            proofingOutcome: effectiveOutcome,
            occurredAt,
          },
        },
      ],
    };
  },
};
