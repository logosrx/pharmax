// provider.onboarding.rejected.v1 — a human reviewer rejected an
// onboarding application from the NEEDS_REVIEW queue (ADR-0033).
//
// Producer: `RejectProviderOnboardingApplication`. There is no
//   automated rejection path — every rejection has a human and a
//   reason code behind it.
// Consumers: onboarding funnel reporting; slice-2 applicant
//   notification.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    applicationId: z.uuid(),
    organizationId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    decidedByUserId: z.uuid(),
    reasonCode: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderOnboardingRejectedV1 = defineEvent({
  name: "provider.onboarding.rejected",
  version: 1,
  aggregateType: "ProviderOnboardingApplication",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.applicationId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by RejectProviderOnboardingApplication when a reviewer rejects from NEEDS_REVIEW. Always carries the deciding operator and a reason code — rejections are never automated and never anonymous.",
});

export type ProviderOnboardingRejectedV1Payload = z.infer<typeof payloadSchema>;
