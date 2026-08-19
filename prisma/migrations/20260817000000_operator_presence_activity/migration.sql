-- Operator presence + activity telemetry — schema.prisma §11.
--
-- Closes the last gap in the application-activity vocabulary from
-- .cursor/rules/03-sla-performance.mdc, which is what the idle-time
-- report needs. Seven of the eleven listed signals were already
-- durable before this migration (audit_log `user.signed_in`,
-- command_log startedAt/completedAt, print_job, and scan FAILURES via
-- command_log.errorCode LIKE 'FILL_SCAN_%'), so these two tables
-- carry only what nothing else records.
--
-- PRIVACY BOUNDARY. The same rule file forbids tracking screenshots,
-- keystrokes, unrelated websites, and personal device activity. That
-- is enforced by the COLUMN TYPES here, not by convention: there is
-- no TEXT, JSONB, or otherwise open column on either table. Every
-- column is an enum, a uuid foreign key, a timestamp, or an integer
-- counter. A caller who wanted to record a URL or a keystroke buffer
-- has nowhere to put it, and creating somewhere requires a reviewed
-- migration rather than an extra key in a metadata blob.
--
-- PHI: none. Scans record classification + outcome, never the
-- scanned value.

-- ---------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "OperatorActivityKind" AS ENUM ('SIGNED_OUT', 'ORDER_OPENED', 'QUEUE_CLAIMED', 'SCAN');

-- CreateEnum
CREATE TYPE "OperatorScanKind" AS ENUM ('GS1', 'NDC', 'VIAL_LABEL', 'LOT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OperatorScanOutcome" AS ENUM ('MATCHED', 'MISMATCHED', 'UNPARSEABLE');

-- ---------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------

-- Compacted presence. ONE row per (organization, user, time slot) —
-- the unique constraint below is what bounds the write rate of the
-- highest-frequency signal in the platform. An append-only heartbeat
-- log would let the CLIENT choose how fast this table grows.
--
-- CreateTable
CREATE TABLE "operator_presence_slot" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workstationId" UUID,
    "slotStartedAt" TIMESTAMP(3) NOT NULL,
    "firstHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "heartbeatCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "operator_presence_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_activity_event" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workstationId" UUID,
    "kind" "OperatorActivityKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" UUID,
    "bucketId" UUID,
    "scanKind" "OperatorScanKind",
    "scanOutcome" "OperatorScanOutcome",

    CONSTRAINT "operator_activity_event_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
--
--    The presence unique key deliberately omits "workstationId":
--    Postgres treats NULLs as DISTINCT in a unique constraint, so a
--    nullable column in the key would let every heartbeat without a
--    workstation insert a fresh row — silently restoring the
--    unbounded growth the slot design exists to prevent.
-- ---------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "operator_presence_slot_organizationId_userId_slotStartedAt_key"
    ON "operator_presence_slot"("organizationId", "userId", "slotStartedAt");

-- CreateIndex
CREATE INDEX "operator_presence_slot_organizationId_slotStartedAt_idx"
    ON "operator_presence_slot"("organizationId", "slotStartedAt");

-- CreateIndex
CREATE INDEX "operator_activity_event_organizationId_userId_occurredAt_idx"
    ON "operator_activity_event"("organizationId", "userId", "occurredAt");

-- CreateIndex
CREATE INDEX "operator_activity_event_organizationId_occurredAt_idx"
    ON "operator_activity_event"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "operator_activity_event_organizationId_kind_occurredAt_idx"
    ON "operator_activity_event"("organizationId", "kind", "occurredAt");

-- ---------------------------------------------------------------------
-- 4. Foreign keys.
--
--    Organization / User / Workstation edges follow the house rule:
--    RESTRICT to the tenant root (an org deletion must go through an
--    explicit shred path, never silently drop rows), SET NULL for the
--    optional workstation attribution.
--
--    orderId / bucketId CASCADE because the telemetry row is a
--    pointer to workflow context, not evidence about it: if the order
--    or bucket it references is gone, a dangling activity row has
--    nothing left to say. The AUDIT record of what an operator did to
--    an order lives in audit_log / command_log, which do not cascade.
-- ---------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "operator_presence_slot" ADD CONSTRAINT "operator_presence_slot_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_presence_slot" ADD CONSTRAINT "operator_presence_slot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_presence_slot" ADD CONSTRAINT "operator_presence_slot_workstationId_fkey"
    FOREIGN KEY ("workstationId") REFERENCES "workstation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_activity_event" ADD CONSTRAINT "operator_activity_event_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_activity_event" ADD CONSTRAINT "operator_activity_event_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_activity_event" ADD CONSTRAINT "operator_activity_event_workstationId_fkey"
    FOREIGN KEY ("workstationId") REFERENCES "workstation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_activity_event" ADD CONSTRAINT "operator_activity_event_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_activity_event" ADD CONSTRAINT "operator_activity_event_bucketId_fkey"
    FOREIGN KEY ("bucketId") REFERENCES "bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Grants.
--
--    Both tables need DELETE, unlike the append-only evidence tables
--    elsewhere in this schema: they are operational telemetry on a
--    retention window, and the worker prune loop
--    (apps/worker/src/drains/prune-operator-telemetry.ts) is what
--    keeps them bounded. UPDATE is granted on the presence table
--    only — that is the heartbeat upsert folding a beat into an
--    existing slot. Activity events are never updated.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "operator_presence_slot" TO pharmax_app, pharmax_system;

GRANT SELECT, INSERT, DELETE ON TABLE "operator_activity_event" TO pharmax_app, pharmax_system;
REVOKE UPDATE ON TABLE "operator_activity_event" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 6. Row-level security: enabled AND forced on both tables.
--
--    Policies are split per command rather than one FOR ALL, so DML a
--    table does not permit has no policy to permit it — an
--    accidental future GRANT of UPDATE on operator_activity_event
--    would still be denied here.
-- ---------------------------------------------------------------------

ALTER TABLE "operator_presence_slot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operator_presence_slot" FORCE  ROW LEVEL SECURITY;

ALTER TABLE "operator_activity_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operator_activity_event" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "operator_presence_slot"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "operator_presence_slot"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- USING and WITH CHECK both, so the heartbeat upsert can neither
-- target another tenant's slot nor move a slot into another tenant.
CREATE POLICY tenant_isolation_update ON "operator_presence_slot"
  FOR UPDATE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- The prune loop runs cross-tenant in system context; a tenant
-- session may only delete its own rows.
CREATE POLICY tenant_isolation_delete ON "operator_presence_slot"
  FOR DELETE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_select ON "operator_activity_event"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "operator_activity_event"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_delete ON "operator_activity_event"
  FOR DELETE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );
