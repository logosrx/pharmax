-- migration: 20260523220000_phase2_order_cancellation
--
-- Adds the OrderCancellation domain-record table and its
-- CancellationDisposition enum. Lands the structured-record half of
-- the workflow-safety cancellation rule (the workflow-state half
-- already exists in @pharmax/workflow's policy v1 — CANCEL is
-- allowed from every non-terminal state and emits
-- order.cancelled.v1).
--
-- Why one table and not a generic "order_terminal_record" table:
-- the `dispositionReason` enum is cancellation-specific. A
-- rejection record (PV1_REJECTED, FINAL_VERIFICATION_REJECTED)
-- carries its own reason vocabulary. A hold record carries its
-- own. Each gets its own table — duplication is fine; the
-- per-domain enum is the value, and a join-shaped reporting view
-- (added in phase 3) will unify them.
--
-- Single unique on orderId is the structural guarantee that an
-- order cannot be "cancelled twice". A second CancelOrder call
-- lands on the unique violation and the bus surfaces it as a
-- typed ConflictError.
--
-- RLS shape mirrors the baseline: ENABLE + FORCE + one PERMISSIVE
-- `tenant_isolation` policy on the standard
-- `pharmax.system_context` / `pharmax.organization_id` GUC pair.
-- The migration linter `scripts/check-migration-rls.ts` enforces
-- that this section exists.

-- ---------------------------------------------------------------------
-- 1. New enum: CancellationDisposition
-- ---------------------------------------------------------------------

CREATE TYPE "CancellationDisposition" AS ENUM (
    'PATIENT_REQUEST',
    'PROVIDER_REQUEST',
    'CLINIC_REQUEST',
    'INSURANCE_DENIAL',
    'INVENTORY_UNAVAILABLE',
    'DUPLICATE_ORDER',
    'DATA_ENTRY_ERROR',
    'PATIENT_INELIGIBLE',
    'OTHER'
);

-- ---------------------------------------------------------------------
-- 2. New table: order_cancellation
--
--    `dispositionReasonText` MAY contain PHI (e.g. "patient passed
--    away …"). The command bus's redactor scrubs it from
--    `command_log.requestPayload`; the audit row and outbox payload
--    carry a `hasReasonText: boolean` instead.
-- ---------------------------------------------------------------------

CREATE TABLE "order_cancellation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "dispositionReason" "CancellationDisposition" NOT NULL,
    "dispositionReasonText" TEXT,
    "cancelledByUserId" UUID NOT NULL,
    "cancelledFromStatus" "OrderStatus" NOT NULL,
    "cancelledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,
    "commandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_cancellation_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
--    `orderId` unique = "an order can be cancelled at most once".
--    The reporting indexes power dispatcher dashboards:
--      - "how many cancels today/this week/this month?"
--      - "what are the top reasons by clinic?"
--      - "what did <user> cancel?"
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "order_cancellation_orderId_key" ON "order_cancellation"("orderId");
CREATE INDEX "order_cancellation_organizationId_cancelledAt_idx" ON "order_cancellation"("organizationId", "cancelledAt");
CREATE INDEX "order_cancellation_organizationId_dispositionReason_idx" ON "order_cancellation"("organizationId", "dispositionReason");
CREATE INDEX "order_cancellation_organizationId_cancelledByUserId_idx" ON "order_cancellation"("organizationId", "cancelledByUserId");

-- ---------------------------------------------------------------------
-- 4. Foreign keys.
--    All RESTRICT. An order, user, workflow policy, or command log
--    referenced by a cancellation cannot be deleted out from under
--    the audit trail.
-- ---------------------------------------------------------------------

ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_cancelledByUserId_fkey"
    FOREIGN KEY ("cancelledByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Grants for application roles. Mirrors the baseline RLS pattern.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "order_cancellation"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 6. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "order_cancellation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_cancellation" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 7. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'order_cancellation'
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

COMMENT ON TABLE "order_cancellation" IS
  'Terminal cancellation record. One row per order at most (unique on orderId). Written by CancelOrder command in the same tx that flips order.currentStatus to CANCELLED. dispositionReasonText MAY carry PHI and is redacted from command_log; the structured dispositionReason enum is the primary signal for reporting.';
