-- Persist a screening gap's remediation as a column.
--
-- `order_screening_finding` has always known WHAT could not be
-- screened (`kind = 'SCREENING_GAP'`, plus a code per check). It did
-- not persist WHOSE PROBLEM that was: the engine computes a
-- remediation (SUBJECT_DATA / PLATFORM_CAPABILITY / ORGANIZATION_DATA
-- / RECORD_IMMUTABLE) at every gap emit site — it grades the gap with
-- it and words the reason from it — and then dropped it, leaving
-- readers to RECOVER it from the severity. That recovery works (the
-- console does it today) but it is lossy by design: three
-- remediations grade MINOR, so `gapRemediationFromSeverity` collapses
-- them and a per-code exception list patches the two codes where the
-- collapse would misdirect an operator.
--
-- The question that motivates the column is a reporting one: "what
-- fraction of orders could not be fully screened, and who can close
-- that — the pharmacist at the bench (SUBJECT_DATA), the org's
-- formulary team (ORGANIZATION_DATA), procurement/engineering
-- (PLATFORM_CAPABILITY), or nobody, prospectively (RECORD_IMMUTABLE)?"
-- With the column that is GROUP BY remediation. Without it, it is a
-- reimplementation of the recovery rules in every reporting query,
-- each free to drift from the console's.
--
-- TEXT, not an enum, for the reason `code`/`kind`/`severity` are TEXT
-- (see the 20260807 migration): the vocabulary is designed to grow —
-- ORGANIZATION_DATA and RECORD_IMMUTABLE were both appended within a
-- week of the original two — and a new remediation must not need a
-- schema migration on an append-only table.
--
-- NULLABLE, with the invariant "NULL exactly when the row is not a
-- gap". Only the forbidding direction is CHECK-constrained
-- (a clinical finding must not claim a remediation); the requiring
-- direction ("every gap carries one") is deliberately NOT, because
-- during a deploy window app tasks running the PREVIOUS build insert
-- gap rows without the column and a NOT-NULL-for-gaps CHECK would
-- refuse those inserts — failing PV1 screening closed for the length
-- of the rollout. A NULL gap row therefore means exactly "written by
-- a pre-column binary"; readers fall back to the severity recovery
-- for those rows, and reporting reads them as legacy.

-- ---------------------------------------------------------------------
-- 1. Column.
-- ---------------------------------------------------------------------

ALTER TABLE "order_screening_finding" ADD COLUMN "remediation" TEXT;

COMMENT ON COLUMN "order_screening_finding"."remediation" IS
  'Who can close a SCREENING_GAP (ScreeningGapRemediation vocabulary: SUBJECT_DATA, PLATFORM_CAPABILITY, ORGANIZATION_DATA, RECORD_IMMUTABLE; growing TEXT vocabulary like code). NULL on clinical findings (enforced by CHECK) and on gap rows written by pre-column binaries, which readers resolve by severity recovery. Stated by the engine emit site at write time; not part of the fingerprint.';

-- ---------------------------------------------------------------------
-- 2. Backfill.
--
--    Exactly the recovery every reader applied until now, frozen at
--    the moment the column takes over — code-consulted-first
--    (`gapRemediationForFindingCode`), severity-second
--    (`gapRemediationFromSeverity`):
--
--      - The compound-coverage codes were minted to carry exactly
--        ORGANIZATION_DATA, and SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED
--        exactly PLATFORM_CAPABILITY; the code decides.
--      - Otherwise the severity decides: MODERATE gaps have only ever
--        meant SUBJECT_DATA, and MINOR maps to PLATFORM_CAPABILITY —
--        the value every MINOR gap row actually carried when the only
--        two remediations existed. RECORD_IMMUTABLE rows written
--        since structured sig (also MINOR, code
--        SCR_DOSE_INPUT_UNAVAILABLE) backfill as PLATFORM_CAPABILITY,
--        the same documented collapse those rows read as before this
--        column existed: the operator instruction — "nobody touching
--        this order can close this" — is unchanged, and the persisted
--        `reason` carries the precise sentence. Rewriting history
--        more precisely than any reader ever saw it would make the
--        backfilled rows claim a distinction the code that wrote them
--        did not make.
--
--    Runs as the migration role, which is not subject to the
--    app-role REVOKE and (like the 20260522 audit_log backfill on the
--    same posture) not blocked by FORCE RLS.
-- ---------------------------------------------------------------------

UPDATE "order_screening_finding"
SET "remediation" = CASE
  WHEN "code" IN ('SCR_COMPOUND_FORMULA_NOT_CODED', 'SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED')
    THEN 'ORGANIZATION_DATA'
  WHEN "code" = 'SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED'
    THEN 'PLATFORM_CAPABILITY'
  WHEN "severity" = 'MODERATE'
    THEN 'SUBJECT_DATA'
  WHEN "severity" = 'MINOR'
    THEN 'PLATFORM_CAPABILITY'
END
WHERE "kind" = 'SCREENING_GAP';

-- A gap the rules above could not grade would mean a row this build
-- cannot interpret (a gap severity outside MINOR/MODERATE, which
-- `screeningGapSeverity` cannot produce). Refuse loudly rather than
-- leave it looking like a deploy-window row.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "order_screening_finding"
    WHERE "kind" = 'SCREENING_GAP' AND "remediation" IS NULL
  ) THEN
    RAISE EXCEPTION
      'order_screening_finding backfill incomplete: SCREENING_GAP rows with an unrecognized severity exist; inspect before migrating';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. The forbidding-direction CHECK.
--
--    A clinical finding carrying a remediation would let a coverage
--    query that trusts the column (GROUP BY remediation, no kind
--    filter) count a real clinical alert as a coverage note. The
--    requiring direction is intentionally absent — see the header.
-- ---------------------------------------------------------------------

ALTER TABLE "order_screening_finding"
    ADD CONSTRAINT "order_screening_finding_remediation_gap_only"
    CHECK ("remediation" IS NULL OR "kind" = 'SCREENING_GAP');

-- ---------------------------------------------------------------------
-- 4. Coverage-reporting index.
-- ---------------------------------------------------------------------

CREATE INDEX "order_screening_finding_organizationId_remediation_occurred_idx"
    ON "order_screening_finding"("organizationId", "remediation", "occurredAt");
