// org.clinic.created.v1 — a client practice was onboarded.
//
// Producer: `CreateClinic` (`@pharmax/orgs`).
// Consumers: billing (a clinic is the invoicing counterparty, so a new
//   one may need a Stripe customer); admin activity feed; saved-view
//   tooling that caches the org's client vocabulary.
//
// Until this command existed the only code that created a clinic row
// was `prisma/seed.ts`, which meant onboarding a real customer's
// practice required a hand-written INSERT — no audit row, no RBAC
// check, no event. This event is the first durable record that a
// client exists.
//
// PHI: none. Directory metadata and ids only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    /** Org-unique client identifier, cited by invoices and prescriptions. */
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgClinicCreatedV1 = defineEvent({
  name: "org.clinic.created",
  version: 1,
  aggregateType: "Clinic",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.clinicId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by CreateClinic after a client practice is persisted. A clinic is the billing counterparty for every order placed under it, so downstream billing setup keys off this event.",
});

export type OrgClinicCreatedV1Payload = z.infer<typeof payloadSchema>;
