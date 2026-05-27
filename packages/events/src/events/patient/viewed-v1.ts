// patient.viewed.v1 — an operator viewed a patient's decrypted PHI.
//
// Producer: `ViewPatient` (`@pharmax/patients`), invoked from any
//   server-rendered page (e.g. order detail, patient admin) before
//   it shows PHI on screen. The HIPAA-Required "access log".
//
// Consumers: PHI access-audit projections; future "who viewed
//   my record?" patient-portal feed.
//
// PHI invariant: this payload is PHI-FREE. It records the FACT
// that a view occurred (patient id + actor + surface + decrypt
// error count), but never any decrypted patient attribute.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

/**
 * Surface from which the view fired. Closed set — adding a new
 * surface MUST extend this enum and the matching column in the
 * downstream projection. Keeps audit consumers from drowning in
 * untyped free-text "where did this come from?" strings.
 */
const VIEW_SURFACES = [
  "ORDER_DETAIL_PAGE",
  "PATIENT_ADMIN_PAGE",
  "PATIENT_SEARCH_RESULT",
  "ORDER_TIMELINE",
  "BILLING_PAGE",
] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    patientId: z.uuid(),
    /** Which screen / API surface triggered the view. */
    surface: z.enum(VIEW_SURFACES),
    /**
     * Order id surfaced when the view originated from an
     * order-bound surface. Absent for direct patient-admin views.
     */
    orderId: z.uuid().optional(),
    actorUserId: z.uuid(),
    /**
     * Number of PHI fields that failed decrypt (e.g. envelope
     * version mismatch, KMS unavailable). Non-zero values are
     * surfaced to ops as a degraded-read signal; the page still
     * rendered the rest of the record.
     */
    phiDecryptErrors: z.number().int().min(0),
    /**
     * `true` when the row was crypto-shredded — the view rendered
     * a tombstone, not PHI. Audit consumers count these
     * separately so a shredded-record probe doesn't pollute the
     * "operator viewed PHI" projection.
     */
    wasShredded: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientViewedV1 = defineEvent({
  name: "patient.viewed",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: true,
  routingKey: "patient.access",
  description:
    "Emitted by ViewPatient before any server-rendered page shows decrypted PHI. The HIPAA-required access-log signal — drives the PHI access-audit projection.",
});

export type PatientViewedV1Payload = z.infer<typeof payloadSchema>;
