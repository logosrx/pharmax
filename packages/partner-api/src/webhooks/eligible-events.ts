// Which registry events may leave the platform via partner webhooks.
//
// Rule (ADR-0032): ONLY events with `phiSafe: true` are eligible.
// The event registry is the single source of truth; eligibility is
// DERIVED, never hand-listed, so a new phi-safe event becomes
// subscribable without touching this file and a phi-bearing event
// can never be subscribed by construction.
//
// PHI: none — vocabulary metadata only.

import { listRegisteredEventDefinitions } from "@pharmax/events";

function buildEligibleSet(): ReadonlySet<string> {
  const eligible = new Set<string>();
  for (const def of listRegisteredEventDefinitions()) {
    if (def.phiSafe) {
      eligible.add(def.fullName);
    }
  }
  return Object.freeze(eligible);
}

/** Frozen set of versioned event names partners may subscribe to. */
export const WEBHOOK_ELIGIBLE_EVENT_TYPES: ReadonlySet<string> = buildEligibleSet();

export function isWebhookEligibleEventType(value: unknown): value is string {
  return typeof value === "string" && WEBHOOK_ELIGIBLE_EVENT_TYPES.has(value);
}

/** Sorted list for the OpenAPI docs + admin UI dropdowns. */
export function listWebhookEligibleEventTypes(): ReadonlyArray<string> {
  return Object.freeze([...WEBHOOK_ELIGIBLE_EVENT_TYPES].sort());
}
