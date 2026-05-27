// provider.deactivated.v1 — a prescriber row was flipped ACTIVE → INACTIVE.
//
// Producer: `DeactivateProvider` (`@pharmax/providers`).
// Consumers:
//   - SOC 2 provider-roster audit feed (severity branching on
//     `DEA_SURRENDERED_OR_REVOKED` / `SANCTIONED`).
//   - Future "halt in-flight controlled-substance fills" worker that
//     subscribes on the high-severity reason codes.
//   - Prescriber-roster cache invalidation.
//
// PHI: none. Carries the public NPI, the closed-enum reason code,
// and TWO boolean snapshots:
//
//   - `hasReasonText` — was a free-text rationale supplied at the
//     command? Operators read this to decide whether to surface a
//     "view rationale" link in the UI; the bytes themselves never
//     ride along, only the boolean. The text lives in command_log
//     (redacted) and never in audit/outbox payload.
//   - `hadDea` — did the provider row carry a DEA number at the
//     moment of deactivation? Drives "how many DEA-bearing
//     providers did we deactivate this quarter?" compliance
//     reports without ever shipping the DEA bytes off the row.
//
// The reason ENUM is duplicated here as a Zod tuple rather than
// imported from `@pharmax/providers` to keep `@pharmax/events`
// dependency-free (the registry must NOT depend on producer
// packages or we get a cycle). The enum is closed; if a new reason
// code lands, this file updates in lockstep with
// `@pharmax/providers/commands/deactivate-provider.ts`.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const PROVIDER_DEACTIVATION_REASONS = [
  "RETIRED",
  "RELOCATED",
  "RELATIONSHIP_ENDED",
  "LICENSE_EXPIRED",
  "DEA_SURRENDERED_OR_REVOKED",
  "SANCTIONED",
  "DECEASED",
  "DUPLICATE_RECORD",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    providerId: z.uuid(),
    organizationId: z.uuid(),
    /** Public 10-digit National Provider Identifier. */
    npi: z.string().regex(/^\d{10}$/),
    reason: z.enum(PROVIDER_DEACTIVATION_REASONS),
    /** True when the operator attached a free-text rationale. */
    hasReasonText: z.boolean(),
    /** Pre-deactivation snapshot of whether the provider had a DEA number. */
    hadDea: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderDeactivatedV1 = defineEvent({
  name: "provider.deactivated",
  version: 1,
  aggregateType: "Provider",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.providerId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by DeactivateProvider after the ACTIVE → INACTIVE CAS commits. Carries NPI + closed-enum reason + boolean rationale/DEA snapshots; never carries the free-text reason or the DEA number itself.",
});

export type ProviderDeactivatedV1Payload = z.infer<typeof payloadSchema>;
