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
      // The allergy profile is a PV1 input, so a pharmacist must be
      // able to read it and to correct it. AMEND_STATUS sits here and
      // NOT with technicians: refuting an allergy is the one edit that
      // switches a safety check off, and it is a clinical judgement.
      PERMISSIONS.PATIENTS_ALLERGIES_READ,
      PERMISSIONS.PATIENTS_ALLERGIES_RECORD,
      PERMISSIONS.PATIENTS_ALLERGIES_AMEND_STATUS,
      PERMISSIONS.PROVIDERS_READ,
      // Read-only directory surfaces: pharmacists verify against the
      // drug catalog / lot status and need to see which practice an
      // order came from. Neither grant exposes PHI or a mutation path.
      PERMISSIONS.CLINICS_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_RECEIVE,
      // Product catalog + AI guardrail authority. Pharmacist-level
      // because both ndcKind and the controlled-substance schedule
      // change downstream screening behavior, and the guardrail
      // ceilings are a clinical plausibility judgement. Technicians
      // deliberately do NOT carry this — a tech works inside the
      // envelope, a pharmacist authors it.
      PERMISSIONS.INVENTORY_PRODUCTS_MANAGE,
      // Defining a compound product (name, strength, serial identity)
      // is catalog authority of the same weight as authoring its
      // formula — pharmacist-level, not a technician grant. The
      // minted Pharmax Product ID and serial identity are frozen at
      // creation and stamped on every batch label thereafter.
      PERMISSIONS.CATALOG_COMPOUND_PRODUCT_CREATE,
      // Compounding formula authority (ADR-0035): the Master
      // Formulation Record is a pharmacist-owned document per
      // USP <795>/<797> — authoring/publish/retire sits here, not
      // with technicians.
      PERMISSIONS.COMPOUNDING_READ,
      PERMISSIONS.COMPOUNDING_FORMULA_MANAGE,
      PERMISSIONS.COMPOUNDING_PREPARE,
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
      // Taking an allergy history is intake work, and the technician is
      // who does it. Recording an allergy — or recording that there are
      // none — is therefore a tech grant; amending a recorded status is
      // not.
      PERMISSIONS.PATIENTS_ALLERGIES_READ,
      PERMISSIONS.PATIENTS_ALLERGIES_RECORD,
      PERMISSIONS.PROVIDERS_CREATE,
      PERMISSIONS.PROVIDERS_READ,
      PERMISSIONS.PROVIDERS_UPDATE,
      PERMISSIONS.PROVIDERS_DEACTIVATE,
      PERMISSIONS.PROVIDERS_REACTIVATE,
      // Techs type orders against clinics and fill from lots — the
      // read-only directory tabs are their reference surfaces.
      PERMISSIONS.CLINICS_READ,
      PERMISSIONS.INVENTORY_READ,
      // Techs receive inbound stock (DSCSA receipt is data entry with
      // hard statutory gates enforced by the command).
      PERMISSIONS.INVENTORY_RECEIVE,
      // Techs prepare from ACTIVE formulas; they do not author them.
      PERMISSIONS.COMPOUNDING_READ,
      PERMISSIONS.COMPOUNDING_PREPARE,
      // Transcription is a technician function; the pharmacist's
      // check on it is PV1, not a second data-entry grant.
      PERMISSIONS.PRESCRIPTIONS_CREATE,
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
    // ---------------------------------------------------------------
    // ProviderOnboardingService — machine-only role for provider
    // self-serve onboarding (ADR-0033): the per-org
    // `provider-onboarding@<org-slug>.test` service user that acts
    // for the public apply endpoint AND the worker's NPPES proofing
    // drain.
    //
    // Why one permission covers both commands: the apply endpoint
    // dispatches SubmitProviderOnboardingApplication and the drain
    // dispatches RecordProviderOnboardingProofing — both are
    // machine-initiated steps of the same pipeline, so they share
    // `providers.onboarding.submit`. Human decisions (approve /
    // reject from the review queue) require the SEPARATE
    // `providers.onboarding.review`, which this role deliberately
    // does NOT carry: a compromised onboarding service user can
    // file applications and record proofing outcomes, but a
    // proofing PASS still only auto-approves through the command's
    // own NPPES-match gate — it cannot rubber-stamp the review
    // queue.
    // ---------------------------------------------------------------
    code: "ProviderOnboardingService",
    name: "Provider Onboarding Service (machine)",
    scope: RoleScope.ORGANIZATION,
    description:
      "Per-org service identity for provider self-serve onboarding (public apply endpoint + NPPES proofing drain). Machine-only; not assignable to human users. Grants ONLY `providers.onboarding.submit`.",
    permissions: [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT],
  },
  {
    // ---------------------------------------------------------------
    // ProviderPortalService — machine-only role for prescriber-portal
    // writes (ADR-0033 slice 3): the per-org
    // `provider-portal@<org-slug>.test` service user that dispatches
    // `UpdateProvider` when a signed-in prescriber edits their own
    // contact details.
    //
    // Why a DEDICATED role instead of reusing NpiSyncWorker (which
    // also carries `providers.update`): audit attribution. A
    // provider row updated by the npi-sync identity means "CMS
    // registry drift"; updated by THIS identity it means "the
    // prescriber edited their own profile" — collapsing the two
    // would make the audit trail lie about provenance. The portal
    // route pins the target to the SESSION's own providerId and
    // restricts the field set to contact info (no name, no DEA, no
    // NPI) before dispatch; the command's RBAC gate is this role's
    // single grant.
    //
    // SOC 2 / HIPAA: a compromised portal service user can update
    // provider demographics org-wide (same blast radius as the
    // npi-sync identity, no PHI). Recovery is operational: disable
    // the user row, review provider.updated.v1 audit entries.
    // ---------------------------------------------------------------
    code: "ProviderPortalService",
    name: "Provider Portal Service (machine)",
    scope: RoleScope.ORGANIZATION,
    description:
      "Per-org service identity for prescriber-portal profile updates (routes through UpdateProvider). Machine-only; not assignable to human users. Grants ONLY `providers.update`.",
    permissions: [PERMISSIONS.PROVIDERS_UPDATE],
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
      PERMISSIONS.BILLING_APPROVE_INVOICE,
      PERMISSIONS.BILLING_FINALIZE_INVOICE,
      PERMISSIONS.BILLING_MANAGE_PRICING,
      PERMISSIONS.BILLING_CREDIT_INVOICE,
      PERMISSIONS.BILLING_ISSUE_REFUND,
      PERMISSIONS.BILLING_RECORD_MANUAL_PAYMENT,
      PERMISSIONS.BILLING_MANAGE_CLINIC_CREDIT,
    ],
  },
]);

/** Convenience accessor for tests and seeds. */
export function findRoleTemplate(code: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.code === code);
}
