-- migration: 20260529000000_phase3_order_correction_reopen
--
-- Adds the OrderCorrectionReopen domain-record table and ReopenReason
-- enum for the ReopenForCorrection command. Append-only: an order may
-- pass through many reopen cycles after PV1 or FINAL rejection.

CREATE TYPE "ReopenReason" AS ENUM (
    'TYPING_CORRECTION',
    'PRESCRIPTION_CLARIFICATION',
    'PV1_REWORK',
    'FILL_REDO',
    'LABEL_REWORK',
    'SUPERVISOR_DIRECTED',
    'OTHER'
);

CREATE TABLE "order_correction_reopen" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reason" "ReopenReason" NOT NULL,
    "reasonText" TEXT,
    "reopenedByUserId" UUID NOT NULL,
    "reopenedFromStatus" "OrderStatus" NOT NULL,
    "reopenToStatus" "OrderStatus" NOT NULL,
    "reopenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,
    "commandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_correction_reopen_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_correction_reopen_organizationId_reopenedAt_idx"
    ON "order_correction_reopen"("organizationId", "reopenedAt");
CREATE INDEX "order_correction_reopen_organizationId_reason_idx"
    ON "order_correction_reopen"("organizationId", "reason");
CREATE INDEX "order_correction_reopen_organizationId_reopenedByUserId_idx"
    ON "order_correction_reopen"("organizationId", "reopenedByUserId");
CREATE INDEX "order_correction_reopen_orderId_reopenedAt_idx"
    ON "order_correction_reopen"("orderId", "reopenedAt");

ALTER TABLE "order_correction_reopen" ADD CONSTRAINT "order_correction_reopen_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_correction_reopen" ADD CONSTRAINT "order_correction_reopen_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_correction_reopen" ADD CONSTRAINT "order_correction_reopen_reopenedByUserId_fkey"
    FOREIGN KEY ("reopenedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_correction_reopen" ADD CONSTRAINT "order_correction_reopen_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_correction_reopen" ADD CONSTRAINT "order_correction_reopen_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "order_correction_reopen"
    TO pharmax_app, pharmax_system;

ALTER TABLE "order_correction_reopen" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_correction_reopen" FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'order_correction_reopen'
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

COMMENT ON TABLE "order_correction_reopen" IS
  'Append-only structured domain record for ReopenForCorrection. One row per reopen cycle after PV1_REJECTED or FINAL_VERIFICATION_REJECTED. reasonText MAY carry PHI and is redacted from command_log.';
