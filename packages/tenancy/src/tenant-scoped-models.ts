// Registry of which Prisma models are tenant-scoped and how their
// org filter is shaped.
//
// Rules of admission:
//   1. The model has a NON-NULLABLE `organizationId` column → use
//      `{ organizationId }` filter (the common case).
//   2. The model IS the Organization itself → use `{ id }` as the
//      filter (a user fetching "my org" should only see their org).
//   3. The model has a NULLABLE `organizationId` (system templates
//      live there) → DO NOT auto-scope, document the model below
//      under "Excluded" with the reason. Add a manual filter at the
//      repository layer instead.
//   4. Junction tables that have no `organizationId` but ARE bound
//      to a tenant transitively (e.g. `ClinicSite`) → DO NOT
//      auto-scope. Repositories must filter by the parent (Clinic),
//      which IS scoped, so the leak surface is closed via the parent.
//
// Changing this registry is a SOC 2 audit event because it changes
// the tenancy enforcement boundary. Code review of changes here must
// be paired with a justification and a regression test.

export type TenantFilterKind =
  // Standard tenant-scoped row: `{ organizationId: ctx.organizationId }`.
  | { readonly kind: "organizationId" }
  // The Organization model itself: `{ id: ctx.organizationId }`.
  | { readonly kind: "selfOrganization" };

/**
 * Map from Prisma model name → tenant filter shape.
 *
 * The model name MUST match the Prisma type as it appears in the
 * `model` field passed to the `$extends.query.$allModels` callback.
 * Prisma capitalizes model names (e.g. `Clinic`, not `clinic`).
 */
