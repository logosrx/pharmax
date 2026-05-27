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

  // Phase 2 — PHI domain entities. PHI columns themselves are
  // envelope-encrypted (see `@pharmax/crypto`); auto-scoping at the
  // ORM layer prevents cross-tenant *row* leaks even before crypto
  // would refuse a cross-tenant decrypt (defense in depth).
  ["Patient", { kind: "organizationId" }] as const,
  ["Provider", { kind: "organizationId" }] as const,
  ["Prescription", { kind: "organizationId" }] as const,
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
  ["Product", { kind: "organizationId" }] as const,
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
  // Inbound Clerk (identity) webhook events. Same reason as the two
  // above — the platform does not know which tenant a Clerk event
  // resolves to until the dispatcher (apps/web/src/server/auth/
  // clerk-webhook-handlers.ts) looks the Pharmax user row up by
  // `clerkUserId` in system context. The svix-id-keyed idempotency
  // ledger is platform-level by construction.
  "ClerkWebhookEvent",
]);

/**
 * Resolve the tenant filter shape for a model name. Returns `null`
 * if the model is not tenant-scoped (queries pass through).
 */
export function resolveTenantFilterKind(modelName: string | undefined): TenantFilterKind | null {
  if (modelName === undefined) return null;
  return TENANT_SCOPED_MODELS.get(modelName) ?? null;
}
