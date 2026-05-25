// Tenancy-specific error codes.
//
// All errors here are `AuthorizationError` (HTTP 403, category
// "expected") so the bus does NOT page on them — they indicate a
// developer or caller mistake, surfaced clearly to the operations
// console and to the SOC 2 audit feed. Internal bugs that bypass
// this layer should never bubble up as tenancy errors; they would
// be `InternalError`.
//
// Codes are stable strings. Changing one is a SOC 2 audit event
// because it invalidates downstream correlation queries.

import { errors } from "@pharmax/platform-core";

/** Operation attempted outside any tenancy/system context. */
export const TENANCY_NO_CONTEXT = "TENANCY_NO_CONTEXT" as const;

/** Operation attempted to write to a different org than the active context. */
export const TENANCY_CROSS_ORG_WRITE = "TENANCY_CROSS_ORG_WRITE" as const;

/** Operation attempted to read across orgs from a user context. */
export const TENANCY_CROSS_ORG_READ = "TENANCY_CROSS_ORG_READ" as const;

export function tenancyNoContextError(detail: {
  readonly model: string;
  readonly operation: string;
}): errors.AuthorizationError {
  return new errors.AuthorizationError({
    code: TENANCY_NO_CONTEXT,
    message: `Query on tenant-scoped model "${detail.model}" attempted outside a tenancy context.`,
    metadata: { model: detail.model, operation: detail.operation },
  });
}

export function tenancyCrossOrgWriteError(detail: {
  readonly model: string;
  readonly operation: string;
  readonly activeOrganizationId: string;
  readonly attemptedOrganizationId: string;
}): errors.AuthorizationError {
  return new errors.AuthorizationError({
    code: TENANCY_CROSS_ORG_WRITE,
    message: `Cross-org write blocked: attempt to write a row owned by a different organization than the active context.`,
    metadata: {
      model: detail.model,
      operation: detail.operation,
      activeOrganizationId: detail.activeOrganizationId,
      attemptedOrganizationId: detail.attemptedOrganizationId,
    },
  });
}
