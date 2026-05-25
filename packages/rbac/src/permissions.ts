// Typed permission registry.
//
// This file is the SINGLE source of truth for the action vocabulary
// of the platform. It mirrors the 37 codes seeded by `prisma/seed.ts`
// — that mirror is verified by a test in `permissions.test.ts`.
//
// Why a typed constant object instead of a loose string enum:
//   - Call sites get autocomplete: `requirePermission(PERMISSIONS.PV1_APPROVE)`.
//   - Typos at call sites become TYPE errors at compile time, not 403s in prod.
//   - SOC 2 reviewers see EVERY privileged action the platform can perform
//     by reading this one file — no grep across the codebase.
//
// Adding / removing / renaming a permission is a SOC 2 audit event.
// Pair every change here with:
//   1. The same change in `prisma/seed.ts` (the test enforces mirror parity).
//   2. A migration plan for existing role grants (renaming = data migration
//      or backwards-compatible alias for one release).
//   3. A note in the changelog.

/**
 * Frozen registry of every permission code recognized by the
 * platform. Keys are JS-friendly UPPER_SNAKE; values are the
 * canonical dotted strings stored in the `permission.code` column
 * and referenced from role grants.
 */
export const PERMISSIONS = Object.freeze({
  // Org & administration.
  ORGS_READ: "orgs.read",
  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",

  // Patient roster.
  PATIENTS_CREATE: "patients.create",
  PATIENTS_READ: "patients.read",

  // Provider (prescriber) roster.
  PROVIDERS_CREATE: "providers.create",
  PROVIDERS_READ: "providers.read",

  // Order lifecycle.
  ORDERS_CREATE: "orders.create",
  ORDERS_READ: "orders.read",
  ORDERS_ADD_PRESCRIPTION: "orders.add_prescription",
  ORDERS_CANCEL: "orders.cancel",
  ORDERS_PLACE_HOLD: "orders.place_hold",
  ORDERS_RELEASE_HOLD: "orders.release_hold",
  ORDERS_REOPEN_FOR_CORRECTION: "orders.reopen_for_correction",

  // Typing.
  TYPING_START: "typing.start",
  TYPING_COMPLETE: "typing.complete",

  // PV1 (first pharmacist verification).
  PV1_START: "pv1.start",
  PV1_APPROVE: "pv1.approve",
  PV1_REJECT: "pv1.reject",

  // Fill.
  FILL_START: "fill.start",
  FILL_ASSIGN_LOT: "fill.assign_lot",
  FILL_PRINT_VIAL_LABEL: "fill.print_vial_label",
  FILL_REPRINT_VIAL_LABEL: "fill.reprint_vial_label",
  FILL_COMPLETE: "fill.complete",

  // Label print confirmation (workstation agent callback).
  LABELS_CONFIRM_PRINT: "labels.confirm_print",

  // Final verification.
  FINAL_START: "final.start",
  FINAL_APPROVE: "final.approve",
  FINAL_REJECT: "final.reject",

  // Shipping release.
  SHIP_RELEASE: "ship.release",
  SHIP_CREATE: "ship.create",
  SHIP_CONFIRM: "ship.confirm",
  SHIP_PURCHASE_LABEL: "ship.purchase_label",
  SHIP_RECORD_TRACKING_EVENT: "ship.record_tracking_event",
  SHIP_MANAGE_CARRIER_CREDENTIALS: "ship.manage_carrier_credentials",

  // Billing.
  BILLING_READ: "billing.read",
  BILLING_MANAGE: "billing.manage",

  // Audit.
  AUDIT_READ: "audit.read",
} as const);

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Returns the full set of recognized permission codes as a frozen
 * array. Useful for tests that assert seed parity and for admin UI
 * that lists every permission.
 */
export const ALL_PERMISSION_CODES: ReadonlyArray<PermissionCode> = Object.freeze(
  Object.values(PERMISSIONS) as ReadonlyArray<PermissionCode>
);

/**
 * Per-permission metadata. Description is human-facing (admin UI,
 * audit log explanations). `category` is for grouping in the admin
 * role editor. Keep both PHI-free.
 */
export const PERMISSION_METADATA: Readonly<
  Record<PermissionCode, { readonly description: string; readonly category: string }>