export const TENANT_SCOPED_MODELS: ReadonlyMap<string, TenantFilterKind> = new Map([
  // The Organization itself.
  ["Organization", { kind: "selfOrganization" }] as const,

  // Tenancy core.
  ["PharmacySite", { kind: "organizationId" }] as const,
  ["Clinic", { kind: "organizationId" }] as const,
  ["Team", { kind: "organizationId" }] as const,
  ["Bucket", { kind: "organizationId" }] as const,
  ["Workstation", { kind: "organizationId" }] as const,

  // Identity & RBAC.
  ["User", { kind: "organizationId" }] as const,
  ["Role", { kind: "organizationId" }] as const,
  ["UserRole", { kind: "organizationId" }] as const,

  // Workflow policy.
  ["WorkflowPolicy", { kind: "organizationId" }] as const,
  ["WorkflowPolicyOverlay", { kind: "organizationId" }] as const,

  // Reporting.
  ["ReportRun", { kind: "organizationId" }] as const,
  ["ReportSchedule", { kind: "organizationId" }] as const,

  // Notifications.
  ["NotificationDelivery", { kind: "organizationId" }] as const,

  // Compliance evidence (SOC 2 CC6.2 access reviews). The row carries
  // the full per-org (user → role → permission) graph at snapshot
  // time; tenant auto-scoping closes the leak surface for the future
  // operator-console read path that will surface "show me last
  // quarter's evidence for my org".
  ["AccessReviewSnapshot", { kind: "organizationId" }] as const,

  // Audit primitives (every write to these is also tenant-scoped).
  ["CommandLog", { kind: "organizationId" }] as const,
  ["OrderEvent", { kind: "organizationId" }] as const,
  ["AuditLog", { kind: "organizationId" }] as const,
  // AuditChainState's PK IS the organizationId — but the column is
  // still named `organizationId`, so the standard filter shape works
  // unchanged. The Prisma extension auto-injects
  // `{ organizationId: ctx.organizationId }` on every query; readers
  // and the chain writer both go through that path.
  ["AuditChainState", { kind: "organizationId" }] as const,
  ["EventOutbox", { kind: "organizationId" }] as const,
  ["IdempotencyKey", { kind: "organizationId" }] as const,

  // Billing.
  ["StripeCustomer", { kind: "organizationId" }] as const,
  ["Invoice", { kind: "organizationId" }] as const,
  ["InvoiceLine", { kind: "organizationId" }] as const,
  ["PricingRule", { kind: "organizationId" }] as const,
  // Payment is the append-only settled-money-movement ledger
  // (payment_ledger migration). NON-NULLABLE organizationId (rule 1);
  // rows are written by system commands inside the resolved org's
  // tenancy and read by finance reports — auto-scoping closes the
  // cross-tenant leak surface for both paths.
  ["Payment", { kind: "organizationId" }] as const,
  // Inventory (ADR-0035 slice 3): DSCSA lot-receipt records.
  ["DscsaTransaction", { kind: "organizationId" }] as const,
  // Controlled substances (ADR-0037): the 21 CFR 1304 dispensing
  // ledger.
  ["ControlledSubstanceDispensing", { kind: "organizationId" }] as const,
  // Compounding (ADR-0035): Master Formulation Records + ingredients,
  // and per-preparation compounding records (slice 2).
  ["CompoundFormula", { kind: "organizationId" }] as const,
  ["CompoundFormulaIngredient", { kind: "organizationId" }] as const,
  ["CompoundingRecord", { kind: "organizationId" }] as const,
  ["CompoundingRecordIngredient", { kind: "organizationId" }] as const,
  // Clinic credit ledger (clinic_credit_ledger migration). Same
  // posture as Payment: NON-NULLABLE organizationId, written by
  // billing commands, read by finance reports.
  ["ClinicCreditEntry", { kind: "organizationId" }] as const,

  // Phase 2 — PHI domain entities. PHI columns themselves are
  // envelope-encrypted (see `@pharmax/crypto`); auto-scoping at the
  // ORM layer prevents cross-tenant *row* leaks even before crypto
  // would refuse a cross-tenant decrypt (defense in depth).
  ["Patient", { kind: "organizationId" }] as const,
  // Allergy capture. Auto-scoping is load-bearing beyond the usual row
  // isolation: the PV1 screening engine reads these rows to decide
  // whether the allergy axis can be screened at all, so a query that
  // escaped its tenant would not merely leak — it would screen one
  // patient's prescription against another patient's allergies.
  ["PatientAllergy", { kind: "organizationId" }] as const,
  ["PatientAllergyHistoryAssertion", { kind: "organizationId" }] as const,
  ["Provider", { kind: "organizationId" }] as const,
  ["Prescription", { kind: "organizationId" }] as const,
  // Rx-number allocator. Carries no PHI, but auto-scoping matters for
  // a different reason: an unscoped increment would hand one tenant's
  // clinic a number out of another tenant's series, and the resulting
  // collision would surface as a unique-constraint failure at the far
  // end of a transcription rather than as an isolation error here.
  ["RxNumberSequence", { kind: "organizationId" }] as const,
  ["Order", { kind: "organizationId" }] as const,
  ["OrderLine", { kind: "organizationId" }] as const,
  // OrderCancellation carries `organizationId` and is per-order
  // (1:1 with `Order`); the standard `{ organizationId }` filter
  // shape applies. Classification landed here in lockstep with the
  // CancelOrder scaffold so the parity test stays green; the
  // command handler itself is tracked separately.
  ["OrderCancellation", { kind: "organizationId" }] as const,
  // OrderHold is the reversible hold-cycle record (PlaceHold +
  // ReleaseHold update the same row). Standard `{ organizationId }`
  // filter shape.
  ["OrderHold", { kind: "organizationId" }] as const,
  ["OrderCorrectionReopen", { kind: "organizationId" }] as const,
  // VerificationRecord is the append-only pharmacist-signoff
  // record (PV1 / Final, Approval / Rejection). Standard
  // `{ organizationId }` filter shape; the table itself is
  // INSERT/SELECT only at the DB layer (no UPDATE/DELETE grants
  // or RLS policies — see `phase2_verification_record` migration)
  // so the Prisma extension's auto-filter applies to reads while
  // the immutability invariant is enforced one layer down.
  // ApprovePV1 is the first writer; RejectPV1 /
  // ApproveFinalVerification / RejectFinalVerification follow the
  // same pattern. The workflow-safety rule that every verification
  // record must store workflow_policy_id + workflow_policy_version
  // is enforced at the command-handler layer by stamping those
  // columns from the loaded policy.
  ["VerificationRecord", { kind: "organizationId" }] as const,
  // PV1 clinical screening (pv1_clinical_screening migration).
  //
  // OrderScreeningFinding is what the screening engine told a
  // pharmacist during a PV1 pass; OrderScreeningAcknowledgement is
  // that pharmacist's recorded judgement on one finding. Both carry a
  // NON-NULLABLE organizationId (rule 1) and both are append-only at
  // the DB layer (SELECT + INSERT grants, no UPDATE/DELETE policy) —
  // same posture as VerificationRecord.
  //
  // Auto-scoping matters more than usual for the acknowledgement
  // table: ApprovePV1's gate is a READ ("which fingerprints has this
  // pharmacist settled on this order?"), and an unscoped read there
  // would let one tenant's acknowledgement satisfy another tenant's
  // approval gate. Neither table stores PHI.
  ["OrderScreeningFinding", { kind: "organizationId" }] as const,
  ["OrderScreeningAcknowledgement", { kind: "organizationId" }] as const,
  // PatientScreeningAcknowledgement is the patient-scoped sibling
  // (patient_scoped_screening_acknowledgement migration): one
  // pharmacist's judgement on a PATIENT-RECORD gap, honored across
  // that patient's orders while the record-state token still matches.
  // Same append-only posture, and the same reason auto-scoping is
  // load-bearing: the gate READS this table on ApprovePV1, and an
  // unscoped read would let one tenant's acknowledgement open another
  // tenant's safety gate.
  ["PatientScreeningAcknowledgement", { kind: "organizationId" }] as const,
  ["Product", { kind: "organizationId" }] as const,
  // ProductAiGuardrail is the tenant-authored safety envelope the AI
  // typing assistant must operate inside (typing-assist phase 1).
  // Auto-scoping is load-bearing beyond row isolation: the typing
  // validators READ this table to decide what a plausible fill looks
  // like, and an unscoped read would validate one tenant's
  // prescription against another tenant's ceilings.
  ["ProductAiGuardrail", { kind: "organizationId" }] as const,
  // AiAssistPolicy is the org-level master switch for model-backed
  // typing suggestions (one row per org). An unscoped read here would
  // let one tenant's opt-in enable the model for another tenant's
  // orders — the exact failure the off-by-default posture exists to
  // prevent.
  ["AiAssistPolicy", { kind: "organizationId" }] as const,
  ["Lot", { kind: "organizationId" }] as const,
  ["LotAssignment", { kind: "organizationId" }] as const,
  ["InventoryTransaction", { kind: "organizationId" }] as const,
  ["LabelPrinter", { kind: "organizationId" }] as const,
  ["PrintTemplate", { kind: "organizationId" }] as const,
  ["PrintJob", { kind: "organizationId" }] as const,
  ["VialLabel", { kind: "organizationId" }] as const,
  ["Shipment", { kind: "organizationId" }] as const,
  // ShipmentTrackingEvent is an append-only ledger of normalized
  // carrier tracking events. Inserts run in the org's tenancy after
  // the webhook handler resolves the shipment in system context; the
  // standard `{ organizationId }` filter shape keeps later reads
  // tenant-isolated.
  ["ShipmentTrackingEvent", { kind: "organizationId" }] as const,
  // CarrierCredential holds per-org encrypted API keys + webhook
  // secrets for the outbound shipping providers (EasyPost, FedEx,
  // UPS). Standard `{ organizationId }` filter.
  ["CarrierCredential", { kind: "organizationId" }] as const,
  ["OrderStageInterval", { kind: "organizationId" }] as const,
  // PackagePhoto is the pre-shipment package-photo capture record
  // (rep snaps a photo on the dock + types the external order
  // number; CapturePackagePhoto in `@pharmax/package-capture`
  // creates the row). Tenant-scoped on `organizationId` like every
  // other domain row; clinic isolation lives in RBAC + UI.
  ["PackagePhoto", { kind: "organizationId" }] as const,
  // PackagePhotoUploadToken is the bridge row between the
  // multipart-upload endpoint and the CapturePackagePhoto command
  // dispatch (the S3 adapter persists upload metadata here so the
  // command can resolve the opaque token to a storage tuple). RLS
  // and the Prisma extension's anti-leak guard treat it identically
  // to every other organization-scoped domain row.
  ["PackagePhotoUploadToken", { kind: "organizationId" }] as const,

  // NPI Registry sync persistence (SyncFromNpiRegistry slice 3).
  //
  // ProviderSyncRun: one row per worker invocation per org with
  //   summary metrics. Standard `{organizationId}` filter shape.
  //
  // ProviderSyncCheck: one row per (run, provider) audit row.
  //   Standard `{organizationId}` filter shape. The per-row
  //   `providerSyncRunId` + `providerId` are themselves
  //   tenant-scoped FKs so cross-org leakage via JOIN is closed by
  //   the parent policies; the auto-filter here is defense-in-depth.
  //
  // ProviderSyncReviewItem: operator review queue. Standard
  //   `{organizationId}` filter shape. The slice-6 review UI reads
  //   open items per-org; auto-filtering closes the leak surface
  //   regardless of the route's tenancy enforcement.
  //
  // NPPES data is PUBLIC (no encryption needed); these tables store
  // NPIs, provider names, practice addresses, and aggregate counts
  // — none of which are PHI under HIPAA Safe Harbor. The standard
  // organization filter is for tenant isolation, not PHI protection.
  ["ProviderSyncRun", { kind: "organizationId" }] as const,
  ["ProviderSyncCheck", { kind: "organizationId" }] as const,
  ["ProviderSyncReviewItem", { kind: "organizationId" }] as const,

  // Provider self-serve onboarding (ADR-0033). NON-NULLABLE
  // `organizationId` (rule 1). The application row holds a
  // prescriber's public professional identity claim + the public
  // NPPES proofing snapshot — no PHI, but cross-tenant reads would
  // leak which prescribers are joining which pharmacy (business
  // intelligence). The proofing drain's cross-org claim runs in an
  // explicit system-context frame, mirroring ProviderSyncRun.
  ["ProviderOnboardingApplication", { kind: "organizationId" }] as const,

  // Provider portal principals (ADR-0033, slice 2). All three carry
  // a NON-NULLABLE `organizationId` (rule 1). Portal accounts are
  // external-principal credentials; sessions and setup tokens are
  // authentication material — the same leak surface as the operator
  // auth tables below. Portal session/setup-token resolution by
  // tokenHash happens PRE-tenant in an explicit system-context frame
  // (mirrors AuthSession); every other read is org-scoped.
  ["PortalAccount", { kind: "organizationId" }] as const,
  ["PortalSession", { kind: "organizationId" }] as const,
  ["PortalSetupToken", { kind: "organizationId" }] as const,
  ["PortalPasswordHistory", { kind: "organizationId" }] as const,

  // Phase 6 — first-party auth engine. All five carry a
  // NON-NULLABLE `organizationId` (rule 1). Sessions, MFA
  // enrollments, recovery codes, password history, and reset tokens
  // are all per-user rows inside one org; cross-tenant reads of any
  // of them would leak authentication material between orgs.
  ["AuthSession", { kind: "organizationId" }] as const,
  ["MfaEnrollment", { kind: "organizationId" }] as const,
  ["RecoveryCode", { kind: "organizationId" }] as const,
  ["WebAuthnCredential", { kind: "organizationId" }] as const,
  ["WebAuthnChallenge", { kind: "organizationId" }] as const,
  ["PasswordHistory", { kind: "organizationId" }] as const,
  ["PasswordResetToken", { kind: "organizationId" }] as const,

  // Platform surface (ADR-0032). All three carry a NON-NULLABLE
  // `organizationId` (rule 1).
  //
  // ApiKey: resolution by tokenHash happens PRE-tenant in a
  //   system-context frame (mirrors AuthSession); every other read
  //   (ops key list, revoke lookup) is org-scoped and auto-filtered.
  //
  // WebhookSubscription: partner endpoint + event filter + encrypted
  //   signing secret. Cross-tenant reads would leak partner
  //   infrastructure metadata AND enable cross-org delivery — the
  //   auto-filter closes both.
  //
  // WebhookDelivery: per-org delivery ledger / dead-letter view.
  //   Fan-out inserts run in system context (worker), reads are the
  //   org's own delivery history.
  ["ApiKey", { kind: "organizationId" }] as const,
  ["WebhookSubscription", { kind: "organizationId" }] as const,
  ["WebhookDelivery", { kind: "organizationId" }] as const,
]);

