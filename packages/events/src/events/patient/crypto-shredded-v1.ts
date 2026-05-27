// patient.crypto_shredded.v1 — patient PHI was crypto-shredded.
//
// Producer: `CryptoShredPatient` (`@pharmax/patients`).
// Consumers: compliance ledger (right-to-be-forgotten satisfaction);
//   downstream cache invalidation.
//
// PHI invariant: this payload is PHI-FREE. The point of the
// command is to RENDER PHI unreadable — the event reports the
// disposition (reason code only), not the data.
//
// `reason` mirrors `CRYPTO_SHRED_REASONS` from `@pharmax/crypto`.
// We re-declare the literal union here so `@pharmax/events` does
// not depend on the crypto package (definition lives upstream of
// the producer to keep the dependency graph acyclic).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const CRYPTO_SHRED_REASONS = [
  "right-to-be-forgotten",
  "data-retention-expiry",
  "regulatory-order",
  "tenant-offboarding",
  "incident-response",
] as const;

const payloadSchema = z
  .object({
    patientId: z.uuid(),
    organizationId: z.uuid(),
    reason: z.enum(CRYPTO_SHRED_REASONS),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientCryptoShreddedV1 = defineEvent({
  name: "patient.crypto_shredded",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: true,
  routingKey: "patient.compliance",
  description:
    "Emitted by CryptoShredPatient after the per-row DEK is destroyed. Anchors the right-to-be-forgotten / data-retention compliance ledger.",
});

export type PatientCryptoShreddedV1Payload = z.infer<typeof payloadSchema>;
