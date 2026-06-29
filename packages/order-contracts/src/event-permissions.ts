// Order-aggregate event vocabulary → permission mapping.
//
// Every event that an order command emits is named here and mapped
// to the `PermissionCode` that "performing this event" represents.
// The command bus's SoD helper (`requireNoSoDViolationForOrder`)
// uses this mapping to translate `order_event` rows into the
// `ResourceAct[]` shape that `rbac.requireNoSoDViolation` consumes.
//
// Why this lives in `@pharmax/order-contracts` and NOT in a domain
// package:
//
//   This map is the SHARED contract of the order aggregate. It is
//   consumed by every package that runs SoD checks against an
//   order's event history — `@pharmax/orders` (the command owner),
//   `@pharmax/verification` (PV1 / final-verification SoD), and
//   future FILL/SHIP-stage packages. Hosting it in `@pharmax/orders`
//   forced sibling domains (`@pharmax/verification`) to depend on a
//   peer domain just to read one table — a domain→domain edge that
//   seeds coupling. Promoting the contract to a neutral tier below
//   the domains dissolves that edge: domains now share a CONTRACT,
//   not a dependency. (ADR-0011, Tier-2 architecture cleanup.)
//
//   It does NOT live in `@pharmax/command-bus` because the bus is
//   domain-agnostic: it has no opinion on which event type means
//   "a PV1 was approved" vs. "a typing review was completed". It
//   only provides the generic `buildEventTypeTranslator` mechanism.
//   The order-specific vocabulary is the contract layer's job.
//
// PHI invariant: nothing in this file references PHI. Event TYPE
// strings are vocabulary, not payload. The payloads (which carry
// the per-event data — orderId, clinicId, etc.) live on the
// command handler.

import { buildEventTypeTranslator } from "@pharmax/command-bus";
import { PERMISSIONS, type PermissionCode } from "@pharmax/rbac";

/**
 * Frozen lookup table from order `event_type` to the permission
 * that "doing this event" represents.
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
