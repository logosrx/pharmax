// provider.reactivated.v1 — a prescriber row was flipped INACTIVE → ACTIVE.
//
// Producer: `ReactivateProvider` (`@pharmax/providers`).
// Consumers:
//   - SOC 2 provider-roster audit feed.
//   - Future "resume in-flight controlled-substance fills" worker
//     that subscribes on `DEA_RESTORED` / `SANCTION_LIFTED`. The
//     symmetric counterpart of the deactivation worker that halts
//     CS fills on the high-severity codes — once the prescriber is
//     cleared, parked orders can be released back into the workflow.
//   - Prescriber-roster cache invalidation.
//
// PHI: none. Mirror of `provider.deactivated.v1` — carries the
// public NPI, the closed-enum reactivation reason, and TWO boolean
// snapshots:
//
//   - `hasReasonText` — was a free-text rationale supplied at the
//     command? Operators read this to decide whether to surface a
//     "view rationale" link in the UI; the bytes themselves never
//     ride along, only the boolean. The text lives in command_log
//     (redacted) and never in audit/outbox payload.
//   - `hadDea` — does the provider row carry a DEA number at the
//     moment of reactivation? Drives compliance reports about
//     CS-prescribing reactivations without ever shipping the DEA
//     bytes off the row.
//
// The reason ENUM is duplicated here as a Zod tuple rather than
// imported from `@pharmax/providers` to keep `@pharmax/events`
// dependency-free (the registry must NOT depend on producer
// packages or we get a cycle). The enum is closed; if a new reason
// code lands, this file updates in lockstep with
// `@pharmax/providers/commands/reactivate-provider.ts`.
//
// IMPORTANT — this enum is INTENTIONALLY DISTINCT from
// `provider.deactivated.v1`'s enum. They are not inverses of each
// other and they don't share a closed set: `DECEASED` and
// `DUPLICATE_RECORD` have no reactivation counterpart (terminal
// states), and `ERRONEOUS_DEACTIVATION` only makes sense in the
// reactivation direction (the audit-correction path).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const PROVIDER_REACTIVATION_REASONS = [
  "LICENSE_RESTORED",
  "DEA_RESTORED",
  "SANCTION_LIFTED",
  "RELATIONSHIP_RESUMED",
  "RETURNED_FROM_RETIREMENT",
  "RELOCATED_BACK_INTO_AREA",
  "ERRONEOUS_DEACTIVATION",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    providerId: z.uuid(),
    organizationId: z.uuid(),
    /** Public 10-digit National Provider Identifier. */
    npi: z.string().regex(/^\d{10}$/),
    reason: z.enum(PROVIDER_REACTIVATION_REASONS),
    /** True when the operator attached a free-text rationale. */
    hasReasonText: z.boolean(),
    /** Pre-reactivation snapshot of whether the provider has a DEA number. */
    hadDea: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderReactivatedV1 = defineEvent({
  name: "provider.reactivated",
  version: 1,
  aggregateType: "Provider",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.providerId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.roster",
  description:
    "Emitted by ReactivateProvider after the INACTIVE → ACTIVE CAS commits. Carries NPI + closed-enum reason + boolean rationale/DEA snapshots; never carries the free-text reason or the DEA number itself. Counterpart to provider.deactivated.v1; reason vocabularies are deliberately distinct.",
});

export type ProviderReactivatedV1Payload = z.infer<typeof payloadSchema>;
