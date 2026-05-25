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
      PERMISSIONS.PROVIDERS_CREATE,
      PERMISSIONS.PROVIDERS_READ,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_ADD_PRESCRIPTION,
      PERMISSIONS.ORDERS_CANCEL,
      PERMISSIONS.ORDERS_PLACE_HOLD,
      PERMISSIONS.ORDERS_RELEASE_HOLD,
      PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION,
      PERMISSIONS.TYPING_START,
      PERMISSIONS.TYPING_COMPLETE,
      PERMISSIONS.FILL_START,
      PERMISSIONS.FILL_ASSIGN_LOT,
      PERMISSIONS.FILL_PRINT_VIAL_LABEL,
      PERMISSIONS.FILL_REPRINT_VIAL_LABEL,
      PERMISSIONS.FILL_COMPLETE,
      PERMISSIONS.LABELS_CONFIRM_PRINT,
    ],
  },
  {
    code: "ShippingClerk",
    name: "Shipping Clerk",
    scope: RoleScope.SITE,
    description: "Releases verified orders to shipping.",
    permissions: [
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.SHIP_RELEASE,
      PERMISSIONS.SHIP_CREATE,
      PERMISSIONS.SHIP_CONFIRM,
      PERMISSIONS.SHIP_PURCHASE_LABEL,
    ],
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
    permissions: [PERMISSIONS.BILLING_READ, PERMISSIONS.BILLING_MANAGE],
  },
]);

/** Convenience accessor for tests and seeds. */
export function findRoleTemplate(code: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.code === code);
}
