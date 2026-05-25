// Order-aggregate event vocabulary.
//
// Every event that an order command emits is named here and mapped
// to the `PermissionCode` that "performing this event" represents.
// The command bus's SoD helper (`requireNoSoDViolationForOrder`)
// uses this mapping to translate `order_event` rows into the
// `ResourceAct[]` shape that `rbac.requireNoSoDViolation` consumes.
//
// Why this lives in `@pharmax/orders` and not in `@pharmax/command-bus`:
//
//   - The bus is domain-agnostic. It has no opinion on which event
//     type means "a PV1 was approved" vs. "a typing review was
//     completed". That mapping is part of the order-aggregate
//     contract.
//   - Adding a new event type therefore does NOT require a change
//     to `@pharmax/command-bus`. The new event lands here, every
//     command in this package picks up the new shape, and
//     downstream packages (`@pharmax/verification`,
//     `@pharmax/fill`, etc.) can extend by registering their own
//     translator.
//
// PHI invariant: nothing in this file references PHI. Event TYPE
// strings are vocabulary, not payload. The payloads (which carry
// the per-event data — orderId, clinicId, etc.) live on the
// command handler.

import { PERMISSIONS, type PermissionCode } from "@pharmax/rbac";

import { buildEventTypeTranslator } from "@pharmax/command-bus";

/**
 * Frozen lookup table from order `event_type` to the permission
 * that "doing this event" represents.
 *
 * Phase 2 entries — added per command as it lands. `order.received.v1`
 * is the only entry today (CreateOrder); the rest land alongside
 * `StartTyping`, `ApprovePV1`, etc.
 *
 * Entries that intentionally have NO permission (informational
 * events like `order.note.added.v1`) are simply absent from this
 * table; `buildEventTypeTranslator` returns `null` for unmapped
 * keys, and the bus's SoD helper silently skips them.
 */
export const ORDER_EVENT_TYPE_TO_PERMISSION: Readonly<Record<string, PermissionCode>> =
  Object.freeze({
    "order.received.v1": PERMISSIONS.ORDERS_CREATE,
    "order.prescription.added.v1": PERMISSIONS.ORDERS_ADD_PRESCRIPTION,
    "order.cancelled.v1": PERMISSIONS.ORDERS_CANCEL,
    "order.held.v1": PERMISSIONS.ORDERS_PLACE_HOLD,
    "order.hold_released.v1": PERMISSIONS.ORDERS_RELEASE_HOLD,
    "order.reopened.v1": PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION,
    "order.typing.started.v1": PERMISSIONS.TYPING_START,
    "order.typing.completed.v1": PERMISSIONS.TYPING_COMPLETE,
    "order.pv1.started.v1": PERMISSIONS.PV1_START,
    "order.pv1.approved.v1": PERMISSIONS.PV1_APPROVE,
    "order.pv1.rejected.v1": PERMISSIONS.PV1_REJECT,
    // FILL_COMPLETE is wired AHEAD of the FILL-stage command
    // (`CompleteFill` ships in a later phase) because
    // `ApproveFinalVerification` needs to detect a prior
    // `order.fill.completed.v1` by the same actor to fire the
    // `sod.fill-final-same-actor` rule. A real CompleteFill event
    // can already land in an order's history once that command
    // ships, and this entry ensures the SoD translator covers it
    // the moment it does. Adding the entry here costs nothing
    // until the command emits it.
    "order.fill.completed.v1": PERMISSIONS.FILL_COMPLETE,
    "order.fill.started.v1": PERMISSIONS.FILL_START,
    "order.final.started.v1": PERMISSIONS.FINAL_START,
    "order.final.approved.v1": PERMISSIONS.FINAL_APPROVE,
    "order.final.rejected.v1": PERMISSIONS.FINAL_REJECT,
    "order.ship.released.v1": PERMISSIONS.SHIP_RELEASE,
    "order.shipment.created.v1": PERMISSIONS.SHIP_CREATE,
    "order.shipped.v1": PERMISSIONS.SHIP_CONFIRM,
  });

/**
 * Translator function compatible with the bus's
 * `EventTypeToPermission` signature. Use this in `defineCommand`'s
 * `sodRules[].translate` slot.
 */
export const orderEventTypeToPermission = buildEventTypeTranslator(ORDER_EVENT_TYPE_TO_PERMISSION);
