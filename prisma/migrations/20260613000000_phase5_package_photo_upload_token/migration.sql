-- migration: 20260613000000_phase5_package_photo_upload_token
--
-- Token table for the two-step package-photo upload flow.
--
-- Why a table:
--
--   The `PackagePhotoStorage` port's `resolveUploadToken(token)`
--   contract takes ONLY the opaque token — the caller does not
--   know the storage bucket or key. The in-memory dev adapter
--   holds these tuples in a process-local Map; the production S3
--   adapter cannot, because:
--
--     - The web tier is multi-instance. An upload routed to
--       instance A and a dispatch routed to instance B would
--       fail to find the token in A's local Map.
--     - A redeploy drops every in-flight upload.
--     - An attacker who guesses a UUID-shaped token shouldn't be
--       able to redeem it as a different tenant; the token row
--       is the org binding the adapter cross-checks.
--
--   A Postgres row keyed on `(token)` gives us:
--
--     - Multi-instance correctness (Postgres is the shared
--       backplane; the adapter doesn't care which node served
--       the upload vs. the dispatch).
--     - Crash-safe durability across redeploys.
--     - RLS-enforced tenant isolation (a cross-tenant guess
--       collapses to "row not found" rather than leaking
--       metadata, matching the in-memory adapter's behavior).
--     - A clean TTL story (`expiresAt`) for the janitor that
--       will sweep stale tokens + orphan S3 objects in a
--       follow-up.
--
-- Lifecycle:
--
--   1. Rep uploads photo bytes via POST /package-photos/uploads.
--      The route writes the bytes to S3 (SSE-KMS) and inserts
--      THIS row with `expiresAt = now + 1 hour`. The token
--      returned to the client is the row's `token` column.
--
--   2. Rep dispatches CapturePackagePhoto with the token. The
--      command's handler calls `resolveUploadToken(token)` which
--      reads THIS row, verifies it hasn't expired, and returns
--      the storage tuple. The command writes a `package_photo`
--      row pointing at the same S3 key.
--
--   3. The token row is NOT deleted on success today. A future
--      janitor command sweeps rows where `expiresAt < now()` and
--      deletes both the row and the orphan S3 object (because a
--      successful capture means the photo row already owns the
--      S3 key; orphan objects come from uploads that were never
--      dispatched). Keeping the row through the photo's lifetime
--      simplifies audit ("did this photo's upload originate from
--      a valid token?") with no security cost — the row is
--      org-scoped and RLS-bound.
--
-- PHI rule:
--
--   - No PHI fields. The row holds storage metadata + the
--     org/site/clinic/user context that captured the upload.
--     Operator notes (PHI-possible) live on `package_photo`,
--     not here.
--
-- RLS shape mirrors the baseline: ENABLE + FORCE + one
-- PERMISSIVE `tenant_isolation` policy keyed on the standard
-- `pharmax.system_context` / `pharmax.organization_id` GUC pair.

-- ---------------------------------------------------------------------
-- 1. Table.
-- ---------------------------------------------------------------------

CREATE TABLE "package_photo_upload_token" (
    -- Opaque UUID v4 returned to the client. PK is the lookup
    -- path; no composite key needed.
    "token" UUID NOT NULL,

    -- Tenancy. The adapter's resolveUploadToken returns this so
    -- the command can cross-check against the active tenancy
    -- (defense-in-depth against a leaked token redeemed by a
    -- different org — same code path the in-memory adapter uses).
    "organizationId" UUID NOT NULL,

    -- Optional capture-context echo, preserved for the janitor +
    -- audit. Not strictly required by the adapter (the
    -- `package_photo` row is the audit anchor once a photo is
    -- captured), but cheap to carry and useful for orphan-sweep
    -- forensics ("which user/site/workstation uploaded this and
    -- never dispatched?").
    "uploadedByUserId" UUID NOT NULL,
    "siteId" UUID,
    "clinicId" UUID,

    -- Storage pointer. The adapter returns (bucket, key) to the
    -- command verbatim; the command writes them on the
    -- `package_photo` row.
    "storageBucket" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,

    -- Pre-computed by the adapter at upload time so the command
    -- can rely on this without re-reading the S3 object.
    "sha256" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,

    -- TTL. The adapter rejects expired tokens at
    -- resolveUploadToken time. The janitor sweeps rows + orphan
    -- S3 objects where expiresAt < now().
    "expiresAt" TIMESTAMP(3) NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_photo_upload_token_pkey" PRIMARY KEY ("token")
);

-- ---------------------------------------------------------------------
-- 2. Indexes.
--
--    The PK on (token) handles the adapter's hot path.
--    Indexes here are for the janitor (sweep by expiresAt) and
--    for forensic queries (find a user's uploads, find an org's
--    uploads in a window).
-- ---------------------------------------------------------------------

CREATE INDEX "package_photo_upload_token_expiresAt_idx"
    ON "package_photo_upload_token" ("expiresAt");

CREATE INDEX "package_photo_upload_token_org_createdAt_idx"
    ON "package_photo_upload_token" ("organizationId", "createdAt");

CREATE INDEX "package_photo_upload_token_org_uploadedByUserId_idx"
    ON "package_photo_upload_token" ("organizationId", "uploadedByUserId");

-- ---------------------------------------------------------------------
-- 3. Foreign keys.
--
--    All RESTRICT — same audit-anchor reasoning as
--    `package_photo`. A user who uploaded a photo cannot be
--    deleted while their upload tokens exist; the janitor must
--    sweep first.
-- ---------------------------------------------------------------------

ALTER TABLE "package_photo_upload_token"
    ADD CONSTRAINT "package_photo_upload_token_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo_upload_token"
    ADD CONSTRAINT "package_photo_upload_token_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo_upload_token"
    ADD CONSTRAINT "package_photo_upload_token_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "package_photo_upload_token"
    ADD CONSTRAINT "package_photo_upload_token_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants for application roles. Mirrors the baseline.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "package_photo_upload_token"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "package_photo_upload_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_photo_upload_token" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 6. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'package_photo_upload_token'
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
-- 7. Sanity comment.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "package_photo_upload_token" IS
  'Two-step package-photo upload token. The S3 adapter writes a row here at upload time so resolveUploadToken(token) can recover (bucket, key, sha256, fileSize, contentType, organizationId) at command-dispatch time. Multi-instance safe (Postgres-backed instead of in-memory map). TTL enforced via expiresAt + janitor sweep.';
