-- =====================================================================
-- WORKFLOW POLICY OVERLAY (Tier 2 — per-tenant extension surface)
--
-- Implements the storage shape from ADR-0019 §"Storage shape sketch":
-- per-tenant declarative overrides layered onto a specific
-- WorkflowPolicy row. Tier-2 wiring activated by a follow-up slice
-- (`packages/command-bus/src/define-command.ts` + `loadOverlaysForPolicy`).
--
-- What this migration ships:
--
--   1. The `WorkflowPolicyOverlayStatus` enum (DRAFT / ACTIVE /
--      SUPERSEDED / ARCHIVED). Mirrors WorkflowPolicyStatus so the
--      same lifecycle rules apply (only one ACTIVE per scope at a
--      time; SUPERSEDED rows remain readable for forensics).
--
--   2. The `workflow_policy_overlay` table, FK-bound to
--      organization, clinic (nullable), workflow_policy, and user.
--      RESTRICT on every FK because:
--        - organization deletion must be a deliberate purge.
--        - clinic deletion must explicitly archive overlays first.
--        - workflow_policy rows are immutable lineage; an overlay
--          cites a specific (id, version) and must not detach.
--        - the createdByUser audit link must survive employee
--          turnover (we tombstone, never delete users).
--
--   3. The activation invariant — at most one ACTIVE overlay per
--      (organizationId, COALESCE(clinicId, all-zeros),
--      workflowPolicyId) — as a partial unique index. The COALESCE
--      collapses the "no clinic" case to a fixed sentinel UUID so
--      the partial unique CAN match NULL clinicIds (Postgres
--      otherwise treats NULL as not-equal-to-NULL in unique
--      indexes). Same pattern used by `workflow_policy_active_unique`
--      from `20260608000000_workflow_policy_lifecycle`.
--
--   4. RLS: enable + force ROW LEVEL SECURITY plus the standard
--      `tenant_isolation` policy that gates SELECT/INSERT/UPDATE/
--      DELETE by `current_setting('pharmax.organization_id')`. The
--      bus reads overlays inside a tenant tx so RLS is the
--      load-bearing isolation control: a misconfigured row that
--      somehow lands with the wrong organizationId still cannot
--      leak across tenants because the SELECT filter rejects it.
--
-- ADR/safety references:
--   - ADR-0019  (this surface; tighten-only invariant, snapshot
--                semantic, scope composition rules).
--   - ADR-0017  (workflow policy lifecycle; the grandfather rule
--                that overlays inherit because they cite a
--                specific `workflowPolicyId` row).
--   - ADR-0007  (twenty-step command-bus contract; overlay load
--                lands inside the tx, after the row lock, before
--                state validation).
--   - .cursor/rules/02-security-compliance.mdc — every tenant
--     table must carry organizationId AND be RLS-protected.
-- =====================================================================

-- 1. Enum.
CREATE TYPE "WorkflowPolicyOverlayStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- 2. Table.
CREATE TABLE "workflow_policy_overlay" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    -- NULL = organization-wide overlay; non-null = clinic-scoped.
    -- Resolution order at command time: base policy → org-wide
    -- overlay → clinic overlay. Each layer tightens further.
    "clinicId" UUID,
    -- Bound to a SPECIFIC workflow_policy row, not just (code,
    -- version), so the activation row stays valid across base
    -- supersession. ADR-0017 grandfather rule.
    "workflowPolicyId" UUID NOT NULL,
    -- WorkflowPolicyOverlay shape:
    --   { forbidTransitionsFromStates?: { [command]: OrderState[] },
    --     addRequiredAttestations?: { [transitionId]: AttestationRequirement[] } }
    -- Validated structurally by the Zod schema in
    -- UpsertWorkflowPolicyOverlay AND by mergePolicyWithOverlay
    -- (fail-closed) on every command dispatch. PHI-free by
    -- contract; the Zod schema is `.strict()`.
    "overlayJson" JSONB NOT NULL,
    "status" "WorkflowPolicyOverlayStatus" NOT NULL DEFAULT 'DRAFT',
    -- Monotonically increasing per (org, clinic, workflowPolicyId);
    -- every UpsertWorkflowPolicyOverlay activation increments. The
    -- audit metadata cites this number so an incident reviewer can
    -- replay "which overlay shaped this command?" without joining
    -- back to the live admin table.
    "version" INTEGER NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflow_policy_overlay_pkey" PRIMARY KEY ("id")
);

