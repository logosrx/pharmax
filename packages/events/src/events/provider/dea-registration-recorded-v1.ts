// provider.dea_registration.recorded.v1 — a prescriber's DEA
// registration was recorded or renewed.
//
// Producer: `RecordProviderDeaRegistration` (`@pharmax/providers`).
// Consumers: compliance reporting ("which prescribers can write CII,
//   and when does that lapse"); the credential-expiry warning drain.
//
// THE DEA NUMBER IS NOT IN THE PAYLOAD. It is a controlled-substance
// prescribing credential, and `event_outbox` is a durable, widely-read
// table — a dump of it should not be a list of numbers someone can
// forge prescriptions with. Consumers that legitimately need the
// number join through `providerId` behind
// `providers.credentials.read`. This matches what the superseded
// `Provider.deaNumber` column's commands did, which carried `hasDea`
// rather than the string.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const SCHEDULES = ["NON_CONTROLLED", "CII", "CIII", "CIV", "CV"] as const;
const REGISTRANT_TYPES = [
  "PRACTITIONER",
  "MID_LEVEL_PRACTITIONER",
  "NARCOTIC_TREATMENT_PROGRAM",
  "DATA_WAIVED_LEGACY",
  "NON_PRESCRIBING",
] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    registrationId: z.uuid(),
    providerId: z.uuid(),
    /** Public CMS identifier — the anchor a consumer joins on. */
    npi: z.string().regex(/^\d{10}$/),
    registrantType: z.enum(REGISTRANT_TYPES),
    /** Which schedules this registration authorizes. */
    authorizedSchedules: z.array(z.enum(SCHEDULES)),
    /** Null when no expiry was recorded — a gap, not a lapse. */
    expiresAt: z.iso.date().nullable(),
    /** True when this renewed an existing registration. */
    renewed: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderDeaRegistrationRecordedV1 = defineEvent({
  name: "provider.dea_registration.recorded",
  version: 1,
  aggregateType: "ProviderDeaRegistration",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.registrationId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.credentials",
  description:
    "Emitted when a prescriber's DEA registration is recorded or renewed. Carries registrant type, authorized schedules and expiry, but NOT the DEA number — event_outbox is durable and widely read, and a dump of it should not be a list of forgeable prescribing credentials.",
});

export type ProviderDeaRegistrationRecordedV1Payload = z.infer<typeof payloadSchema>;
