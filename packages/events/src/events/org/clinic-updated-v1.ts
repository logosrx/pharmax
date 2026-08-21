// org.clinic.updated.v1 — a client practice's directory details changed.
//
// Producer: `UpdateClinic` (`@pharmax/orgs`).
// Consumers: admin activity feed; any read model that caches the client
//   name for display (queue rows show it on every order).
//
// `code` is NOT in the payload as a changeable field because it is
// immutable once issued — invoices and prescriptions cite it, so
// renaming it retroactively would rewrite the meaning of records
// already sent to a customer. Only `name` can change.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    /** Immutable identifier, carried so consumers need not join. */
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgClinicUpdatedV1 = defineEvent({
  name: "org.clinic.updated",
  version: 1,
  aggregateType: "Clinic",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.clinicId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by UpdateClinic when a client practice's display name changes. The client code is immutable and never appears here as a changed value.",
});

export type OrgClinicUpdatedV1Payload = z.infer<typeof payloadSchema>;
