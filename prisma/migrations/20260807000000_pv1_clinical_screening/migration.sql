-- PV1 clinical screening: what the engine said, and who took
-- responsibility for it.
--
-- `@pharmax/clinical-screening` computes drug-interaction,
-- allergy, duplication and dose findings as a pure function. Pure
-- functions leave no trace, and a screen that leaves no trace cannot
-- answer the only question that matters after an adverse event: what
-- was the pharmacist actually shown before they signed, and what did
-- they say about it? These two tables are that record.
--
-- Why the findings are persisted rather than recomputed on demand.
-- Recomputation is not reproduction. The patient's profile moves, the
-- prescription is edited, and — the case that makes this decisive —
-- the licensed drug-knowledge source behind `DrugKnowledgeSource` is
-- updated by its vendor on a schedule nobody here controls. Re-running
-- the engine in 2029 against 2029 knowledge answers a different
-- question than the one the pharmacist answered in 2026. So the
-- findings are written down, with the workflow policy version and the
-- reporting floor that governed them.
--
-- Why acknowledgements are per (order, pharmacist, fingerprint).
-- ApprovePV1 refuses unless every finding that requires an
-- acknowledgement carries one FROM THE PHARMACIST WHO IS SIGNING. An
-- acknowledgement is a professional judgement attached to a person; if
-- one pharmacist's judgement could satisfy another's approval, the
-- alert stops being a decision and becomes a checkbox that someone
-- else already ticked. The unique constraint below makes the identity
-- of that judgement structural.
--
-- PHI. Neither table stores a patient identifier, a drug name, or any
-- string a human typed. The screening engine is built so a finding is
-- safe to persist verbatim: substances appear only as the opaque codes
-- the caller passed in, and `reason` is templated FROM those codes by
-- the engine itself (see the PHI INVARIANT header in
-- `packages/clinical-screening/src/findings.ts`). `triggers` holds the
-- prescription ids that set the finding off, which is the same class
-- of identifier `order_event` already carries. A pharmacist's free-text
-- note is deliberately NOT capturable here — if one is ever added it
-- belongs in an encrypted column, not in this row.
--
-- Both tables are APPEND-ONLY at the grant + RLS layer, the same
-- posture as `verification_record` and `audit_log`: SELECT + INSERT
-- granted, UPDATE/DELETE revoked, and no RLS policy for UPDATE or
-- DELETE so the DML is denied even if a future grant re-opens it.
-- Editing what the engine said, after the fact, would defeat the
-- reason for writing it down. Because of that posture the policies are
-- split per-command (`tenant_isolation_select` /
-- `tenant_isolation_insert`) rather than a single FOR ALL
-- `tenant_isolation`; the isolation predicate is identical to every
-- other tenant table's.

-- ---------------------------------------------------------------------
-- 1. Screening phase.
--
--    A PV1 review is not instantaneous. StartPV1 screens so the
--    console has something to render; ApprovePV1 screens AGAIN and
--    gates on that second result, because the profile can gain a
--    medication between the two and the gap is exactly where a new
--    interaction appears. Keeping both phases means the pair of rows
--    is itself the evidence of whether anything moved.
-- ---------------------------------------------------------------------

CREATE TYPE "ScreeningPhase" AS ENUM (
    'PV1_START',
    'PV1_APPROVE'
);

-- ---------------------------------------------------------------------
-- 2. order_screening_finding
--
--    The vocabulary columns (code, kind, severity, certainty) are TEXT
--    rather than DB enums, for the reason `verification_record`
--    keeps `rejectionReasonCode` as TEXT: the finding-code list is
--    designed to grow (a code may be ADDED, never renamed or
--    repurposed), and adding a screening check should not require a
--    schema migration in a table that is already append-only.
--
--    `disposition` is the exception and is CHECK-constrained below.
--    It is not vocabulary — it is the workflow contract that
--    ApprovePV1 gates on, and a typo'd value there would silently
--    fail open.
-- ---------------------------------------------------------------------

CREATE TABLE "order_screening_finding" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "phase" "ScreeningPhase" NOT NULL,

    -- The pharmacist this screen was computed FOR. Findings are
    -- downgraded against that pharmacist's own acknowledgements, so a
    -- row is only meaningful alongside the person it was produced for.
    "screenedForUserId" UUID NOT NULL,

    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "certainty" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,

    -- Stable identity of the clinical situation, computed by
    -- `fingerprintOf`. Acknowledgements match on this and nothing
    -- else, which is safe only because the fingerprint carries the
    -- grading and every varying value in `reason`.
    "fingerprint" TEXT NOT NULL,

    "reason" TEXT NOT NULL,
    "triggers" JSONB NOT NULL,
    "citation" TEXT,

    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,
    -- The screening floor in force. Bound to the workflow policy
    -- VERSION rather than to tenant configuration, so raising it (and
    -- silencing a whole tier of findings) is a versioned, reviewed act
    -- — and so this row records which setting applied without a join.
    "minimumReportedSeverity" TEXT NOT NULL,

    "commandLogId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_screening_finding_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_screening_finding"
    ADD CONSTRAINT "order_screening_finding_disposition_known"
    CHECK ("disposition" IN ('HARD_STOP', 'REQUIRES_ACKNOWLEDGEMENT', 'INFORMATIONAL'));

