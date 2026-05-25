// In-transaction Separation-of-Duties helper for order-targeted commands.
//
// `@pharmax/rbac` provides the pure SoD predicate (`checkSoD`,
// `requireNoSoDViolation`) and the rule registry. The bus piece is
// the glue that turns "the actor is about to do PV1_APPROVE on
// order X" into a SoD evaluation by:
//
//   1. Reading `order_event` rows for the target order INSIDE the
//      handler's transaction (so the row lock established by the
//      handler's `SELECT … FOR UPDATE` step serializes us against
//      concurrent writers).
//   2. Translating each event's `eventType` string into a
//      `PermissionCode` via a caller-supplied translator. The
//      translator lives with the domain that owns the event
//      vocabulary (`@pharmax/orders` in Phase 2), not here — the
//      bus has no opinion on which event types map to which
//      permissions.
//   3. Handing the resulting `ResourceAct[]` to
//      `rbac.requireNoSoDViolation`, which throws
//      `AuthorizationError(SOD_VIOLATION)` if any prior act by the
//      same actor collides with the attempted permission.
//
// Why a separate helper instead of inlining this in
// `executeCommand`:
//   - `executeCommand` is resource-agnostic. Many tenant commands
//     (`CreateOrganization`, `InviteUser`) don't operate on a
//     locked resource and don't need SoD. Inlining the lookup
//     would force every handler to pass a target id.
//   - The translator is domain-specific. Coupling the bus to a
//     central event-vocabulary registry would create a cross-
//     domain dependency that the bus shouldn't own.
//   - The helper composes cleanly into the future declarative
//     `defineCommand({ sodRules, ... })` factory: that factory
//     will pull `sodAttempted` + a per-domain translator from the
//     definition and call this helper internally.
//
// PHI invariant: `loadOrderResourceHistory` selects ONLY non-PHI
// columns (eventType, actorUserId, sequenceNumber). It NEVER reads
// `payload` — that JSONB column may contain PHI snapshots and is
// out of scope for SoD evaluation.

import { requireNoSoDViolation, type PermissionCode, type ResourceAct } from "@pharmax/rbac";
import { requireCurrentContext } from "@pharmax/tenancy";

import type { PrismaTxClient } from "./types.js";

/**
 * Translator from an `order_event.eventType` string to the
 * `PermissionCode` that the event represents. Returns `null` for
 * event types that do not correspond to a permission (e.g.
 * `"order.note.added"` is informational, not an act under SoD).
 *
 * Owned by the domain package (typically `@pharmax/orders`) so
 * adding a new event type does not require a command-bus change.
 */
export type EventTypeToPermission = (eventType: string) => PermissionCode | null;

/**
 * Translator that supports either a direct function or a static
 * lookup table. Provided as a convenience because most domains
 * will have a literal map and we don't want to push every caller
 * through a function literal.
 */
export function buildEventTypeTranslator(
  table: Readonly<Record<string, PermissionCode>>
): EventTypeToPermission {
  return (eventType) => table[eventType] ?? null;
}

export interface LoadOrderResourceHistoryInput {
  readonly tx: PrismaTxClient;
  readonly orderId: string;
}

/**
 * Read this order's event history inside the current transaction
 * and project it onto `rbac.ResourceAct[]`. Events whose
 * `eventType` is not in the translator (returns `null`) are
 * silently skipped — they are not "acts" under SoD. Events with
 * no `actorUserId` (system-emitted) are also skipped because SoD
 * is per-actor.
 *
 * Sort order is `sequenceNumber ASC`, which matches the audit
 * timeline order. `atSequence` is the monotonic per-order sequence
 * number as a string, suitable for the SoD violation metadata.
 */
export async function loadOrderResourceHistory(
  input: LoadOrderResourceHistoryInput,
  translate: EventTypeToPermission
): Promise<ResourceAct[]> {
  const events = await input.tx.orderEvent.findMany({
    where: { orderId: input.orderId },
    orderBy: { sequenceNumber: "asc" },
    select: {
      eventType: true,
      actorUserId: true,
      sequenceNumber: true,
    },
  });
  const acts: ResourceAct[] = [];
  for (const event of events) {
    if (event.actorUserId === null) continue;
    const permission = translate(event.eventType);
    if (permission === null) continue;
    acts.push({
      permission,
      actorUserId: event.actorUserId,
      atSequence: String(event.sequenceNumber),
    });
  }
  return acts;
}

export interface RequireNoSoDViolationForOrderInput {
  readonly tx: PrismaTxClient;
  readonly orderId: string;
  readonly attempted: PermissionCode;
  readonly translate: EventTypeToPermission;
}

/**
 * One-line SoD guard for order-targeted commands. Call from
 * within the handler's transaction, AFTER the row lock on the
 * order but BEFORE writing the new `order_event`.
 *
 * Pulls the active actor and tenant scope from
 * `tenancy.requireCurrentContext()` — the bus has already
 * asserted that a user context is active by the time the handler
 * runs, so this is total.
 *
 * Throws `AuthorizationError(SOD_VIOLATION)` with the standard
 * metadata payload (`ruleId`, `attemptedPermission`,
 * `collidingPriorAct`, `priorActSequence`, `resourceRef`,
 * `actorUserId`, `organizationId`, `correlationId`). The exception
 * propagates out of the handler, rolls the tx back, and is
 * surfaced to the route handler the same way as any other
 * `AuthorizationError`.
 */
export async function requireNoSoDViolationForOrder(
  input: RequireNoSoDViolationForOrderInput
): Promise<void> {
  const ctx = requireCurrentContext();
  const history = await loadOrderResourceHistory(
    { tx: input.tx, orderId: input.orderId },
    input.translate
  );
  requireNoSoDViolation({
    attempted: input.attempted,
    actorUserId: ctx.actor.userId,
    resourceHistory: history,
    resourceRef: `order:${input.orderId}`,
    correlationId: ctx.actor.correlationId,
    organizationId: ctx.organizationId,
  });
}
