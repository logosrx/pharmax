// Typed permission registry.
//
// This file is the SINGLE source of truth for the action vocabulary
// of the platform. It mirrors the codes seeded by `prisma/seed.ts`
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
  // Create / edit / delete the org's operational queue buckets. Held
  // separately from ORG_MANAGE_SITES because a bucket is the unit the
  // workflow engine routes orders INTO: a bad bucket edit misroutes
  // live work, whereas a bad site-address edit only breaks label
  // purchase. The seven seeded buckets stay immutable in the fields
  // that matter (`code`, `kind`) regardless of who holds this.
  ORG_MANAGE_BUCKETS: "org.manage_buckets",

  // Patient roster.
  PATIENTS_CREATE: "patients.create",
  PATIENTS_READ: "patients.read",
  PATIENTS_UPDATE: "patients.update",
  PATIENTS_CRYPTO_SHRED: "patients.crypto_shred",

  // Allergy profile. Three grants rather than one, split on which
  // direction the change moves patient safety.
  //
  // RECORD covers both adding an allergy and asserting that a history
  // was taken and found nothing. Deliberately ONE grant: split them and
  // the predictable outcome is staff who can add allergies but cannot
  // record their absence, so nobody ever records the absence and the
  // per-patient screening gap never closes for a genuinely allergy-free
  // patient. Both are the same act — taking a history.
  //
  // AMEND_STATUS is separate and set higher because it is the only one
  // that REMOVES a safety check: refuting an allergy, or marking it
  // entered-in-error, stops it driving the PV1 screen. Adding a wrong
  // allergy costs a false alert; retracting a right one costs the alert
  // that mattered.
  PATIENTS_ALLERGIES_READ: "patients.allergies.read",
  PATIENTS_ALLERGIES_RECORD: "patients.allergies.record",
  PATIENTS_ALLERGIES_AMEND_STATUS: "patients.allergies.amend_status",

  // Provider (prescriber) roster.
  PROVIDERS_CREATE: "providers.create",
  PROVIDERS_READ: "providers.read",
  PROVIDERS_UPDATE: "providers.update",
  PROVIDERS_DEACTIVATE: "providers.deactivate",
  PROVIDERS_REACTIVATE: "providers.reactivate",
  // Self-serve onboarding (ADR-0033). SUBMIT is machine-only (the
  // per-org ProviderOnboardingService identity behind the public
  // apply endpoint + the proofing drain); REVIEW is the human ops
  // decision on the NEEDS_REVIEW queue.
  PROVIDERS_ONBOARDING_SUBMIT: "providers.onboarding.submit",
  PROVIDERS_ONBOARDING_REVIEW: "providers.onboarding.review",

  // Prescription intake. Transcribing a prescription is the act that
  // brings a clinical order into the system; it is deliberately a
  // separate grant from ORDERS_ADD_PRESCRIPTION, which only attaches
  // an already-transcribed prescription to an order.
  PRESCRIPTIONS_CREATE: "prescriptions.create",

  // Clinic (practice) directory.
  CLINICS_READ: "clinics.read",

  // Inventory catalog: drug products + lots/batches.
  INVENTORY_READ: "inventory.read",
  // Create an in-house compound product in the catalog: mints the
  // org's next Pharmax Product ID (PXP series) and fixes the serial
  // identity (drug initial + primary-drug mg) that every batch unit
  // number of this product will carry. Creation only — there is
  // deliberately no product-edit surface behind this grant, because
  // an ndcKind flip or a serial-identity change on a live product is
  // a screening-suppression / label-orphaning vector (see the
  // WRITE-SURFACE REQUIREMENT note on `Product.ndcKind`).
  CATALOG_COMPOUND_PRODUCT_CREATE: "catalog.compound_product.create",
  // Receive an inbound lot shipment (ADR-0035 slice 3): creates or
  // extends the Lot, credits the inventory ledger, and stores the
  // DSCSA transaction record.
  INVENTORY_RECEIVE: "inventory.receive",
  // Create / edit catalog products AND their AI typing-assist
  // guardrails. One grant for both surfaces on purpose: the guardrail
  // is part of the product's safety configuration, authored at
  // product-creation time. This permission closes the write-surface
  // requirement documented on `product.ndcKind` — flipping
  // NATIONAL → IN_HOUSE_COMPOUND silences an acknowledge-tier PV1
  // prompt, so every ndcKind change is permission-gated here and
  // audit-logged by the command.
  INVENTORY_PRODUCTS_MANAGE: "inventory.products.manage",

  // Org-level AI typing-assist policy (master switch, confidence
  // threshold, controlled-substance opt-in). Separate from
  // INVENTORY_PRODUCTS_MANAGE because enabling the model org-wide is
  // a higher-blast-radius decision than bounding one product —
  // restricted to OrgAdmin by default.
  AI_ASSIST_POLICY_MANAGE: "ai.assist_policy.manage",

  // Compound batch lifecycle (Products/Compounds PR 2). Three grants
  // split along "who may do this on the floor":
  //
  //   CREATE      — record a finished production run: mints the batch
  //                 number and EVERY unit serial up front. Compounding-
  //                 floor work (tech-level).
  //   TRANSITION  — operational moves: send a batch to the lab, point
  //                 dispensing at a released batch. Tech-level.
  //   RELEASE     — the quality decision: accept or reject the lab
  //                 result. Releasing a failed batch dispenses it to
  //                 patients — pharmacist-level only.
  INVENTORY_BATCH_CREATE: "inventory.batch.create",
  INVENTORY_BATCH_TRANSITION: "inventory.batch.transition",
  INVENTORY_BATCH_RELEASE: "inventory.batch.release",
  // Print (and reprint) compound stock labels: the batch record label
  // and the per-unit vial labels. One grant covers both first print and
  // reprint because the command derives "this is a reprint" from print
  // history and demands a reason code then — a separate reprint grant
  // would imply a separate endpoint, which is the thing that lets a
  // duplicate label reach a shelf with no reason recorded.
  INVENTORY_BATCH_LABEL_PRINT: "inventory.batch.label_print",

  // Compounding (ADR-0035): Master Formulation Records. MANAGE covers
  // the whole formula lifecycle (author/publish/retire) — pharmacist-
  // level authority; READ lets preparers work from ACTIVE formulas.
  COMPOUNDING_READ: "compounding.read",
  COMPOUNDING_FORMULA_MANAGE: "compounding.formula.manage",
  // Record a preparation against an ACTIVE formula during fill
  // (slice 2): consumes ingredient lots, computes the BUD, and writes
  // the USP compounding record.
  COMPOUNDING_PREPARE: "compounding.prepare",

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
  SHIP_ARCHIVE_PACKAGE_PHOTO: "ship.archive_package_photo",

  // Billing.
  BILLING_READ: "billing.read",
  BILLING_MANAGE: "billing.manage",
  BILLING_APPROVE_INVOICE: "billing.approve_invoice",
  BILLING_FINALIZE_INVOICE: "billing.finalize_invoice",
  BILLING_MANAGE_PRICING: "billing.manage_pricing",
  BILLING_CREDIT_INVOICE: "billing.credit_invoice",
  BILLING_ISSUE_REFUND: "billing.issue_refund",
  BILLING_RECORD_MANUAL_PAYMENT: "billing.record_manual_payment",
  BILLING_MANAGE_CLINIC_CREDIT: "billing.manage_clinic_credit",

  // Audit.
  AUDIT_READ: "audit.read",

  // Reporting.
  REPORTS_RUN: "reports.run",
  REPORTS_MANAGE_SCHEDULE: "reports.manage_schedule",

  // Notifications.
  NOTIFICATIONS_READ: "notifications.read",

  // SLA / operational escalation.
  ORDERS_ESCALATE_SLA: "orders.escalate_sla",

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

  // Read the compliance control plane: controls, framework
  // crosswalks, probe definitions, run history, exceptions, tasks.
  // Read-only, and safe to grant broadly to anyone who needs to see
  // posture — the run history contains structural facts and counts,
  // never PHI.
  COMPLIANCE_CONTROL_PLANE_VIEW: "compliance.control_plane.view",

  // Attest that a control is designed and operating, stamping
  // `lastSignedOffAt` / `lastSignedOffByUserId`.
  //
  // Deliberately separate from `.view` and from every automated path.
  // Probes produce evidence; a control is signed by a NAMED human who
  // is accountable for the claim, and that signature is what an
  // auditor asks about. No worker, scheduler, or model-driven code
  // path holds this permission.
  COMPLIANCE_CONTROL_SIGN_OFF: "compliance.control.sign_off",

  // Accept a failing check as a time-boxed, justified exception.
  //
  // The highest-blast-radius permission in the compliance surface: it
  // is the one that makes a red control stop being red. Every
  // exception requires a reason code, a written justification, and a
  // hard expiry, and the approver is recorded non-repudiably. Hold
  // this separate from `.sign_off` so the person who can silence a
  // finding is a deliberate choice rather than a side effect of
  // being able to attest to controls.
  COMPLIANCE_EXCEPTION_ACCEPT: "compliance.exception.accept",

  // Assign and close compliance remediation tasks. Lower bar than
  // accepting an exception: closing a task asserts the problem was
  // FIXED, which the next probe run independently re-verifies. An
  // exception asserts the problem is tolerated, which nothing
  // re-verifies.
  COMPLIANCE_TASK_MANAGE: "compliance.task.manage",

  // Platform surface (ADR-0032): partner API keys + outbound webhooks.
  // Mint / revoke partner API keys for the public v1 API. The raw
  // token is shown once at mint time; only its SHA-256 hash is
  // stored. Restricted to OrgAdmin by default — a minted key can
  // exercise any scope granted to it (bounded by the minter's RBAC
  // for mutations), so key minting is itself a privileged action.
  API_KEYS_MANAGE: "api.keys.manage",

  // Create / revoke outbound webhook subscriptions (partner endpoint
  // URL + event-type filter + HMAC signing secret). Exposed on the
  // public v1 API so partners can self-serve; every subscription is
  // limited to phi-safe registry events by construction.
  WEBHOOKS_MANAGE: "webhooks.manage",
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
  [PERMISSIONS.ORG_MANAGE_BUCKETS]: {
    description:
      "Create, rename, reorder, and delete custom operational queue buckets. System buckets seeded by ProvisionDefaultBuckets accept display changes only; their code and kind stay immutable, and no bucket holding orders can be deleted.",
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
  [PERMISSIONS.PATIENTS_ALLERGIES_READ]: {
    description:
      "Read a patient's allergy and intolerance profile, including whether an allergy history has been taken at all.",
    category: "Patients",
  },
  [PERMISSIONS.PATIENTS_ALLERGIES_RECORD]: {
    description:
      "Record an allergy or intolerance, or assert that an allergy history was taken (no known allergies / unable to assess).",
    category: "Patients",
  },
  [PERMISSIONS.PATIENTS_ALLERGIES_AMEND_STATUS]: {
    description:
      "Change the clinical or verification status of a recorded allergy — resolve, refute, or mark entered-in-error. Stops the record driving PV1 screening, so it is a pharmacist-level grant.",
    category: "Patients",
  },
  [PERMISSIONS.PRESCRIPTIONS_CREATE]: {
    description:
      "Transcribe a new prescription (encrypts the sig; enforces DEA Part 1306 authorization limits for controlled substances).",
    category: "Prescriptions",
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
  [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT]: {
    description:
      "Submit a provider self-serve onboarding application and record its automated NPPES proofing outcome (ADR-0033). Machine permission — granted only to the per-org ProviderOnboardingService identity that fronts the public apply endpoint and the proofing drain.",
    category: "Providers",
  },
  [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW]: {
    description:
      "Decide a NEEDS_REVIEW provider onboarding application (approve creates the roster row; reject requires a reason code). Human review permission for the ops onboarding queue.",
    category: "Providers",
  },
  [PERMISSIONS.CLINICS_READ]: {
    description:
      "View the clinic (practice) directory: codes, names, statuses, and pharmacy-site links. Directory metadata only — no PHI.",
    category: "Clinics",
  },
  [PERMISSIONS.INVENTORY_READ]: {
    description:
      "View the drug product catalog and inventory lots/batches (NDC, name, lot number, expiration, status). Read-only; lot assignment stays behind fill.assign_lot.",
    category: "Inventory",
  },
  [PERMISSIONS.CATALOG_COMPOUND_PRODUCT_CREATE]: {
    description:
      "Create an in-house compound product in the catalog: mints the org's next Pharmax Product ID (PXP series) and fixes the serial identity (primary-drug initial + mg) stamped on every batch unit number. Creation only — no edit surface, because ndcKind flips and serial-identity changes on live products are suppression/orphaning vectors.",
    category: "Inventory",
  },
  [PERMISSIONS.INVENTORY_RECEIVE]: {
    description:
      "Receive an inbound lot shipment (ADR-0035 slice 3): creates or extends the Lot, credits the inventory ledger with LOT_RECEIVED, and stores the DSCSA transaction record (TI snapshot + Transaction Statement gate). Refuses expired stock and shipments without the seller's TS.",
    category: "Inventory",
  },
  [PERMISSIONS.INVENTORY_PRODUCTS_MANAGE]: {
    description:
      "Create and edit catalog products and their AI typing-assist guardrails (quantity/days-supply/refills ceilings, per-product AI kill switch). Gates ndcKind and controlled-substance-schedule changes — both alter downstream screening behavior, so every change is audit-logged with before/after values.",
    category: "Inventory",
  },
  [PERMISSIONS.AI_ASSIST_POLICY_MANAGE]: {
    description:
      "Set the org-level AI typing-assist policy: master switch for model-backed suggestions, minimum confidence threshold, and the controlled-substance opt-in. Enabling the model org-wide is a high-blast-radius decision — OrgAdmin only by default.",
    category: "Administration",
  },
  [PERMISSIONS.INVENTORY_BATCH_CREATE]: {
    description:
      "Record a finished compound production run (CreateCompoundBatch): mints the batch number (site code + serial identity + batch-of-day + date) and a serial number for every unit, and starts the batch in COMPOUNDED. Catalog/inventory data only — no PHI.",
    category: "Inventory",
  },
  [PERMISSIONS.INVENTORY_BATCH_TRANSITION]: {
    description:
      "Operational compound-batch moves: send a COMPOUNDED batch to the testing lab, and point dispensing at a RELEASED batch (demoting the incumbent). Does NOT cover accepting/rejecting lab results — that is inventory.batch.release.",
    category: "Inventory",
  },
  [PERMISSIONS.INVENTORY_BATCH_RELEASE]: {
    description:
      "Record the lab's verdict on a TESTING compound batch: release it for dispensing, or reject it with a reason code (terminal). A quality decision with direct patient exposure — pharmacist-level.",
    category: "Inventory",
  },
  [PERMISSIONS.INVENTORY_BATCH_LABEL_PRINT]: {
    description:
      "Print and reprint in-house compound stock labels: the batch record label (barcode + Pharmax Product ID + batch number) and per-unit vial labels carrying each unit's serial. Reprints require a reason code, derived from print history rather than a separate grant. Refuses printing for a lab-rejected batch. No PHI — a batch has no patient.",
    category: "Inventory",
  },
  [PERMISSIONS.COMPOUNDING_READ]: {
    description:
      "View compound formulas (Master Formulation Records): codes, versions, ingredients, BUD policy, hazard flags. Recipe/catalog data only — no PHI.",
    category: "Compounding",
  },
  [PERMISSIONS.COMPOUNDING_FORMULA_MANAGE]: {
    description:
      "Author, publish, and retire compound formulas (ADR-0035). Publishing makes a version immutable and retires its predecessor; retiring requires a reason code. Pharmacist-level authority.",
    category: "Compounding",
  },
  [PERMISSIONS.COMPOUNDING_PREPARE]: {
    description:
      "Record a compounding preparation during fill (ADR-0035 slice 2): pins the ACTIVE formula version, consumes ingredient lots into the inventory ledger, computes the beyond-use date, and writes the USP <795>/<797> compounding record with its rendered document.",
    category: "Compounding",
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
  [PERMISSIONS.SHIP_ARCHIVE_PACKAGE_PHOTO]: {
    description:
      "Archive a PackagePhoto out of the triage bucket and order timeline with a disposition reason (test capture, duplicate, captured in error, or unresolvable).",
    category: "Shipping",
  },
  [PERMISSIONS.BILLING_READ]: { description: "View billing data.", category: "Billing" },
  [PERMISSIONS.BILLING_MANAGE]: {
    description: "Manage invoices and pricing.",
    category: "Billing",
  },
  [PERMISSIONS.BILLING_APPROVE_INVOICE]: {
    description:
      "Approve a reviewed DRAFT invoice, stamping the revision that FinalizeInvoice requires. Lines appended after approval invalidate it (re-review required).",
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
  [PERMISSIONS.BILLING_RECORD_MANUAL_PAYMENT]: {
    description:
      "Record a settled out-of-band payment (check / ACH / wire / cash) against an OPEN invoice; appends the payment-ledger row and flips the invoice to PAID when fully collected.",
    category: "Billing",
  },
  [PERMISSIONS.BILLING_MANAGE_CLINIC_CREDIT]: {
    description:
      "Grant clinic credit (overpayment excess, goodwill) and apply stored credit to OPEN invoices via the clinic credit ledger.",
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
  [PERMISSIONS.ORDERS_ESCALATE_SLA]: {
    description:
      "Route an SLA-breached order into the EMERGENCY bucket. Held by the machine SLA-evaluator identity (the worker breach-evaluator tick); an operational bucket move, not a workflow-status transition.",
    category: "Workflow",
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
  [PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW]: {
    description:
      "Read the compliance control plane: controls, framework crosswalks, probe definitions, run history, exceptions, and remediation tasks. Read-only and PHI-free (probe output is structural facts and counts), so it is safe to grant to anyone who needs posture visibility.",
    category: "Compliance",
  },
  [PERMISSIONS.COMPLIANCE_CONTROL_SIGN_OFF]: {
    description:
      "Dispatch SignOffControl to attest that a control is designed and operating. Probes produce evidence; a named human signs the control, and that signature is what an auditor examines. No automated or model-driven path holds this permission.",
    category: "Compliance",
  },
  [PERMISSIONS.COMPLIANCE_EXCEPTION_ACCEPT]: {
    description:
      "Dispatch AcceptCheckException to accept a failing check as a time-boxed, justified exception. The highest-blast-radius permission in the compliance surface — it is what makes a red control stop being red. Requires a reason code, a written justification, and a hard expiry; the approver is recorded non-repudiably.",
    category: "Compliance",
  },
  [PERMISSIONS.COMPLIANCE_TASK_MANAGE]: {
    description:
      "Assign and close compliance remediation tasks. A lower bar than accepting an exception: closing a task asserts the problem was fixed, which the next probe run independently re-verifies.",
    category: "Compliance",
  },
  [PERMISSIONS.API_KEYS_MANAGE]: {
    description:
      "Mint and revoke partner API keys for the public v1 API (ADR-0032). Raw tokens are shown once and stored only as SHA-256 hashes; a key's mutation authority is bounded by its scopes and its minter's live RBAC.",
    category: "Platform",
  },
  [PERMISSIONS.WEBHOOKS_MANAGE]: {
    description:
      "Create and revoke outbound webhook subscriptions (partner endpoint URL, event-type filter, HMAC signing secret). Subscriptions are restricted to phi-safe registry events by construction (ADR-0032).",
    category: "Platform",
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
