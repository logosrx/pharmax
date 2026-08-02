// provider.onboarding.review_required.v1 — automated NPPES proofing
// could not cleanly verify an application; it moved to the ops
// review queue (ADR-0033).
//
// Producer: `RecordProviderOnboardingProofing` (`@pharmax/providers`)
//   on any non-PASS outcome.
// Consumers: ops notification fan-out (review-queue alerting);
//   onboarding funnel reporting.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    applicationId: z.uuid(),
    organizationId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    /** Why proofing did not pass; mirrors ProviderOnboardingProofingOutcome minus PASS. */
    proofingOutcome: z.enum([
      "NOT_FOUND",
      "NOT_INDIVIDUAL",
      "DEACTIVATED",
      "NAME_MISMATCH",
      "ALREADY_REGISTERED",
      "REGISTRY_UNAVAILABLE",
    ]),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderOnboardingReviewRequiredV1 = defineEvent({
  name: "provider.onboarding.review_required",
  version: 1,
  aggregateType: "ProviderOnboardingApplication",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.applicationId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by RecordProviderOnboardingProofing when the automated NPPES check returns any non-PASS outcome and the application transitions SUBMITTED → NEEDS_REVIEW. The system never hard-rejects on registry data — a human decides from here.",
});

export type ProviderOnboardingReviewRequiredV1Payload = z.infer<typeof payloadSchema>;
