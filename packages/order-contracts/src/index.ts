// Public surface of @pharmax/order-contracts.
//
// Neutral, domain-agnostic contract layer for the order aggregate.
// It owns the shared vocabulary that multiple domain packages
// (@pharmax/orders, @pharmax/verification, and future FILL/SHIP
// packages) must agree on — currently the order event-type →
// permission map used by the command bus's separation-of-duties
// helper.
//
// Sits BELOW the domain packages and ABOVE @pharmax/command-bus +
// @pharmax/rbac. Depending on this package is a domain→contract
// edge (allowed); it lets sibling domains share a contract without
// depending on each other.

export { ORDER_EVENT_TYPE_TO_PERMISSION, orderEventTypeToPermission } from "./event-permissions.js";
