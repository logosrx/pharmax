// compliance.control.signed_off.v1 — a named human attested that a
// control is designed and operating.
//
// Producer: `SignOffControl` (`@pharmax/compliance`).
//
// Why this event exists separately from the probe run history: the
// runs establish that the platform keeps CHECKING a control; this
// establishes that a person accountable for it looked at the evidence
// and put their name to it. An auditor asks for both, and they answer
// different questions. Automated evidence with no human attestation
// is monitoring; attestation with no automated evidence is a claim.
//
// Consumers (current):
//   - Nightly security digest: surfaces controls whose attestation is
//     approaching or past its review cadence.
//
// Consumers (future):
//   - SOC 2 evidence-pack runner (attestation register per period).
//   - Compliance dashboard tile ("CC6.1-2 signed off 12 days ago").
//
// Note on tenancy: the control itself is PLATFORM-level (see
// schema.prisma §10), but the attesting operator belongs to an
// organization, so the event is emitted into that org's outbox and
// its audit chain. `organizationId` here identifies the ATTESTER's
// tenancy, not a scope on the control.
//
// PHI invariant: control codes, role titles, operator uuids, and a
// free-text attestation note authored by an operator. No patient
// data — the compliance surface never reads a patient column.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    controlId: z.uuid(),
    /** Stable control identifier, e.g. "CC6.1-2". */
    controlCode: z.string().min(1).max(64),
    /** Attester's tenancy, NOT a scope on the control. */
    organizationId: z.uuid(),
    /** Control status at the moment of attestation. */
    status: z.enum(["IMPLEMENTED", "PARTIAL", "PLANNED", "DEPRECATED", "NOT_APPLICABLE"]),
    /** Role title accountable for the control. */
    ownerRole: z.string().min(1).max(200),
    /** Operator who signed. Never null — an unattributed attestation
     *  is not an attestation. */
    signedOffByUserId: z.uuid(),
    signedOffAt: z.iso.datetime({ offset: true }),
    /** Operator-authored note recorded with the signature. */
    attestationNote: z.string().max(4000).nullable(),
    /** Probes linked to this control at attestation time, and how many
     *  were passing. Frozen here so the event alone shows what the
     *  signer was looking at. */
    linkedCheckCount: z.int().min(0),
    passingCheckCount: z.int().min(0),
    /** Audit chain hop: control → this commandLog. */
    commandLogId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ComplianceControlSignedOffV1 = defineEvent({
  name: "compliance.control.signed_off",
  version: 1,
  aggregateType: "ComplianceControl",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.controlId,
  owner: "security",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.compliance",
  description:
    "Emitted by SignOffControl when a named operator attests that a control is designed and operating. Carries the passing/linked probe counts the signer was shown, so the attestation and its supporting evidence stay joined.",
});

export type ComplianceControlSignedOffV1Payload = z.infer<typeof payloadSchema>;