CREATE INDEX "order_screening_finding_organizationId_orderId_phase_occurr_idx"
    ON "order_screening_finding"("organizationId", "orderId", "phase", "occurredAt");
CREATE INDEX "order_screening_finding_organizationId_code_severity_occurr_idx"
    ON "order_screening_finding"("organizationId", "code", "severity", "occurredAt");

ALTER TABLE "order_screening_finding" ADD CONSTRAINT "order_screening_finding_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_finding" ADD CONSTRAINT "order_screening_finding_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_finding" ADD CONSTRAINT "order_screening_finding_screenedForUserId_fkey"
    FOREIGN KEY ("screenedForUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_finding" ADD CONSTRAINT "order_screening_finding_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_finding" ADD CONSTRAINT "order_screening_finding_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 3. order_screening_acknowledgement
--
--    The unique constraint is the load-bearing line in this file. It
--    is what makes "one judgement, one person, one situation" a
--    property of the database rather than of whichever handler last
--    remembered to check. A retry of the acknowledge command lands on
--    it; so does a double-click.
--
--    Note what the key does NOT contain: the phase. An acknowledgement
--    given while reviewing (PV1_START) settles the same fingerprint at
--    approval, which is the point — the pharmacist dispositioned the
--    situation, not the moment. If the situation changes, the
--    fingerprint changes with it and the acknowledgement no longer
--    matches.
-- ---------------------------------------------------------------------

CREATE TABLE "order_screening_acknowledgement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,

    "fingerprint" TEXT NOT NULL,
    -- Copied from the persisted finding, never taken from the caller:
    -- an acknowledgement must not be able to claim a grading the
    -- engine did not produce.
    "findingCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "certainty" TEXT NOT NULL,

    "pharmacistUserId" UUID NOT NULL,

    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,

    "commandLogId" UUID NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_screening_acknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_screening_acknowledgement_organizationId_orderId_phar_key"
    ON "order_screening_acknowledgement"("organizationId", "orderId", "pharmacistUserId", "fingerprint");

CREATE INDEX "order_screening_acknowledgement_organizationId_orderId_phar_idx"
    ON "order_screening_acknowledgement"("organizationId", "orderId", "pharmacistUserId");
CREATE INDEX "order_screening_acknowledgement_organizationId_pharmacistUs_idx"
    ON "order_screening_acknowledgement"("organizationId", "pharmacistUserId", "acknowledgedAt");

ALTER TABLE "order_screening_acknowledgement" ADD CONSTRAINT "order_screening_acknowledgement_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_acknowledgement" ADD CONSTRAINT "order_screening_acknowledgement_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_acknowledgement" ADD CONSTRAINT "order_screening_acknowledgement_pharmacistUserId_fkey"
    FOREIGN KEY ("pharmacistUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_acknowledgement" ADD CONSTRAINT "order_screening_acknowledgement_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_screening_acknowledgement" ADD CONSTRAINT "order_screening_acknowledgement_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants — append-only, same posture as verification_record.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON TABLE "order_screening_finding" TO pharmax_app, pharmax_system;
REVOKE UPDATE, DELETE ON TABLE "order_screening_finding" FROM pharmax_app, pharmax_system;

GRANT SELECT, INSERT ON TABLE "order_screening_acknowledgement" TO pharmax_app, pharmax_system;
REVOKE UPDATE, DELETE ON TABLE "order_screening_acknowledgement" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Row-level security: enabled AND forced on both tables.
-- ---------------------------------------------------------------------

ALTER TABLE "order_screening_finding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_screening_finding" FORCE  ROW LEVEL SECURITY;

ALTER TABLE "order_screening_acknowledgement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_screening_acknowledgement" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "order_screening_finding"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "order_screening_finding"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_select ON "order_screening_acknowledgement"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "order_screening_acknowledgement"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 6. Table comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "order_screening_finding" IS
  'Immutable record of one clinical-screening finding produced during a PV1 screening pass (StartPV1 snapshot, or the ApprovePV1 re-screen the approval was gated on). Stores codes and opaque record ids only — no patient identifier, no drug name, no human-typed text. Stamped with the workflow policy version and the reporting floor in force so a screen stays reproducible after the knowledge source has moved on. Append-only by grant, RLS and explicit REVOKE.';

COMMENT ON TABLE "order_screening_acknowledgement" IS
  'A pharmacist''s recorded judgement on one screening finding, keyed by (organization, order, pharmacist, fingerprint). ApprovePV1 refuses unless every finding requiring acknowledgement carries one from the pharmacist who is signing — a colleague''s judgement does not satisfy it. Append-only by grant, RLS and explicit REVOKE.';
