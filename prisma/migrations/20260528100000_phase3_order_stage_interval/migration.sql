-- migration: 20260528100000_phase3_order_stage_interval
--
-- Per-stage SLA interval records for wait/active timing analytics.

CREATE TYPE "OrderStageIntervalKind" AS ENUM (
    'WAIT_BEFORE_TYPING',
    'TYPING_ACTIVE',
    'WAIT_BEFORE_PV1',
    'PV1_ACTIVE',
    'WAIT_BEFORE_FILL',
    'FILL_ACTIVE',
    'WAIT_BEFORE_FINAL_VERIFICATION',
    'FINAL_VERIFICATION_ACTIVE',
    'WAIT_BEFORE_SHIPPING',
    'SHIPPING_ACTIVE'
);

CREATE TABLE "order_stage_interval" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "OrderStageIntervalKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "actorUserId" UUID,
    "openCommandLogId" UUID NOT NULL,
    "closeCommandLogId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_stage_interval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_stage_interval_organizationId_orderId_kind_startedAt_idx"
    ON "order_stage_interval"("organizationId", "orderId", "kind", "startedAt");
CREATE INDEX "order_stage_interval_organizationId_siteId_kind_startedAt_idx"
    ON "order_stage_interval"("organizationId", "siteId", "kind", "startedAt");
CREATE INDEX "order_stage_interval_organizationId_orderId_endedAt_idx"
    ON "order_stage_interval"("organizationId", "orderId", "endedAt");

CREATE UNIQUE INDEX "order_stage_interval_one_open_per_order"
    ON "order_stage_interval"("orderId")
    WHERE "endedAt" IS NULL;

ALTER TABLE "order_stage_interval" ADD CONSTRAINT "order_stage_interval_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_stage_interval" ADD CONSTRAINT "order_stage_interval_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_stage_interval" ADD CONSTRAINT "order_stage_interval_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_stage_interval" ADD CONSTRAINT "order_stage_interval_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_stage_interval" ADD CONSTRAINT "order_stage_interval_openCommandLogId_fkey"
    FOREIGN KEY ("openCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_stage_interval" ADD CONSTRAINT "order_stage_interval_closeCommandLogId_fkey"
    FOREIGN KEY ("closeCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['order_stage_interval']
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
