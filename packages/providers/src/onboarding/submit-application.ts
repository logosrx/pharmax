// SubmitProviderOnboardingApplication — a prescriber's self-serve
// application to join an org's roster (ADR-0033, slice 1).
//
// Dispatched by the public apply endpoint as the org's
// ProviderOnboardingService machine user (the applicant has no
// principal yet). The command:
//
//   - pins the ACTIVE `provider.onboarding` policy (first non-order
//     workflow policy — the auditable half of the workflow engine
//     generalizes before the TypeScript half does),
//   - refuses NPIs already on the roster (apply is for JOINING, not
//     updating — an existing provider goes through UpdateProvider),
//   - relies on the partial unique index
//     `provider_onboarding_application_open_unique` for the "one
//     open application per (org, npi)" invariant, translated to a
//     typed 409.
//
// PHI: none anywhere in this flow. The claim is the prescriber's
// own public professional identity (NPI + office contact).

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma, ProviderOnboardingStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  loadOnboardingPolicy,
  PROVIDER_ONBOARDING_ALREADY_OPEN,
  PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED,
} from "./shared.js";

const inputSchema = z
  .object({
    npi: z.string().regex(/^\d{10}$/, "expected exactly 10 digits"),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    credential: z.string().min(1).max(40).optional(),
    email: z.email().max(320),
    phone: z.string().min(7).max(40).optional(),
  })
  .strict();

export type SubmitProviderOnboardingApplicationInput = z.infer<typeof inputSchema>;

export interface SubmitProviderOnboardingApplicationOutput {
  readonly applicationId: string;
  readonly status: "SUBMITTED";
}

export const SubmitProviderOnboardingApplication: Command<
  SubmitProviderOnboardingApplicationInput,
  SubmitProviderOnboardingApplicationOutput
> = {
  name: "SubmitProviderOnboardingApplication",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<SubmitProviderOnboardingApplicationOutput>> {
    const policy = await loadOnboardingPolicy(tx, ctx.organizationId);

    // Roster gate: an NPI that already has a roster row cannot
    // "apply to join". Checked before insert so the applicant gets
    // an actionable 409 instead of a review-queue dead end.
    const existingProvider = await tx.provider.findUnique({
      where: { organizationId_npi: { organizationId: ctx.organizationId, npi: input.npi } },
      select: { id: true },
    });
    if (existingProvider !== null) {
      throw new errors.ConflictError({
        code: PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED,
        message: `NPI ${input.npi} is already on this organization's roster.`,
        metadata: { npi: input.npi },
      });
    }

    const now = clock.now();
    const applicationId = randomUUID();
    try {
      await tx.providerOnboardingApplication.create({
        data: {
          id: applicationId,
          organizationId: ctx.organizationId,
          npi: input.npi,
          firstName: input.firstName,
          lastName: input.lastName,
          ...(input.credential === undefined ? {} : { credential: input.credential }),
          email: input.email,
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          status: ProviderOnboardingStatus.SUBMITTED,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // The partial unique index (org, npi) WHERE status IN
        // (SUBMITTED, NEEDS_REVIEW) — at most one open application
        // per prescriber per org.
        throw new errors.ConflictError({
          code: PROVIDER_ONBOARDING_ALREADY_OPEN,
          message: `An onboarding application for NPI ${input.npi} is already open in this organization.`,
          metadata: { npi: input.npi },
        });
      }
      throw err;
    }

    return {
      output: { applicationId, status: "SUBMITTED" },
      audit: {
        action: "provider.onboarding.submitted",
        resourceType: "ProviderOnboardingApplication",
        resourceId: applicationId,
        metadata: {
          npi: input.npi,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.onboarding.submitted.v1",
          aggregateType: "ProviderOnboardingApplication",
          aggregateId: applicationId,
          payload: {
            applicationId,
            organizationId: ctx.organizationId,
            npi: input.npi,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
