// provider.onboarding.approved.v1 — an onboarding application was
// approved and the prescriber joined the roster (ADR-0033).
//
// Producer: `RecordProviderOnboardingProofing` (automated PASS) or
//   `ApproveProviderOnboardingApplication` (human review decision).
//   Both also emit `provider.registered.v1` for the created roster
//   row — this event is the ONBOARDING trail; that one is the
//   roster trail.
// Consumers: slice-2 portal-account provisioning (setup-token
//   issuance rides this event); onboarding funnel reporting.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    applicationId: z.uuid(),
    organizationId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    /** The roster row created by the approval. */
    providerId: z.uuid(),
    /** True for a proofing-PASS auto-approval (no human in the loop). */
    autoApproved: z.boolean(),
    /** Null for auto-approvals; the reviewing operator otherwise. */
    decidedByUserId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderOnboardingApprovedV1 = defineEvent({
  name: "provider.onboarding.approved",
  version: 1,
  aggregateType: "ProviderOnboardingApplication",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.applicationId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted when an onboarding application transitions to APPROVED — automatically on a clean NPPES proofing PASS, or by a human reviewer from NEEDS_REVIEW. `autoApproved` + `decidedByUserId` make the two paths distinguishable in the audit trail.",
});

export type ProviderOnboardingApprovedV1Payload = z.infer<typeof payloadSchema>;
