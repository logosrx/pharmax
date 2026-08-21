// provider.state_license.recorded.v1 — a prescriber's state licence to
// practise was recorded or renewed.
//
// Producer: `RecordProviderStateLicense` (`@pharmax/providers`).
// Consumers: compliance reporting; the credential-expiry warning drain.
//
// The licence NUMBER is carried here, unlike the DEA number in the
// sibling event. The asymmetry is deliberate and not an oversight:
// state boards publish licence numbers in searchable public
// directories, so the number is already public information, whereas a
// DEA number is a controlled-substance prescribing credential the DEA
// does not publish.
//
// PHI: none. A prescriber's professional licence is public record.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    licenseId: z.uuid(),
    providerId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    state: z.string().regex(/^[A-Z]{2}$/),
    licenseNumber: z.string().min(1).max(64),
    licenseType: z.string().min(1).max(64).nullable(),
    /** Null when no expiry was recorded — a gap, not a lapse. */
    expiresAt: z.iso.date().nullable(),
    renewed: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderStateLicenseRecordedV1 = defineEvent({
  name: "provider.state_license.recorded",
  version: 1,
  aggregateType: "ProviderStateLicense",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.licenseId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.credentials",
  description:
    "Emitted when a prescriber's state licence is recorded or renewed. Carries the licence number, unlike the DEA event — state boards publish licence numbers in public directories, so it is already public information.",
});

export type ProviderStateLicenseRecordedV1Payload = z.infer<typeof payloadSchema>;
