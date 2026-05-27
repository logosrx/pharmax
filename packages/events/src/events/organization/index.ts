// Per-domain barrel for organization.* event definitions.
//
// Sibling of the `org/` barrel — distinct because the two
// namespaces (`organization.*` and `org.*`) historically diverged.
// `organization.*` carries tenant-lifecycle events anchored on
// the `Organization` aggregate; `org.*` carries operational
// tenant-administration events (sites, users, roles, buckets).

export { OrganizationCreatedV1 } from "./created-v1.js";
