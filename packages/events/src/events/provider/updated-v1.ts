// provider.updated.v1 — provider directory row was mutated.
//
// Producer: `UpdateProvider` (`@pharmax/providers`).
// Consumers: prescriber-roster cache invalidation; SOC 2
//   credential-change audit feed.
//
// PHI: none. Carries NPI + lists of changed-field names — no
// values, no DEA. The `deaNumber` field name is allowed in the
// changed-field list (so audit consumers can flag a DEA mutation
// for credential review) but the actual number is never in the
// payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const PROVIDER_MUTABLE_FIELD_NAMES = [
  "firstName",
  "middleName",
  "lastName",
  "credentials",
  "deaNumber",
  "specialty",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "phone",
  "email",
] as const;

const payloadSchema = z
  .object({
    providerId: z.uuid(),
    organizationId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    /** Fields that received a new non-null value. */
    updatedFields: z.array(z.enum(PROVIDER_MUTABLE_FIELD_NAMES)),
    /** Fields that were cleared. Disjoint from updatedFields. */
    clearedFields: z.array(z.enum(PROVIDER_MUTABLE_FIELD_NAMES)),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderUpdatedV1 = defineEvent({
  name: "provider.updated",
  version: 1,
  aggregateType: "Provider",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.providerId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by UpdateProvider after a provider mutation. Carries NPI and changed-field-name lists — never values, never the DEA number itself.",
});

export type ProviderUpdatedV1Payload = z.infer<typeof payloadSchema>;
