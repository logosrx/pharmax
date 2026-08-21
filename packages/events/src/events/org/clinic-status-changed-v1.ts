// org.clinic.status_changed.v1 — a client practice was deactivated,
// reactivated, or archived.
//
// Producer: `SetClinicStatus` (`@pharmax/orgs`).
// Consumers: security feeds (deactivation revokes portal sessions, so
//   this is the paired announcement of a forced sign-out); admin
//   activity feed; billing, which should stop accruing against an
//   archived client.
//
// ONE event carrying from/to rather than a deactivated/reactivated
// pair, matching the compound-batch transition precedent: ClinicStatus
// has three members, so an event per transition would multiply without
// telling a consumer anything the pair of statuses does not.
//
// `revokedPortalSessionCount` is carried because deactivation has a
// side effect a consumer cannot infer — every provider-portal session
// still acting for this client is revoked in the same transaction. A
// security feed needs the count to distinguish "switched off an unused
// client" from "signed nine prescribers out mid-session".
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const CLINIC_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    code: z.string().min(1).max(64),
    fromStatus: z.enum(CLINIC_STATUSES),
    toStatus: z.enum(CLINIC_STATUSES),
    reason: z.string().min(1).max(500),
    /** Portal sessions revoked as a side effect; 0 on reactivation. */
    revokedPortalSessionCount: z.number().int().nonnegative(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgClinicStatusChangedV1 = defineEvent({
  name: "org.clinic.status_changed",
  version: 1,
  aggregateType: "Clinic",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.clinicId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by SetClinicStatus on any clinic status transition. Carries the count of provider-portal sessions revoked as a side effect, which a consumer cannot derive from the status pair alone.",
});

export type OrgClinicStatusChangedV1Payload = z.infer<typeof payloadSchema>;
