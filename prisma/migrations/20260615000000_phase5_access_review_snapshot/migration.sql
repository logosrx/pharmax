-- migration: 20260615000000_phase5_access_review_snapshot
--
-- SOC 2 access-review snapshots (CC6.2 evidence).
--
-- Each row is a point-in-time JSON snapshot of every (user → role
-- → scope → permission) assignment in one organization. Generated
-- by `RecordAccessReviewSnapshot` (SystemCommand) which is called
-- from `scripts/security/run-access-review.ts` after
-- `@pharmax/security::generateAccessReview` produces the report.
--
-- Why a dedicated table (vs. only the JSON-on-disk evidence file):
--   - SOC 2 auditors want to confirm the snapshot in the evidence
--     pack is THE snapshot that was generated — not a re-run that
--     happens to match. Persisting in the DB the access rights
--     live in lets verifiers follow snapshot → command_log →
--     audit_log → event_outbox to confirm provenance.
--   - `digestSha256` is the SHA-256 of the canonical (sorted-key)
--     JSON serialization. Stored in a column AND emitted on the
--     outbox event, so "did the file on disk match the row?" is a
--     one-column comparison.
--   - Denormalized summary scalars (totalPrincipals,
--     elevatedPrincipalCount, …) let auditors filter without
--     parsing JSONB.
--
-- Storage shape:
--   - `report`                    JSONB, full AccessReviewReport.
--                                 IMMUTABLE — never updated; new
--                                 snapshots go in new rows. Updating
--                                 in place would invalidate the
--                                 digest and tamper-evidence claim.
--   - `digestSha256`              hex SHA-256 of canonical JSON.
--                                 Searchable + comparable.
--   - `reportVersion`             schema version of the persisted
--                                 `report`. Increment when the JSON
--                                 shape changes incompatibly so
--                                 verifiers can branch on the version.
--   - `organizationSlug`          stable slug copied at generation
--                                 time so a later org rename does
--                                 not retroactively alter the
--                                 historical evidence label.
--   - `recordedByUserId`          operator who ran the CLI (nullable
--                                 — a future scheduled worker runs
--                                 as a system identity).
--   - `commandLogId`              FK into command_log; the audit-
--                                 chain hop snapshot → command →
--                                 audit_log → event_outbox is what
--                                 a SOC 2 reviewer follows.
--
-- Indexes optimized for:
--   - "show me my org's recent snapshots" — (organizationId, generatedAt DESC)
--   - "what snapshot covered Q3-2026?" — (organizationId, periodEnd DESC)
--
-- RLS: standard tenant_isolation policy keyed on the existing
-- pharmax.system_context / pharmax.organization_id GUC pair.
-- The SystemCommand that writes here dispatches from system context
-- (CLI / worker), so the policy's system-context branch is the
-- write path; the per-tenant branch enforces isolation when an
-- OrgAdmin reads their own org's snapshots from the operator
-- console.

CREATE TABLE "access_review_snapshot" (
    "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"              UUID         NOT NULL,
    "organizationSlug"            TEXT         NOT NULL,
    "periodStart"                 TIMESTAMP(3) NOT NULL,
    "periodEnd"                   TIMESTAMP(3) NOT NULL,
    "generatedAt"                 TIMESTAMP(3) NOT NULL,
    "totalPrincipals"             INTEGER      NOT NULL,
    "elevatedPrincipalCount"      INTEGER      NOT NULL,
    "inactivePrincipalCount"      INTEGER      NOT NULL,
    "staleAssignmentCount"        INTEGER      NOT NULL,
    "cryptoShredCapableRoleCount" INTEGER      NOT NULL,
    "report"                      JSONB        NOT NULL,
    "digestSha256"                TEXT         NOT NULL,
    "reportVersion"               INTEGER      NOT NULL DEFAULT 1,
    "recordedByUserId"            UUID,
    "commandLogId"                UUID         NOT NULL,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_review_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_review_snapshot_org_generated_idx"
    ON "access_review_snapshot"("organizationId", "generatedAt" DESC);
CREATE INDEX "access_review_snapshot_org_period_idx"
    ON "access_review_snapshot"("organizationId", "periodEnd" DESC);

ALTER TABLE "access_review_snapshot"
    ADD CONSTRAINT "access_review_snapshot_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "access_review_snapshot"
    ADD CONSTRAINT "access_review_snapshot_recordedByUserId_fkey"
    FOREIGN KEY ("recordedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "access_review_snapshot"
    ADD CONSTRAINT "access_review_snapshot_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT;

ALTER TABLE "access_review_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_review_snapshot" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "access_review_snapshot"
    USING (
        current_setting('pharmax.system_context', true) = 'true'
        OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'true'
        OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
    );
