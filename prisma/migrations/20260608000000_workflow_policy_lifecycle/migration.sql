-- =====================================================================
-- WORKFLOW POLICY LIFECYCLE
--
-- ADR-0017 (`docs/adr/0017-workflow-policy-migration.md`) refines the
-- WorkflowPolicy lifecycle to four states (DRAFT / ACTIVE / SUPERSEDED
-- / ARCHIVED) and establishes the grandfather rule: in-flight orders
-- complete under their born policy even after newer ACTIVE policies
-- exist.
--
-- This migration ships the schema delta that the ADR depends on:
--
--   1. Rename the existing `RETIRED` enum value to `SUPERSEDED`.
--      Zero-row semantics change (no policy has ever been retired in
--      production or in seed data; every seeded / bootstrapped policy
--      is created with `status = ACTIVE`).
--
--   2. Add `ARCHIVED` as a new enum value — the terminal state for a
--      policy that no in-flight orders reference.
--
--   3. Install the activation invariant — at most one ACTIVE row per
--      (organizationId, code) — as a partial unique index. Prisma's
--      schema language cannot express partial uniques; the constraint
--      lives here and is mirrored by `pickPolicyForCreate` in
--      `@pharmax/workflow`.
--
--   4. Annotate `retiredAt` with its post-lifecycle meaning: the
--      timestamp of the first ACTIVE → SUPERSEDED transition. The
--      column shape is unchanged.
--
-- RLS: `workflow_policy` already has FORCE ROW LEVEL SECURITY +
-- tenant_isolation policy from `20260522060000_rls_baseline`. This
-- migration only mutates the enum and adds a partial index; no new
-- tenant-scoped table is created, so no additional RLS DDL is needed
-- (the schema-rls linter walks CREATE TABLE statements, of which this
-- migration has zero).
--
-- Postgres version note: `ALTER TYPE ... ADD VALUE` is permitted
-- inside a transaction in Postgres 12+, provided the new value is not
-- referenced from the same transaction. We do not reference 'ARCHIVED'
-- anywhere in this file, so the migration runs cleanly under Prisma's
-- per-migration transaction wrapper. `ALTER TYPE ... RENAME VALUE`
-- has always been transaction-safe.
-- =====================================================================

-- 1. Rename RETIRED → SUPERSEDED.
ALTER TYPE "WorkflowPolicyStatus" RENAME VALUE 'RETIRED' TO 'SUPERSEDED';

-- 2. Add the new ARCHIVED value.
ALTER TYPE "WorkflowPolicyStatus" ADD VALUE 'ARCHIVED';

-- 3. Activation invariant — partial unique index.
--    The index is partial so SUPERSEDED / ARCHIVED rows of the same
--    (organizationId, code, version) family can coexist with the new
--    ACTIVE row (that is the whole point of versioning).
--
--    Activation flow (executed by an operator inside one tx):
--
--      UPDATE workflow_policy
--         SET status = 'SUPERSEDED', "retiredAt" = NOW()
--       WHERE "organizationId" = :org AND code = 'order.standard'
--         AND version = 1 AND status = 'ACTIVE';
--
--      UPDATE workflow_policy
--         SET status = 'ACTIVE', "publishedAt" = NOW()
--       WHERE "organizationId" = :org AND code = 'order.standard'
--         AND version = 2 AND status = 'DRAFT';
--
--    Forgetting the demote and only attempting the promote surfaces a
--    23505 unique violation rather than a silent two-ACTIVE state.
CREATE UNIQUE INDEX "workflow_policy_active_unique"
    ON "workflow_policy"("organizationId", "code")
    WHERE "status" = 'ACTIVE';

-- 4. Column comment — pinned semantics for `retiredAt`.
COMMENT ON COLUMN "workflow_policy"."retiredAt" IS
  'Timestamp set the first time this row LEAVES the ACTIVE state (the ACTIVE -> SUPERSEDED transition). Remains stable through a subsequent SUPERSEDED -> ARCHIVED transition. NULL for rows that have never been demoted. See ADR-0017.';
