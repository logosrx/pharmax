-- migration: 20260525000000_phase2_verification_record
--
-- Adds the VerificationRecord domain-record table and its
-- VerificationStage + VerificationDecision enums. Lands the
-- structured-record half of the two-pharmacist-check rule (the
-- workflow-state half already exists in @pharmax/workflow's
-- policy v1 — APPROVE_PV1 / REJECT_PV1 / APPROVE_FINAL /
-- REJECT_FINAL transitions). This is the FIRST table written by
-- a workflow command alongside a state transition.
--
-- Why one table for BOTH stages (PV1 and FINAL):
--
--   PV1 and Final are the same shape (pharmacist + decision +
--   policy stamp + command log + occurredAt). They differ in
--   WHO can do them (PV1 by any pharmacist, Final by any
--   pharmacist EXCEPT the PV1 actor — enforced by SoD at the
--   command-handler layer, not the row layer). Splitting the
--   table buys nothing and complicates reporting ("rejection
--   rate by pharmacist, across all stages" becomes a UNION).
--   A single table with a `stage` enum keeps reads cheap and
--   the join graph shallow.
--
-- Why this is IMMUTABLE (no UPDATE, no DELETE):
--
--   The historical fact "Pharmacist Alice approved PV1 on
--   order X at 14:32 under policy v1" cannot change after the
--   fact. Corrections are NEW rows from a later workflow loop
--   (Reject → Reopen → re-approve). The immutability is
--   enforced TWO ways for defense in depth, mirroring the
--   `audit_log` pattern:
--
--     1. GRANT only SELECT + INSERT to `pharmax_app` and
--        `pharmax_system`. UPDATE and DELETE are not granted.
--     2. RLS policies cover ONLY `FOR SELECT` and `FOR INSERT`.
--        RLS denies any DML it doesn't have a permissive policy
--        for, so UPDATE/DELETE are denied at the RLS layer too.
--     3. Explicit `REVOKE UPDATE, DELETE` against both app
--        roles. A future regression to "allow updates on
--        verification_record" would have to remove all three
--        controls.
--
-- Multiplicity:
--
--   Multiple rows per (orderId, stage) are EXPECTED. An order
--   can have:
--     - PV1 row #1: REJECTED (typist made an error)
--     - PV1 row #2: APPROVED (after re-typing)
--     - FINAL row #1: APPROVED
--   So no `(orderId, stage)` unique constraint. The state
--   machine prevents a second APPROVED row from landing while
--   the order is in PV1_APPROVED_READY_FOR_FILL (the next
--   ApprovePV1 invocation hits WORKFLOW_INVALID_TRANSITION
--   before ever reaching the INSERT). The unique constraint is
--   not the safety mechanism here; the workflow engine is.
--
-- RLS shape mirrors the baseline + the cancellation/hold
-- migrations: ENABLE + FORCE + tenant_isolation policies on the
-- standard `pharmax.system_context` / `pharmax.organization_id`
-- GUC pair. The migration linter `scripts/check-migration-rls.ts`
-- enforces that this section exists.

-- ---------------------------------------------------------------------
-- 1. New enums: VerificationStage + VerificationDecision
-- ---------------------------------------------------------------------

CREATE TYPE "VerificationStage" AS ENUM (
    'PV1',
    'FINAL'
);

CREATE TYPE "VerificationDecision" AS ENUM (
    'APPROVED',
    'REJECTED'
);

-- ---------------------------------------------------------------------
-- 2. New table: verification_record
--
--    PHI-free by design. Pharmacist notes (if/when added in a
--    follow-up phase) will live in a separate encrypted column;
--    the v1 columns are all non-PHI metadata.
-- ---------------------------------------------------------------------

CREATE TABLE "verification_record" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "stage" "VerificationStage" NOT NULL,
    "decision" "VerificationDecision" NOT NULL,
    "pharmacistUserId" UUID NOT NULL,
    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,
    "rejectionReasonCode" TEXT,
    "commandLogId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_record_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
--
--    - (orderId, stage, occurredAt) — the order-timeline read path.
--      "Show PV1 history for this order in chronological order."
--    - (pharmacistUserId, occurredAt) — productivity reports.
--      "What did this pharmacist verify today?"
--    - (stage, decision, occurredAt) — operational reports.
--      "What's our PV1 rejection rate this week?"
--
--    All indexes are organizationId-prefixed so tenancy is the
--    first column and Postgres can serve tenant-scoped queries
--    from a single btree slice.
-- ---------------------------------------------------------------------

CREATE INDEX "verification_record_organizationId_orderId_stage_occurredAt_idx"
    ON "verification_record"("organizationId", "orderId", "stage", "occurredAt");
CREATE INDEX "verification_record_organizationId_pharmacistUserId_occurredAt_idx"
    ON "verification_record"("organizationId", "pharmacistUserId", "occurredAt");
CREATE INDEX "verification_record_organizationId_stage_decision_occurredAt_idx"
    ON "verification_record"("organizationId", "stage", "decision", "occurredAt");

-- ---------------------------------------------------------------------
-- 4. Sanity check: REJECTED rows MUST carry a reason code; APPROVED
--    rows MUST NOT (a stray reason code on an APPROVED row would
--    confuse reports). Enforced at the DB layer because the rule is
--    a workflow-safety invariant — workflow-safety.mdc, "Every
--    rejection requires a reason code".
-- ---------------------------------------------------------------------

ALTER TABLE "verification_record"
    ADD CONSTRAINT "verification_record_rejection_reason_required"
    CHECK (
        ("decision" = 'REJECTED' AND "rejectionReasonCode" IS NOT NULL)
        OR
        ("decision" = 'APPROVED' AND "rejectionReasonCode" IS NULL)
    );

-- ---------------------------------------------------------------------
-- 5. Foreign keys.
--
--    All RESTRICT. An order, user, workflow policy, or command log
--    referenced by a verification record cannot be deleted out from
--    under the audit trail.
-- ---------------------------------------------------------------------

ALTER TABLE "verification_record" ADD CONSTRAINT "verification_record_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_record" ADD CONSTRAINT "verification_record_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_record" ADD CONSTRAINT "verification_record_pharmacistUserId_fkey"
    FOREIGN KEY ("pharmacistUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_record" ADD CONSTRAINT "verification_record_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_record" ADD CONSTRAINT "verification_record_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 6. Grants for application roles.
--
--    APPEND-ONLY: SELECT + INSERT only. UPDATE and DELETE are NOT
--    granted, and additionally REVOKED for defense in depth (a
--    future "GRANT ALL" regression must explicitly re-grant
--    UPDATE/DELETE rather than silently inheriting them).
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON TABLE "verification_record" TO pharmax_app, pharmax_system;
REVOKE UPDATE, DELETE ON TABLE "verification_record" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 7. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "verification_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_record" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 8. Tenant isolation policies.
--
--    TWO separate policies (FOR SELECT and FOR INSERT) instead of
--    the single FOR ALL policy used on most other tables. The
--    absence of FOR UPDATE / FOR DELETE policies means RLS denies
--    those DML actions even if a future grant accidentally allows
--    them — exactly the same posture as `audit_log`.
-- ---------------------------------------------------------------------

CREATE POLICY tenant_isolation_select ON "verification_record"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "verification_record"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 9. Sanity comment.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "verification_record" IS
  'Immutable, append-only record of a pharmacist verification act (PV1 or Final, Approval or Rejection). One row per Approve* / Reject* command invocation. Multiple rows per (orderId, stage) are expected across rework loops; the workflow engine prevents double-approval at the state level. APPEND-ONLY by grant (SELECT + INSERT only), RLS (no UPDATE/DELETE policies), and explicit REVOKE — same posture as audit_log.';
