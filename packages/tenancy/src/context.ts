// TenancyContext — the resolved set of "who/where" identifiers that
// every domain operation runs within.
//
// Shape rules:
//   - `organizationId` is REQUIRED. There is no such thing as a
//     domain operation that legitimately runs without an org scope.
//     Cross-org admin operations use `withSystemContext` instead.
//   - All other scopes are OPTIONAL narrowers. An action initiated
//     by a typing tech inside Clinic A will have `clinicId` set, but
//     an org-admin running a report across all clinics will not.
//   - `workstationId` is set only for actions initiated from a paired
//     physical workstation (PV1, fill scan, label print). The RBAC
//     guard inspects it for workstation-bound permissions.
//   - `actor.correlationId` is a ULID that the bus stamps on every
//     command, audit, outbox, and log record so a single user action
//     can be reconstructed end-to-end from the audit trail without
//     PHI access. NOT a session id and NOT a request id — it spans
//     queue retries and async hand-offs.
//
// PHI invariant: NOTHING in this object is patient PHI. `actor.userId`
// is the staff member id. No first/last name, no patient identifiers.
// The object is loggable as-is.

export interface TenancyActor {
  readonly userId: string;
  readonly correlationId: string;
}

export interface TenancyContext {
  readonly organizationId: string;
  readonly siteId?: string;
  readonly clinicId?: string;
  readonly teamId?: string;
  readonly bucketId?: string;
  readonly workstationId?: string;
  readonly actor: TenancyActor;
}

/**
 * Constructs a frozen `TenancyContext`. Use this at the API boundary
 * (route handler) immediately after authentication resolves the
 * actor. The frozen result prevents downstream code from mutating
 * scope mid-request.
 */
export function buildTenancyContext(input: TenancyContext): TenancyContext {
  return Object.freeze({
    ...input,
    actor: Object.freeze({ ...input.actor }),
  });
}
