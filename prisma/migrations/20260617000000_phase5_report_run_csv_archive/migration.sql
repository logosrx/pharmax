-- migration: 20260617000000_phase5_report_run_csv_archive
--
-- Adds CSV-archive columns to `report_run` so scheduled reports
-- can store their result set in S3 + be downloaded later from
-- the operator console / linked from the run-completion email.
--
-- Without this, the only way to "re-download" a historical
-- scheduled run is to re-execute the report — which works for
-- the deterministic date-range reports we ship today, but breaks
-- as soon as a report's underlying data is non-stable (e.g. a
-- patient gets shredded, an order is corrected after-the-fact,
-- a lot is closed). SOC-2 wants the EXACT bytes the operator
-- received last quarter; re-running and getting a slightly
-- different answer is the wrong evidence shape.
--
-- Column rationale:
--   - `csvObjectBucket` / `csvObjectKey` — the S3 location of
--     the persisted CSV. Bucket is stored alongside the key so
--     the download path can authoritatively call `getObject`
--     even after the operator changes `REPORT_ARCHIVE_S3_BUCKET`
--     env (the old objects stay reachable). Pair is null when
--     the run was on-demand (operator streamed CSV in-browser;
--     no need to persist a copy) OR when the archive wasn't
--     configured at run time (dev environments without S3).
--   - `csvSizeBytes` — denormalized so the history UI can show
--     "Download (2.3 MB)" without a HEAD against S3.
--   - `csvSha256Hex` — integrity. The S3 PutObject call passes
--     `ChecksumSHA256` so AWS validates the bytes on upload;
--     persisting the hash here lets the download route ALSO
--     validate after `getObject` returns — guards against a
--     bucket policy change or KMS-key rotation that quietly
--     corrupts the body. Stored hex (64 chars) for readability.
--   - `csvPersistedAt` — when the put completed. Distinct from
--     `generatedAt` (when the report runner produced the rows);
--     a slow S3 upload after a fast report run would skew the
--     "how long did this take" metric if we re-used one column.
--
-- Backfill strategy: historical rows get NULL across the board.
-- The download route surfaces a friendly "not archived" page
-- when the operator clicks an older row.

ALTER TABLE "report_run"
  ADD COLUMN "csvObjectBucket" TEXT,
  ADD COLUMN "csvObjectKey"    TEXT,
  ADD COLUMN "csvSizeBytes"    INTEGER,
  ADD COLUMN "csvSha256Hex"    VARCHAR(64),
  ADD COLUMN "csvPersistedAt"  TIMESTAMP(3);

-- A partial index makes the admin "show me runs with downloadable
-- CSVs" query cheap. The history pages can switch to it via a
-- `WHERE "csvObjectKey" IS NOT NULL` filter.
CREATE INDEX "report_run_with_csv_idx"
  ON "report_run"("organizationId", "generatedAt" DESC)
  WHERE "csvObjectKey" IS NOT NULL;
