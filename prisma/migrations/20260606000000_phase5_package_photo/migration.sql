-- migration: 20260606000000_phase5_package_photo
--
-- Pre-shipment package-photo capture record. The shipping rep
-- snaps a photo of the sealed package on the dock, types the
-- pharmacy's external order number, and (optionally) the carrier
-- tracking number. The CapturePackagePhoto command:
--
--   1. Persists the photo bytes via @pharmax/package-capture's
--      storage port (S3 in prod, in-memory in tests). The storage
--      layer returns { bucket, key, sha256, fileSize, contentType }.
--   2. Looks up the corresponding `Order` row by
--      (organizationId, externalOrderNumber). When found, links the
--      photo to the matched order + patient and pulls the most
--      recent shipment's trackingNumber.
--   3. Inserts THIS row in the same tx as the bus's command_log /
--      audit_log / event_outbox writes (the standard 20-step
--      contract).
--
-- Why a dedicated table instead of a column on `shipment`:
--   - Photos can be captured BEFORE a shipment row exists (rep
--     prep stage), and AFTER (re-shipped, exception-bucket triage).
--   - Photos can be captured for an order that is NEVER matched
--     (the rep typed an unknown external order number) — those
--     unmatched rows are still first-class so a reconciliation
--     workflow can resolve them later. A `shipment_id`-keyed
--     column would silently lose those.
--   - Match strategy + tracking source are normalized enums so
--     reporting can answer "what % of captures auto-matched?" and
--     "what fraction of trackings came from the order vs manual
--     typing?" without parsing freeform metadata.
--
-- PHI rule:
--   - `notesEnc` is envelope-encrypted because rep notes may
--     carry incidental PHI (e.g. "patient said leave at neighbor's
--     house at 12 Main St"). The bus's `redactFields` declaration
--     scrubs the plaintext from `command_log.requestPayload`.
--   - The image bytes themselves are NEVER stored in this table —
--     only `(storageBucket, storageKey, sha256, fileSize)`.
--     Storage adapter (S3) MUST be SSE-KMS encrypted at rest.
--   - Audit metadata + outbox payload echo only structural fields
--     (photoId, matched, matchStrategy, trackingSource) — never
--     the operator's notes or the storage key (treated as opaque).
--
-- RLS shape mirrors the baseline: ENABLE + FORCE + one PERMISSIVE
-- `tenant_isolation` policy keyed on the standard
-- `pharmax.system_context` / `pharmax.organization_id` GUC pair.
-- The migration linter (`scripts/check-migration-rls.ts`) walks
-- this file and asserts the pair is present.

-- ---------------------------------------------------------------------
-- 1. New enums.
-- ---------------------------------------------------------------------

CREATE TYPE "PackagePhotoTrackingSource" AS ENUM (
    -- Resolved from the matched order's most recent Shipment row.
    'ORDER',
    -- Resolved from a ShipmentTrackingEvent payload (carrier-issued).
    -- Reserved for future enrichment; Phase 1 does not populate this.
    'TRACKING_EVENT',
    -- Operator typed the tracking number directly into the capture
    -- form (label-on-the-package case).
    'MANUAL'
);

CREATE TYPE "PackagePhotoMatchStrategy" AS ENUM (
    -- Auto-matched on (organizationId, externalOrderNumber).
    'EXTERNAL_ORDER_NUMBER',
    -- Reserved for future strategies (operator-provided patient id /
    -- prescription id). Phase 1 does not populate this.
    'MANUAL_PATIENT_ID',
    -- No match found. The row still exists; a reconciliation
    -- workflow (Phase 2 of the package-photo work) can resolve it.
    'UNMATCHED'
);

-- ---------------------------------------------------------------------
-- 2. New table: package_photo.
--
--    Append-only by convention. The bus only ever inserts; updates
--    happen via follow-on commands (e.g. a future
--    ResolvePackagePhotoMatch command that flips matched=true once
--    an operator manually links an unmatched photo to an order).
--    Today the only writer is CapturePackagePhoto.
-- ---------------------------------------------------------------------

CREATE TABLE "package_photo" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    -- Capture context (the operator's tenancy snapshot at
    -- capture time). siteId is REQUIRED because the rep is
    -- always working at a pharmacy site; clinicId is OPTIONAL
    -- because a rep working multiple clinics' orders has no
    -- single clinic context. workstationId is OPTIONAL because
    -- mobile capture (phone in hand at the dock) doesn't have a
    -- workstation row.
    "siteId" UUID NOT NULL,
    "clinicId" UUID,
    "capturedByUserId" UUID NOT NULL,
    "capturedAtWorkstationId" UUID,

    -- Operator-typed external order number (the pharmacy's
    -- upstream order id). Always recorded, even when no Order row
    -- matches — the unmatched rep keystroke is the audit trail.
    "pharmacyExternalOrderNumber" TEXT NOT NULL,

    -- Match metadata. Both nullable: a row is created BEFORE any
    -- match attempt is committed, and an unmatched row stays
    -- with matched=false / matchStrategy=UNMATCHED forever (or
    -- until a follow-up command resolves it).
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "matchStrategy" "PackagePhotoMatchStrategy" NOT NULL DEFAULT 'UNMATCHED',
    "matchedOrderId" UUID,
    "matchedPatientId" UUID,
    "matchedAt" TIMESTAMP(3),

    -- Tracking metadata. trackingNumber may be NULL when no
    -- shipment exists yet AND the operator didn't type one in.
    "trackingNumber" TEXT,
    "trackingSource" "PackagePhotoTrackingSource",
    "sourceShipmentId" UUID,

    -- Storage layer pointer. The adapter computed sha256 over
    -- the raw bytes BEFORE upload and returns it here so we can
    -- dedupe via the unique index below.
    "storageBucket" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,

    -- Optional rep notes (PHI-possible; envelope-encrypted).
    "notesEnc" JSONB,

    "capturedAt" TIMESTAMP(3) NOT NULL,
    "commandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_photo_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
--
--    - sha256 dedup (org-scoped) so the rep retaking the same
--      photo doesn't create a second row.
--    - Reporting / lookup paths: per-rep productivity, per-clinic
--      capture counts, "find this order's photos", "find this
--      patient's photos", "find by tracking number".
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "package_photo_org_sha256_key"
    ON "package_photo" ("organizationId", "sha256");

CREATE INDEX "package_photo_org_capturedAt_idx"
    ON "package_photo" ("organizationId", "capturedAt");

CREATE INDEX "package_photo_org_externalOrderNumber_idx"
    ON "package_photo" ("organizationId", "pharmacyExternalOrderNumber");

CREATE INDEX "package_photo_org_matchedOrderId_idx"
    ON "package_photo" ("organizationId", "matchedOrderId");

CREATE INDEX "package_photo_org_matchedPatientId_idx"
    ON "package_photo" ("organizationId", "matchedPatientId");

CREATE INDEX "package_photo_org_capturedByUserId_capturedAt_idx"
    ON "package_photo" ("organizationId", "capturedByUserId", "capturedAt");

CREATE INDEX "package_photo_org_matched_idx"
    ON "package_photo" ("organizationId", "matched");

CREATE INDEX "package_photo_org_trackingNumber_idx"
    ON "package_photo" ("organizationId", "trackingNumber");

CREATE INDEX "package_photo_org_clinicId_capturedAt_idx"
    ON "package_photo" ("organizationId", "clinicId", "capturedAt");

CREATE INDEX "package_photo_org_siteId_capturedAt_idx"
    ON "package_photo" ("organizationId", "siteId", "capturedAt");

-- ---------------------------------------------------------------------
-- 4. Foreign keys.
--
--    All RESTRICT — the photo row is an audit anchor. An order,
--    user, clinic, site, workstation, command_log, or shipment
--    referenced by a photo cannot be deleted without first
--    archiving / shredding the photo row (which goes through a
--    follow-up command, not raw SQL).
-- ---------------------------------------------------------------------

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_capturedByUserId_fkey"
    FOREIGN KEY ("capturedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_capturedAtWorkstationId_fkey"
    FOREIGN KEY ("capturedAtWorkstationId") REFERENCES "workstation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_matchedOrderId_fkey"
    FOREIGN KEY ("matchedOrderId") REFERENCES "order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_matchedPatientId_fkey"
    FOREIGN KEY ("matchedPatientId") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_sourceShipmentId_fkey"
    FOREIGN KEY ("sourceShipmentId") REFERENCES "shipment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Grants for application roles. Mirrors the baseline RLS pattern.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "package_photo"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 6. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "package_photo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_photo" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 7. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'package_photo'
  ];
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ') '
      'WITH CHECK ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ');',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- 8. Sanity comment.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "package_photo" IS
  'Pre-shipment package-photo capture record. Append-only domain table written by CapturePackagePhoto. Photo bytes live in the storage adapter (S3); this row holds the (storageBucket, storageKey, sha256) pointer plus match + tracking metadata. (organizationId, sha256) is unique to dedupe rep retakes. notesEnc is envelope-encrypted because rep notes may carry incidental PHI.';
