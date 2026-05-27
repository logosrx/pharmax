// provider.registered.v1 — a prescriber was added to the directory.
//
// Producer: `RegisterProvider` (`@pharmax/providers`).
// Consumers: future NPI-registry reconciliation handler; SOC 2
//   provider-roster audit feed.
//
// PHI: none. NPI is a public CMS prescriber identifier — not PHI
// under HIPAA. DEA number is intentionally NOT in this payload
// (it's a controlled-substance prescribing credential whose leak
// makes a forensic dump of this log a fraud vector); only the
// `hasDea` boolean is present.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    providerId: z.uuid(),
    organizationId: z.uuid(),
    /**
     * 10-digit National Provider Identifier. Public registry id;
     * safe to include. Validated at the command boundary.
     */
    npi: z.string().regex(/^\d{10}$/),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderRegisteredV1 = defineEvent({
  name: "provider.registered",
  version: 1,
  aggregateType: "Provider",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.providerId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by RegisterProvider after the provider row is persisted. Carries the public NPI and the row id — never the DEA number or any prescriber PII.",
});

export type ProviderRegisteredV1Payload = z.infer<typeof payloadSchema>;
