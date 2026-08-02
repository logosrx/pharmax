// provider.onboarding.submitted.v1 — a prescriber filed a
// self-serve onboarding application (ADR-0033).
//
// Producer: `SubmitProviderOnboardingApplication` (`@pharmax/providers`).
// Consumers: worker NPPES proofing drain trigger (the drain polls,
//   but the event is the durable record); ops onboarding dashboards.
//
// PHI: none. NPI is a public CMS identifier; the applicant's name
// and contact are intentionally NOT in the payload (the application
// row is the source of truth — the event only anchors WHICH
// prescriber applied WHERE).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    applicationId: z.uuid(),
    organizationId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderOnboardingSubmittedV1 = defineEvent({
  name: "provider.onboarding.submitted",
  version: 1,
  aggregateType: "ProviderOnboardingApplication",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.applicationId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by SubmitProviderOnboardingApplication after the application row is persisted in SUBMITTED. Carries the public NPI and the application id — never the applicant's name or contact details.",
});

export type ProviderOnboardingSubmittedV1Payload = z.infer<typeof payloadSchema>;
