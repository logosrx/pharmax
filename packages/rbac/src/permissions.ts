// Typed permission registry.
//
// This file is the SINGLE source of truth for the action vocabulary
// of the platform. It mirrors the 51 codes seeded by `prisma/seed.ts`
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
  ORG_MANAGE_SITES: "org.manage_sites",

  // Patient roster.
  PATIENTS_CREATE: "patients.create",
  PATIENTS_READ: "patients.read",
  PATIENTS_UPDATE: "patients.update",
  PATIENTS_CRYPTO_SHRED: "patients.crypto_shred",

  // Provider (prescriber) roster.
  PROVIDERS_CREATE: "providers.create",
  PROVIDERS_READ: "providers.read",
  PROVIDERS_UPDATE: "providers.update",
  PROVIDERS_DEACTIVATE: "providers.deactivate",
  PROVIDERS_REACTIVATE: "providers.reactivate",

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
  TYPING_MARK_MISSING_INFO: "typing.mark_missing_info",

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
  SHIP_ESCALATE_TO_EMERGENCY: "ship.escalate_to_emergency",
  SHIP_RESOLVE_ESCALATION: "ship.resolve_escalation",
  SHIP_CAPTURE_PACKAGE_PHOTO: "ship.capture_package_photo",
  SHIP_RESOLVE_PACKAGE_PHOTO_MATCH: "ship.resolve_package_photo_match",

  // Billing.
  BILLING_READ: "billing.read",
  BILLING_MANAGE: "billing.manage",
  BILLING_FINALIZE_INVOICE: "billing.finalize_invoice",
  BILLING_MANAGE_PRICING: "billing.manage_pricing",
  BILLING_CREDIT_INVOICE: "billing.credit_invoice",
  BILLING_ISSUE_REFUND: "billing.issue_refund",

  // Audit.
  AUDIT_READ: "audit.read",

  // Reporting.
  REPORTS_RUN: "reports.run",
  REPORTS_MANAGE_SCHEDULE: "reports.manage_schedule",

  // Notifications.
  NOTIFICATIONS_READ: "notifications.read",

  // Workflow administration (Tier 2 tenant extension; see ADR-0019).
  // Authors per-tenant `WorkflowPolicyOverlay` rows. Overlays can
  // only TIGHTEN the base policy (forbid transitions, add attestation
  // requirements) — the merge function rejects any overlay that
  // would loosen base, so this permission cannot weaken workflow
  // safety. Restricted to OrgAdmin by default because misconfigured
  // overlays appear in SOC-2 audit evidence (`command_log` cites the
  // overlay binding the command was decided against).
  WORKFLOW_OVERLAY_MANAGE: "workflow.overlay.manage",

  // Compliance evidence (SOC 2 CC6.2 access reviews).
  // View persisted `AccessReviewSnapshot` rows for the operator's
  // organization. Read-only — snapshots are produced by the
  // RecordAccessReviewSnapshot tenant command (CLI / worker) and
  // are immutable post-write. Grants visibility into the per-quarter
  // access-grant evidence without exposing the underlying RBAC
  // mutation surface (`users.manage` + `roles.manage`), so a SOC 2
  // reviewer / compliance officer can be granted this permission
  // alone. Restricted to OrgAdmin + a dedicated compliance role
  // template by default.
  COMPLIANCE_ACCESS_REVIEW_VIEW: "compliance.access_review.view",

  // Dispatch the `RecordAccessReviewSnapshot` command, which freezes
  // the org's current (user → role → permission) graph into an
  // immutable, digest-sealed `AccessReviewSnapshot` row. Separate
  // from `compliance.access_review.view` so the operator who PRODUCES
  // evidence is a deliberate, audited identity (typically the
  // security officer running the quarterly script or the future
  // scheduled worker's service user) — a viewer cannot retroactively
  // forge a snapshot. Restricted to OrgAdmin + SecurityOfficer in
  // the default role templates.
  COMPLIANCE_ACCESS_REVIEW_RECORD: "compliance.access_review.record",
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
  [PERMISSIONS.ORG_MANAGE_SITES]: {
    description:
      "Edit pharmacy site profile and ship-from address used by the carrier auto-purchase flow.",
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
  [PERMISSIONS.PATIENTS_UPDATE]: {
    description:
      "Edit patient identity, contact, address, or MRN (re-encrypts the touched columns and refreshes their blind indexes).",
    category: "Patients",
  },
  [PERMISSIONS.PATIENTS_CRYPTO_SHRED]: {
    description:
      "Crypto-shred a patient: render PHI permanently unreadable (right-to-be-forgotten, compliance action; OrgAdmin only by default).",
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
  [PERMISSIONS.PROVIDERS_UPDATE]: {
    description:
      "Edit provider directory entry (name, credential, DEA, contact, address). NPI is immutable; status changes require DeactivateProvider.",
    category: "Providers",
  },
  [PERMISSIONS.PROVIDERS_DEACTIVATE]: {
    description:
      "Deactivate a provider (status: ACTIVE \u2192 INACTIVE) with a reason code. Blocks new orders against the prescriber; in-flight orders are handled by downstream workers based on reason severity.",
    category: "Providers",
  },
  [PERMISSIONS.PROVIDERS_REACTIVATE]: {
    description:
      "Reactivate a provider (status: INACTIVE \u2192 ACTIVE) with a reason code (license restored, sanction lifted, erroneous deactivation, etc.). Re-enables new orders against the prescriber. Distinct from PROVIDERS_DEACTIVATE so the audit and approval surfaces stay separable.",
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
  [PERMISSIONS.TYPING_MARK_MISSING_INFO]: {
    description:
      "Pause typing on an order with a structured missing-info reason (prescriber callback, patient contact, illegible Rx, etc.); the order parks in TYPING_PENDING_MISSING_INFO until ResumeTyping is dispatched.",
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
  [PERMISSIONS.SHIP_ESCALATE_TO_EMERGENCY]: {
    description:
      "Move an order into the EMERGENCY bucket (worker dispatch on shipment exception / failed delivery / return-to-sender).",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_RESOLVE_ESCALATION]: {
    description:
      "Disposition an order out of the EMERGENCY bucket back into a workflow bucket (operator action after carrier exception triage).",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO]: {
    description:
      "Capture a pre-shipment package photo at the dock and link it to the matched order/patient (writes a PackagePhoto row via CapturePackagePhoto).",
    category: "Shipping",
  },
  [PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH]: {
    description:
      "Resolve an unmatched PackagePhoto by linking it to a specific order (operator triage of dock captures that did not auto-match).",
    category: "Shipping",
  },
  [PERMISSIONS.BILLING_READ]: { description: "View billing data.", category: "Billing" },
  [PERMISSIONS.BILLING_MANAGE]: {
    description: "Manage invoices and pricing.",
    category: "Billing",
  },
  [PERMISSIONS.BILLING_FINALIZE_INVOICE]: {
    description:
      "Finalize a DRAFT invoice (DRAFT → OPEN), locking it for further line appends and triggering downstream Stripe push.",
    category: "Billing",
  },
  [PERMISSIONS.BILLING_MANAGE_PRICING]: {
    description:
      "Create, update, or supersede per-(org, clinic, product) pricing rules that determine invoice-line unit amounts.",
    category: "Billing",
  },
  [PERMISSIONS.BILLING_CREDIT_INVOICE]: {
    description:
      "Apply a manual credit / discount / adjustment to an invoice (negative-amount line; preserves the original line audit trail).",
    category: "Billing",
  },
  [PERMISSIONS.BILLING_ISSUE_REFUND]: {
    description:
      "Issue a Stripe refund against a paid invoice; writes the corresponding negative-amount line on the Pharmax ledger.",
    category: "Billing",
  },
  [PERMISSIONS.AUDIT_READ]: { description: "Read audit log.", category: "Audit" },
  [PERMISSIONS.REPORTS_RUN]: {
    description:
      "Run a registered report on-demand (operator console) or via scheduled execution. Writes a report_run row and downloads CSV; aggregate-only access — no per-PHI-row data.",
    category: "Reporting",
  },
  [PERMISSIONS.REPORTS_MANAGE_SCHEDULE]: {
    description:
      "Create, edit, pause, or disable scheduled report executions (cron-driven). Schedules dispatch under a per-org service identity; admins can change the cron / parameters template / status but not the underlying report definition.",
    category: "Reporting",
  },
  [PERMISSIONS.NOTIFICATIONS_READ]: {
    description:
      "View outbound notification delivery health (per-recipient SENT / DELIVERED / BOUNCED / COMPLAINED status from the Resend delivery webhook). Read-only operator metadata; no PHI.",
    category: "Notifications",
  },
  [PERMISSIONS.WORKFLOW_OVERLAY_MANAGE]: {
    description:
      "Create, update, or deactivate per-tenant workflow policy overlays (tighten-only refinements of the base policy; see ADR-0019).",
    category: "Administration",
  },
  [PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW]: {
    description:
      "View persisted SOC 2 access-review snapshots (read-only). Snapshots are produced by RecordAccessReviewSnapshot and are immutable evidence rows; this permission gates the operator console's compliance browse surface without exposing user/role mutation permissions.",
    category: "Compliance",
  },
  [PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_RECORD]: {
    description:
      "Dispatch the RecordAccessReviewSnapshot command to freeze an immutable, digest-sealed (user → role → permission) snapshot for SOC 2 CC6.2 evidence. Separate from .view so the snapshot author is a deliberate, audited identity.",
    category: "Compliance",
  },
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
