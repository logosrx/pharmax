// Order-aggregate event vocabulary — re-export.
//
// The definition moved to the neutral `@pharmax/order-contracts`
// package so sibling domains (notably `@pharmax/verification`) can
// share the order event-type → permission contract without taking a
// dependency on this domain package. See that package for the
// rationale (ADR-0011, Tier-2 architecture cleanup).
//
// This file is kept as a thin re-export so `@pharmax/orders`'s
// public surface is unchanged for existing callers.

export {
  ORDER_EVENT_TYPE_TO_PERMISSION,
  orderEventTypeToPermission,
} from "@pharmax/order-contracts";
