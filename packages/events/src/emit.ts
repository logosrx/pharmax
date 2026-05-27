// emit() — typed (and legacy) helper that produces an outbox draft.
//
// Two call shapes:
//
//   1. Typed:    emit(OrderShippedV1, payload) — validates payload
//                against the definition's Zod schema; derives
//                eventType, aggregateType, and aggregateId from
//                the definition. The compiler enforces the payload
//                shape via `z.infer<typeof def.schema>`.
//
//   2. Legacy:   emit(eventName, payload, opts) — escape hatch for
//                events that have not been migrated into the registry
//                yet. Looks up the definition by name; if registered,
//                validates the same way the typed path does and
//                preserves the per-call `opts.aggregateType` /
//                `opts.aggregateId`. If unregistered, returns a
//                pass-through draft so the call site keeps working
//                — but the parity-guard test reports the missing
//                registration so it gets migrated.
//
// Why both call shapes:
//
//   The task allows a phased rollout. Domain teams adopt the typed
//   path one call site at a time; the legacy path keeps everything
//   else green in the interim. Once every event in the codebase is
//   registered and every call site is migrated, the legacy overload
//   can be deleted in a follow-up.

import { errors } from "@pharmax/platform-core";

import { type EventDefinition, type OutboxEventDraft, validateAgainst } from "./define-event.js";
import { getEventDefinition } from "./registry.js";

/**
 * Error code surfaced when the typed `emit()` rejects a payload
 * that does not satisfy the registered Zod schema. The bus's
 * existing `ValidationError` mapping converts this to a 400 for
 * the caller and a structured `command_log.errorCode` entry.
 */
export const EVENT_PAYLOAD_INVALID = "EVENT_PAYLOAD_INVALID";

/**
 * Options for the legacy call shape. `aggregateType` and
 * `aggregateId` mirror the existing `OutboxEventDraft` fields —
 * the caller knows them; we don't fabricate.
 */
export interface LegacyEmitOptions {
  readonly aggregateType: string;
  readonly aggregateId: string;
}

// ---------------------------------------------------------------------
// Overloads
// ---------------------------------------------------------------------

/**
 * Typed: validate the payload against the definition's schema and
 * return a fully-populated draft. Throws `ValidationError` on schema
 * mismatch (the bus surfaces this through its normal error path).
 */
export function emit<TPayload extends Record<string, unknown>>(
  definition: EventDefinition<TPayload>,
  payload: TPayload
): OutboxEventDraft;

/**
 * Legacy: pass the event name and payload directly. If the name is
 * registered, behaves like the typed path (validates against the
 * registered schema). If the name is not registered, returns a
 * pass-through draft using `opts.aggregateType` / `opts.aggregateId`.
 *
 * Migration target: every legacy call site should move to the typed
 * overload as the corresponding `EventDefinition` lands.
 */
export function emit(
  eventName: string,
  payload: Record<string, unknown>,
  opts: LegacyEmitOptions
): OutboxEventDraft;

export function emit<TPayload extends Record<string, unknown>>(
  defOrName: EventDefinition<TPayload> | string,
  payload: TPayload | Record<string, unknown>,
  opts?: LegacyEmitOptions
): OutboxEventDraft {
  if (typeof defOrName === "string") {
    return emitLegacy(defOrName, payload, opts);
  }
  return emitTyped(defOrName, payload as TPayload);
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function emitTyped<TPayload extends Record<string, unknown>>(
  definition: EventDefinition<TPayload>,
  payload: TPayload
): OutboxEventDraft {
  const validated = validateAgainst(definition, payload);
  if (!validated.ok) {
    throw new errors.ValidationError({
      code: EVENT_PAYLOAD_INVALID,
      message: `Outbox payload for "${definition.fullName}" failed schema validation.`,
      issues: validated.issues,
      metadata: { eventType: definition.fullName },
    });
  }
  const aggregateId = definition.aggregateIdFrom(validated.value);
  // Final defensive: an aggregateIdFrom selector that returns a
  // non-string would corrupt the outbox row. We assert here so the
  // error fires at the call site, not three layers down inside the
  // outbox drainer.
  if (typeof aggregateId !== "string" || aggregateId.length === 0) {
    throw new errors.InternalError({
      code: EVENT_PAYLOAD_INVALID,
      message: `Outbox definition "${definition.fullName}" produced a non-string aggregateId; check its aggregateIdFrom selector.`,
      metadata: { eventType: definition.fullName },
    });
  }
  return Object.freeze({
    eventType: definition.fullName,
    aggregateType: definition.aggregateType,
    aggregateId,
    payload: validated.value,
  });
}

function emitLegacy(
  eventName: string,
  payload: Record<string, unknown>,
  opts: LegacyEmitOptions | undefined
): OutboxEventDraft {
  if (opts === undefined) {
    throw new errors.InternalError({
      code: EVENT_PAYLOAD_INVALID,
      message: `Legacy emit("${eventName}", payload, opts) requires { aggregateType, aggregateId }.`,
    });
  }
  const definition = getEventDefinition(eventName);
  if (definition !== undefined) {
    // Registered → validate even on the legacy path. The aggregateId
    // is taken from opts (not the selector) because the legacy call
    // shape is the source of truth for it during migration.
    const validated = validateAgainst(definition, payload);
    if (!validated.ok) {
      throw new errors.ValidationError({
        code: EVENT_PAYLOAD_INVALID,
        message: `Outbox payload for "${eventName}" failed schema validation.`,
        issues: validated.issues,
        metadata: { eventType: eventName },
      });
    }
    return Object.freeze({
      eventType: eventName,
      aggregateType: opts.aggregateType,
      aggregateId: opts.aggregateId,
      payload: validated.value,
    });
  }
  // Unregistered → pass-through. The parity-guard test reports
  // this so the team migrates the event into the registry.
  return Object.freeze({
    eventType: eventName,
    aggregateType: opts.aggregateType,
    aggregateId: opts.aggregateId,
    payload,
  });
}
