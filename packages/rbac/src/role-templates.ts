// Built-in role templates.
//
// Cloned per-organization at `CreateOrganization` time so each org
// owns its own copy of the role rows (and admins can modify them
// without affecting other orgs). The templates here are the
// DEFAULTS — once cloned, the per-org rows are the source of truth.
//
// SOC 2 / HIPAA note: changing a template here changes the DEFAULT
// permission set for newly-created orgs. Existing orgs are NOT
// retroactively modified — a separate migration command would have
// to re-sync them. Document any template change in the changelog
// and pair it with that migration plan.

import { RoleScope } from "@pharmax/database";

import { PERMISSIONS, type PermissionCode } from "./permissions.js";

export interface RoleTemplate {
  /** Stable code used as `role.code`. */
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly scope: RoleScope;
  readonly permissions: ReadonlyArray<PermissionCode>;
}

const ALL_PERMS: ReadonlyArray<PermissionCode> = Object.values(
  PERMISSIONS
) as ReadonlyArray<PermissionCode>;

export const ROLE_TEMPLATES: ReadonlyArray<RoleTemplate> = Object.freeze([
  {
    code: "OrgAdmin",
    name: "Organization Administrator",
    scope: RoleScope.ORGANIZATION,
    description: "Full administrative access across the organization.",
    permissions: ALL_PERMS,
  },
  {
    code: "Pharmacist",
    name: "Pharmacist",
    scope: RoleScope.SITE,
    description: "PV1 + Final Verification authority within a site.",
    permissions: [
      PERMISSIONS.PATIENTS_READ,
      PERMISSIONS.PROVIDERS_READ,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_CANCEL,
      PERMISSIONS.ORDERS_PLACE_HOLD,
      PERMISSIONS.ORDERS_RELEASE_HOLD,
      PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION,
      PERMISSIONS.PV1_START,
      PERMISSIONS.PV1_APPROVE,
      PERMISSIONS.PV1_REJECT,
      PERMISSIONS.FINAL_START,
      PERMISSIONS.FINAL_APPROVE,
      PERMISSIONS.FINAL_REJECT,
    ],
  },
  {
    code: "PharmacyTechnician",
    name: "Pharmacy Technician",
    scope: RoleScope.TEAM,
    description: "Typing and Filling authority within an assigned team.",
    permissions: [
      PERMISSIONS.PATIENTS_CREATE,
      PERMISSIONS.PATIENTS_READ,
      PERMISSIONS.PATIENTS_UPDATE,
      PERMISSIONS.PROVIDERS_CREATE,
      PERMISSIONS.PROVIDERS_READ,
      PERMISSIONS.PROVIDERS_UPDATE,
      PERMISSIONS.PROVIDERS_DEACTIVATE,
      PERMISSIONS.PROVIDERS_REACTIVATE,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_ADD_PRESCRIPTION,
      PERMISSIONS.ORDERS_CANCEL,
      PERMISSIONS.ORDERS_PLACE_HOLD,
      PERMISSIONS.ORDERS_RELEASE_HOLD,
      PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION,
      PERMISSIONS.TYPING_START,
      PERMISSIONS.TYPING_COMPLETE,
      PERMISSIONS.TYPING_MARK_MISSING_INFO,
      PERMISSIONS.FILL_START,
      PERMISSIONS.FILL_ASSIGN_LOT,
      PERMISSIONS.FILL_PRINT_VIAL_LABEL,
      PERMISSIONS.FILL_REPRINT_VIAL_LABEL,
      PERMISSIONS.FILL_COMPLETE,
      PERMISSIONS.LABELS_CONFIRM_PRINT,
      // Smaller sites have technicians do prep-and-ship in one
      // motion (typing → fill → final → dock). The dock leg
      // includes the package-photo capture, so the tech role
      // carries the same permission as the dedicated
      // ShippingClerk role above.
      PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO,
    ],
  },
  {
    code: "ShippingClerk",
    name: "Shipping Clerk",
    scope: RoleScope.SITE,
    description: "Releases verified orders to shipping and dispositions shipment exceptions.",
    permissions: [
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.SHIP_RELEASE,
      PERMISSIONS.SHIP_CREATE,
      PERMISSIONS.SHIP_CONFIRM,
      PERMISSIONS.SHIP_PURCHASE_LABEL,
      // Operator disposition path: when an inbound carrier
      // tracking event lands in EMERGENCY, the shipping clerk
      // triages and either re-ships or moves the order back to
      // the next-stage workflow bucket via `ResolveOrderEscalation`.
      PERMISSIONS.SHIP_RESOLVE_ESCALATION,
      // Pre-shipment package-photo capture (dock workflow).
      // Shipping clerks operate the dock; they're the canonical
      // capturers. PharmacyTechnician also carries this — techs
      // doing prep-and-ship in smaller sites need it too.
      PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO,
      // Operator triage for captures that did NOT auto-match. Held
      // separately from `SHIP_CAPTURE_PACKAGE_PHOTO` because
      // resolving a match retroactively rewrites the audit anchor
      // (which patient/order does this dock photo prove was
      // packed?). Pharmacy techs DO NOT carry this — a different
      // operator should triage their captures, mirroring the
      // workflow-safety pattern where producers and dispositioners
      // are different roles.
      PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH,
      // Disposition a capture that will never match (test shot,
      // duplicate, misclick, cancelled order) out of the triage
      // bucket. Held by the dispositioner role alongside resolve —
      // archiving and resolving are the two ways an unmatched
      // capture leaves the bucket.
      PERMISSIONS.SHIP_ARCHIVE_PACKAGE_PHOTO,
    ],
  },
  {
    // ---------------------------------------------------------------
    // WebhookService — narrow, machine-only role for the worker
    // shipping pipeline (per-org `shipping-webhook@<org-slug>.test`
    // service user). Replaces the prior `OrgAdmin` shortcut.
    //
    // Why ORGANIZATION scope: tracking events resolve to ANY
    // shipment in the org (the carrier doesn't know which site a
    // shipment belongs to), so the service user can't be constrained
    // to a single site.
    //
    // Permission set is intentionally minimal — just the two
    // machine-dispatched commands. Anything else (carrier
    // credential management, manual cancellations, label purchase)
    // belongs on a human role and would be a least-privilege
    // violation here.
    //
    // SOC 2 / HIPAA: a compromised webhook signing secret can only
    // (a) record a tracking event, (b) escalate the related order to
    // EMERGENCY. Neither path discloses PHI or moves an order to a
    // terminal state. Recovery is "rotate the carrier webhook secret
    // + force-disable the credential row"; no PHI exposure to wash.
    // ---------------------------------------------------------------
    code: "WebhookService",
    name: "Webhook Service (machine)",
    scope: RoleScope.ORGANIZATION,
    description:
      "Per-org service identity for inbound carrier webhook + tracking-poller dispatch. Machine-only; not assignable to human users.",
    permissions: [
      PERMISSIONS.SHIP_RECORD_TRACKING_EVENT,
      PERMISSIONS.SHIP_ESCALATE_TO_EMERGENCY,
      // The same machine identity runs the SLA breach-evaluator
      // tick, which routes breached orders into EMERGENCY.
      PERMISSIONS.ORDERS_ESCALATE_SLA,
    ],
  },
  {
    code: "ReportsScheduler",
    name: "Reports Scheduler (machine)",
    scope: RoleScope.ORGANIZATION,
    description:
      "Per-org service identity for the worker's scheduled-report dispatcher. Machine-only; not assignable to human users. Grants ONLY `reports.run` — the scheduler can dispatch existing reports but cannot create / edit / disable schedules (that's `reports.manage_schedule`, OrgAdmin-only).",
    permissions: [PERMISSIONS.REPORTS_RUN],
  },
  {
    // ---------------------------------------------------------------
    // NpiSyncWorker — machine-only role for the worker's NPI sync
    // dispatcher (per-org `npi-sync@<org-slug>.test` service user).
    //
    // Why ORGANIZATION scope: the diff engine produces changes for
    // ANY provider in the org (no site/clinic filtering at the CMS
    // layer), so the dispatcher needs org-wide reach.
    //
    // Permission set is intentionally minimal — just the two
    // commands the worker actually dispatches: UpdateProvider (when
    // CMS shows a non-functional drift like a credential change) and
    // DeactivateProvider (when CMS marks the prescriber INACTIVE).
    // Review-item creation (REACTIVATION_CANDIDATE,
    // NOT_FOUND_AT_CMS, ENUMERATION_TYPE_MISMATCH) is a direct
    // tenant-scoped insert by the worker and intentionally does NOT
    // go through the bus — those rows are operator notifications,
    // not workflow transitions.
    //
    // SOC 2 / HIPAA: a compromised npi-sync service user can update
    // provider demographics + deactivate prescribers. Neither path
    // discloses PHI; the worst case is "operator notices wrong
    // credential field" or "operator sees a fresh INACTIVE provider
    // they need to reactivate." Recovery is purely operational
    // (review the audit trail, run UpdateProvider/ReactivateProvider
    // manually).
    // ---------------------------------------------------------------
    code: "NpiSyncWorker",
    name: "NPI Sync Worker (machine)",
    scope: RoleScope.ORGANIZATION,
    description:
      "Per-org service identity for the worker's NPI registry sync dispatcher. Machine-only; not assignable to human users. Grants ONLY `providers.update` + `providers.deactivate` — the two commands the diff engine produces for non-review-item actions.",
    permissions: [PERMISSIONS.PROVIDERS_UPDATE, PERMISSIONS.PROVIDERS_DEACTIVATE],
  },
  {
    code: "ClinicViewer",
    name: "Clinic Viewer",
    scope: RoleScope.CLINIC,
    description: "Read-only access to a single clinic's orders.",
    permissions: [PERMISSIONS.PATIENTS_READ, PERMISSIONS.PROVIDERS_READ, PERMISSIONS.ORDERS_READ],
  },
  {
    code: "BillingManager",
    name: "Billing Manager",
    scope: RoleScope.ORGANIZATION,
    description: "Invoice and pricing administration.",
    permissions: [
      PERMISSIONS.BILLING_READ,
      PERMISSIONS.BILLING_MANAGE,
      PERMISSIONS.BILLING_FINALIZE_INVOICE,
      PERMISSIONS.BILLING_MANAGE_PRICING,
      PERMISSIONS.BILLING_CREDIT_INVOICE,
      PERMISSIONS.BILLING_ISSUE_REFUND,
    ],
  },
]);

/** Convenience accessor for tests and seeds. */
export function findRoleTemplate(code: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.code === code);
}