> = Object.freeze({
  [PERMISSIONS.ORGS_READ]: {
    description: "Read organization details.",
    category: "Administration",
  },
  [PERMISSIONS.USERS_MANAGE]: {
    description: "Invite, suspend, and restore users.",
    category: "Administration",
  },
  [PERMISSIONS.ROLES_MANAGE]: {
    description: "Create and edit roles and grants.",
    category: "Administration",
  },
  [PERMISSIONS.PATIENTS_CREATE]: {
    description: "Register a new patient at a clinic.",
    category: "Patients",
  },
  [PERMISSIONS.PATIENTS_READ]: {
    description: "Read patient identity (PHI access).",
    category: "Patients",
  },
  [PERMISSIONS.PROVIDERS_CREATE]: {
    description: "Register a new prescribing provider.",
    category: "Providers",
  },
  [PERMISSIONS.PROVIDERS_READ]: {
    description: "Read provider directory.",
    category: "Providers",
  },
  [PERMISSIONS.ORDERS_CREATE]: { description: "Create new orders.", category: "Orders" },
  [PERMISSIONS.ORDERS_READ]: {
    description: "View orders within scope.",
    category: "Orders",
  },
  [PERMISSIONS.ORDERS_ADD_PRESCRIPTION]: {
    description: "Attach an additional prescription to an in-flight order.",
    category: "Orders",
  },
  [PERMISSIONS.ORDERS_CANCEL]: {
    description: "Cancel an order before shipment (terminal disposition).",
    category: "Orders",
  },
  [PERMISSIONS.ORDERS_PLACE_HOLD]: {
    description: "Place an order on hold while a blocker is resolved (reversible).",
    category: "Orders",
  },
  [PERMISSIONS.ORDERS_RELEASE_HOLD]: {
    description: "Release a held order back into the workflow.",
    category: "Orders",
  },
  [PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION]: {
    description: "Reopen a rejected order for correction at an earlier stage.",
    category: "Orders",
  },
  [PERMISSIONS.TYPING_START]: { description: "Start typing on an order.", category: "Typing" },
  [PERMISSIONS.TYPING_COMPLETE]: {
    description: "Complete typing review.",
    category: "Typing",
  },
  [PERMISSIONS.PV1_START]: { description: "Start PV1 verification.", category: "PV1" },
  [PERMISSIONS.PV1_APPROVE]: { description: "Approve PV1.", category: "PV1" },
  [PERMISSIONS.PV1_REJECT]: { description: "Reject PV1.", category: "PV1" },
  [PERMISSIONS.FILL_START]: { description: "Start fill.", category: "Fill" },
  [PERMISSIONS.FILL_ASSIGN_LOT]: {
    description: "Assign inventory lot during fill.",
    category: "Fill",
  },
  [PERMISSIONS.FILL_PRINT_VIAL_LABEL]: {
    description: "Print a vial label to a thermal printer.",
    category: "Fill",
  },
  [PERMISSIONS.FILL_REPRINT_VIAL_LABEL]: {
    description: "Reprint a vial label with a reason code.",
    category: "Fill",
  },
  [PERMISSIONS.FILL_COMPLETE]: { description: "Complete fill.", category: "Fill" },
  [PERMISSIONS.LABELS_CONFIRM_PRINT]: {
    description: "Confirm thermal label print job completion from workstation agent.",
    category: "Labels",
  },
  [PERMISSIONS.FINAL_START]: {
    description: "Start final verification.",
    category: "Final Verification",
  },
  [PERMISSIONS.FINAL_APPROVE]: {
    description: "Approve final verification.",
    category: "Final Verification",
  },
  [PERMISSIONS.FINAL_REJECT]: {
    description: "Reject final verification.",
    category: "Final Verification",
  },
  [PERMISSIONS.SHIP_RELEASE]: {
    description: "Release order to shipping.",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_CREATE]: {
    description: "Create carrier shipment record for an order.",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_CONFIRM]: {
    description: "Confirm shipment handoff and mark order shipped.",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_PURCHASE_LABEL]: {
    description:
      "Purchase a shipping label from a carrier (EasyPost), spending real funds on the org's account.",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_RECORD_TRACKING_EVENT]: {
    description:
      "Record an inbound carrier tracking event against a shipment (system / webhook ingestion).",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS]: {
    description:
      "Register, rotate, or disable per-organization carrier API credentials (EasyPost / FedEx / UPS).",
    category: "Shipping",
  },
  [PERMISSIONS.BILLING_READ]: { description: "View billing data.", category: "Billing" },
  [PERMISSIONS.BILLING_MANAGE]: {
    description: "Manage invoices and pricing.",
    category: "Billing",
  },
  [PERMISSIONS.AUDIT_READ]: { description: "Read audit log.", category: "Audit" },
});

/**
 * Type guard: is the given string a recognized permission code?
 *
 * Use at boundaries that accept untrusted input (e.g. an admin UI
 * payload). NEVER assume an arbitrary string is safe to pass to
 * `requirePermission` — the registry is closed.
 */
export function isPermissionCode(value: unknown): value is PermissionCode {
  return (
    typeof value === "string" && (ALL_PERMISSION_CODES as ReadonlyArray<string>).includes(value)
  );
}
