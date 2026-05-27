// Canonical priority ordering for built-in configurators.
//
// The numbers are spaced with intentional gaps (10/20/30/40/50) so
// new packages can land in between without renumbering existing
// ones (e.g. a `documents` configurator that must run after crypto
// but before the command bus can use priority 15).
//
// Why explicit numbers instead of an ordered list:
//
//   - Future packages (`@pharmax/notifications`, `@pharmax/documents`,
//     etc.) need to declare ordering relative to the existing
//     wiring without knowing the full set. A numeric priority lets
//     them slot in without modifying composition.
//
//   - Tests can assert the exact runtime order by checking the
//     applied-configurators manifest on the returned root, catching
//     regressions where a new configurator was accidentally placed
//     too early or too late.
//
// ORDERING INVARIANTS (each ENFORCED by the priority numbers
// below — DO NOT change without re-reading these):
//
//   - CRYPTO before everything else that may touch PHI. The shipping
//     adapter factories themselves don't touch crypto, but
//     `resolveShippingAdapter` reads decrypted carrier credentials
//     the first time it runs, so crypto must be ready by then.
//
//   - RBAC before COMMAND_BUS. The command bus's dispatch step
//     invokes `requirePermission` against the configured loader;
//     without RBAC wired first, dispatch throws
//     `RBAC_NOT_CONFIGURED` from inside the bus's own validation.
//
//   - COMMAND_BUS before SHIPPING and BILLING. Shipping commands
//     (PurchaseShipmentLabel, RecordShipmentTrackingEvent) and
//     billing commands (IssueRefund, MaterializeShippedOrderBilling)
//     all dispatch through `executeCommand`, which reads the bus
//     configuration. Wiring SHIPPING/BILLING factories before the
//     bus would let a synchronous boot path attempt a dispatch
//     against an unconfigured bus.
//
//   - BILLING after SHIPPING is alphabetical convention rather than
//     a strict ordering requirement — neither subsystem depends on
//     the other's `configure*` having run.

export const BUILT_IN_PRIORITIES = Object.freeze({
  /** @pharmax/crypto KMS adapter — required before any PHI read/write. */
  CRYPTO: 10,
  /** @pharmax/rbac permission loader — required before command-bus. */
  RBAC: 20,
  /** @pharmax/command-bus prisma + clock + logger — required before any command dispatch. */
  COMMAND_BUS: 30,
  /** @pharmax/shipping per-provider adapter factories. */
  SHIPPING: 40,
  /** @pharmax/billing Stripe refund port. */
  BILLING: 50,
});

export type BuiltInPriority = (typeof BUILT_IN_PRIORITIES)[keyof typeof BUILT_IN_PRIORITIES];