-- 3. Foreign keys. RESTRICT on every parent so the overlay row
--    never silently detaches from the audit chain.
ALTER TABLE "workflow_policy_overlay"
    ADD CONSTRAINT "workflow_policy_overlay_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workflow_policy_overlay"
    ADD CONSTRAINT "workflow_policy_overlay_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workflow_policy_overlay"
    ADD CONSTRAINT "workflow_policy_overlay_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workflow_policy_overlay"
    ADD CONSTRAINT "workflow_policy_overlay_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Lookup index — every command dispatch reads ACTIVE overlays
--    for one (org, basePolicy) tuple; this is THE hot read path.
CREATE INDEX "workflow_policy_overlay_organizationId_workflowPolicyId_status_idx"
    ON "workflow_policy_overlay"("organizationId", "workflowPolicyId", "status");

-- 5. Activation invariant — at most one ACTIVE row per
--    (organizationId, clinic-or-org-wide, workflowPolicyId).
--    The COALESCE collapses NULL clinicIds to a sentinel uuid so
--    the partial unique fires when an admin tries to create a
--    second org-wide ACTIVE overlay for the same base policy.
--    Without COALESCE, two org-wide ACTIVEs would both have
--    clinicId = NULL and Postgres would treat them as distinct.
--
--    The activation flow (executed atomically inside the
--    UpsertWorkflowPolicyOverlay command tx):
--
--      UPDATE workflow_policy_overlay
--         SET status = 'SUPERSEDED'
--       WHERE "organizationId" = :org
--         AND COALESCE("clinicId", '00000000-0000-0000-0000-000000000000'::uuid)
--             = COALESCE(:clinic, '00000000-0000-0000-0000-000000000000'::uuid)
--         AND "workflowPolicyId" = :policy
--         AND status = 'ACTIVE';
--
--      INSERT INTO workflow_policy_overlay (..., status) VALUES (..., 'ACTIVE');
--
--    Forgetting the demote and only attempting the insert raises
--    23505 here rather than yielding a silent two-ACTIVE state.
CREATE UNIQUE INDEX "workflow_policy_overlay_active_unique"
    ON "workflow_policy_overlay"(
        "organizationId",
        COALESCE("clinicId", '00000000-0000-0000-0000-000000000000'::uuid),
        "workflowPolicyId"
    )
    WHERE "status" = 'ACTIVE';

-- 6. Grants + RLS. Same template as carrier_credential / every
--    tenant table that ships post-baseline. Required so the
--    `pharmax_app` and `pharmax_system` roles can DML the table
--    AND so RLS gates every read/write by the active org GUC.
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['workflow_policy_overlay']
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO pharmax_app, pharmax_system', tbl);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I FOR ALL USING (
                current_setting(''pharmax.system_context'', true) = ''on''
                OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
            ) WITH CHECK (
                current_setting(''pharmax.system_context'', true) = ''on''
                OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
            )',
            tbl
        );
    END LOOP;
END $$;

-- 7. Column comments — pinned semantics so anyone running `\d+
--    workflow_policy_overlay` in psql sees why the table exists.
COMMENT ON TABLE "workflow_policy_overlay" IS
  'Per-tenant declarative overlay on a base WorkflowPolicy row (Tier 2 of ADR-0019). Tighten-only: an overlay can REMOVE a transition or ADD an attestation, never widen the base. Loaded INSIDE the command-bus tx (RLS-scoped), composed by resolveEffectivePolicy(), and stamped on command_log + audit_log per ADR-0007.';
COMMENT ON COLUMN "workflow_policy_overlay"."clinicId" IS
  'NULL = organization-wide overlay (applies to every order). Non-null = clinic-scoped overlay (applies only to orders whose clinic_id matches). Both layers compose at dispatch time.';
COMMENT ON COLUMN "workflow_policy_overlay"."workflowPolicyId" IS
  'Bound to a specific workflow_policy row. Ensures the grandfather rule from ADR-0017 extends to overlays: an in-flight order born under v1 keeps reading v1 overlays even after v2 activates.';
COMMENT ON COLUMN "workflow_policy_overlay"."overlayJson" IS
  'WorkflowPolicyOverlay JSON shape from @pharmax/workflow. PHI-FREE by contract — never store patient identifiers here. Validated structurally at write time and re-validated by mergePolicyWithOverlay on every command dispatch (fail-closed).';
