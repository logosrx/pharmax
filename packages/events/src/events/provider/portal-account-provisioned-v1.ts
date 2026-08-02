// provider.portal_account.provisioned.v1 — a portal credential slot
// was created for an approved prescriber (ADR-0033, slice 2).
//
// Producer: `RecordProviderOnboardingProofing` (automated PASS) or
//   `ApproveProviderOnboardingApplication` (human review) — the
//   PortalAccount row is created in the SAME transaction as the
//   roster row, status PENDING_SETUP, no credential yet.
// Consumers: onboarding funnel reporting; ops visibility.
//
// The setup TOKEN is never in this payload — it is a bearer secret,
// minted post-commit by `IssuePortalSetupToken` and delivered only
// via the mailer port.
//
// PHI: none (office contact email is public professional data, and
// even that is omitted — ids only).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    portalAccountId: z.uuid(),
    organizationId: z.uuid(),
    providerId: z.uuid(),
    /** The approved application that drove provisioning. */
    applicationId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderPortalAccountProvisionedV1 = defineEvent({
  name: "provider.portal_account.provisioned",
  version: 1,
  aggregateType: "PortalAccount",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.portalAccountId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.portal",
  description:
    "Emitted when onboarding approval provisions a PENDING_SETUP portal credential slot for the new roster provider. The one-time setup token is minted separately post-commit and never appears in any event payload.",
});

export type ProviderPortalAccountProvisionedV1Payload = z.infer<typeof payloadSchema>;