/**
 * Models DELIBERATELY excluded from auto-scoping, with reasons.
 * Kept here as documentation; the extension just consults the
 * positive registry above.
 *
 *   - ClinicSite: junction table; org isolation is enforced through
 *     Clinic (which IS scoped). Joining without going through Clinic
 *     would itself be a bug; the parent scope closes the leak.
 *   - Permission: system-wide permission registry. Same rows visible
 *     to all orgs by design.
 *   - RolePermission: system-wide mapping of Role → Permission. The
 *     Role itself IS tenant-scoped, so cross-org leaks via this
 *     table require first leaking a Role row.
 *   - StripeWebhookEvent: events arrive from Stripe BEFORE we know
 *     which tenant they belong to. Resolution happens in the
 *     dispatcher, after which the dispatch handler enters a tenancy
 *     context.
 */
export const TENANT_EXCLUDED_MODELS: ReadonlySet<string> = new Set([
  "ClinicSite",
  "Permission",
  "RolePermission",
  "StripeWebhookEvent",
  // Inbound EasyPost (carrier tracking) webhook events. Same reason
  // as StripeWebhookEvent — the platform doesn't know which tenant a
  // tracker event belongs to until the worker drain resolves the
  // shipment by tracking number and enters that org's tenancy to
  // execute RecordShipmentTrackingEvent.
  "EasyPostWebhookEvent",
  // Inbound FedEx Advanced Integrated Visibility webhook events.
  // Same reason as EasyPostWebhookEvent — the platform doesn't know
  // which tenant a tracking event belongs to until the worker drain
  // resolves the shipment by tracking number and enters that org's
  // tenancy to execute RecordShipmentTrackingEvent.
  "FedExWebhookEvent",
  // Inbound Clerk (identity) webhook events. DORMANT: ADR-0030 retired
  // Clerk and deleted both the route and the dispatcher that wrote this
  // ledger, so nothing has written it since. The model is still in the
  // schema and the table is still RLS-exempt, so it must stay listed
  // here — dropping it from this set would make the schema linter
  // demand a tenancy scope for a table that has none and never can:
  // the rows are keyed by svix message id and carry no organization.
  // Remove this entry only in the same change that drops the model
  // (see EI-6 in docs/soc2/evidence-integrity-findings.md).
  "ClerkWebhookEvent",
  // Inbound Resend (email delivery) webhook events. Same reason as
  // the webhook ledgers above — the platform does not know which
  // tenant a delivery event belongs to until the handler looks the
  // `notification_delivery` row up by `providerMessageId` in system
  // context. The svix-id-keyed idempotency ledger is platform-level.
  "ResendWebhookEvent",
  // Login attempts (phase 6 auth engine) have a NULLABLE
  // `organizationId` (rule 3): a failed attempt against an unknown
  // email resolves to no org at all, and the row must still be
  // writable for lockout/rate-limit counting BEFORE any tenant is
  // known. The auth engine writes these in system context; reads
  // (security feed, lockout checks) filter explicitly at the
  // repository layer.
  "LoginAttempt",
  // Break-glass session envelope + per-operation ledger
  // (@pharmax/security). Sessions open a cross-tenant
  // `pharmax_system` context by definition, so neither table has an
  // organizationId at all. Writes/reads happen only inside
  // @pharmax/security's system-context frames (open/close/runAs, the
  // nightly digest probe, the quarterly access-review evidence pack).
  // Append-only invariants are enforced at the DB grant layer — see
  // the phase5_break_glass_session migration.
  "BreakGlassSession",
  "BreakGlassAction",
  // Compliance control plane (@pharmax/compliance). The control
  // program being evidenced is Pharmax-the-operator's, not any one
  // tenant's: a probe asking "is RLS still enabled on every tenant
  // table" or "does branch protection still require CodeQL" has no
  // organizationId to belong to, and the per-org probes (audit-chain
  // verification) span ALL tenants in a single run. Follows the
  // break-glass precedent rather than inventing a synthetic platform
  // org — the tables ARE the append-only evidence ledger, with
  // UPDATE/DELETE revoked at the grant layer. Where a run or
  // exception names the tenant it examined, it does so through an
  // unlinked `subjectOrganizationId` uuid, deliberately not a FK, so
  // evidence outlives tenant offboarding.
  "ComplianceCriterion",
  "ComplianceControl",
  "ComplianceControlCriterion",
  "ComplianceCheck",
  "ComplianceCheckControl",
  "ComplianceCheckRun",
  "ComplianceCheckException",
  "ComplianceTask",
  // Same plane: a model-drafted proposal about the platform's own
  // control program has no tenant to belong to either.
  "ComplianceAiDraft",
  // RxNorm drug-knowledge reference tables — the platform's first
  // GLOBAL reference data, deliberately not tenant-scoped (same
  // posture as Permission). Drug nomenclature is not tenant data:
  // every org screens against the same public NLM release, rows carry
  // no organizationId and no PHI, and a per-org copy would only let
  // two tenants disagree about what an NDC contains. The isolation
  // control is a WRITE boundary rather than a read boundary:
  // pharmax_app holds SELECT only, and writes happen solely through
  // the ingestion job (scripts/operations/ingest-rxnorm-release.ts)
  // under a role with the write grants — see the
  // 20260809000000_rxnorm_drug_knowledge migration.
  "RxnormRelease",
  "RxnormNdcProduct",
  "RxnormProductIngredient",
]);

/**
 * Resolve the tenant filter shape for a model name. Returns `null`
 * if the model is not tenant-scoped (queries pass through).
 */
export function resolveTenantFilterKind(modelName: string | undefined): TenantFilterKind | null {
  if (modelName === undefined) return null;
  return TENANT_SCOPED_MODELS.get(modelName) ?? null;
}
