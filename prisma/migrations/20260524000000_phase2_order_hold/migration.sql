-- migration: 20260524000000_phase2_order_hold
--
-- Adds the OrderHold domain-record table and its HoldReason +
-- HoldReleaseReason enums. Lands the structured-record half of
-- the workflow-safety hold rules (the workflow-state half already
-- exists in @pharmax/workflow's policy v1 — PLACE_HOLD is allowed
-- from every active state and emits order.held.v1; RELEASE_HOLD
-- is parameterized by releaseToState and emits
-- order.hold_released.v1).
--
-- This is the FIRST reversible structured domain record in the
-- platform. OrderCancellation was terminal (one row per order,
-- ever); OrderHold is one row per HOLD CYCLE — an order can be
-- held → released → held → released across its lifetime. The
-- shape established here is the template for future place/release
-- patterns (quarantine, recall, hold-by-payer).
--
-- Anti-double-place guarantee is a PARTIAL unique index on
-- (orderId) WHERE releasedAt IS NULL. This:
--   (a) lets multiple historical hold rows coexist per order,
--   (b) makes a second PlaceHold call land on a unique violation
--       while a hold is active (the bus surfaces it as a typed
--       ConflictError → ORDER_ALREADY_ON_HOLD), and
--   (c) costs Postgres nothing — the index is small (only rows
--       with NULL releasedAt occupy it) and serves as the index
--       used by ReleaseHold's "find active hold for this order"
--       query.
--
-- RLS shape mirrors the baseline + the cancellation migration:
-- ENABLE + FORCE + one PERMISSIVE `tenant_isolation` policy on
-- the standard `pharmax.system_context` / `pharmax.organization_id`
-- GUC pair. The migration linter `scripts/check-migration-rls.ts`
-- enforces that this section exists.

-- ---------------------------------------------------------------------
-- 1. New enums: HoldReason + HoldReleaseReason
-- ---------------------------------------------------------------------

CREATE TYPE "HoldReason" AS ENUM (
    'WAITING_FOR_PROVIDER',
    'WAITING_FOR_PATIENT',
    'WAITING_FOR_INSURANCE',
    'INVENTORY_BACKORDER',
    'PRESCRIPTION_AMBIGUITY',
    'COMPLIANCE_REVIEW',
    'DUPLICATE_INVESTIGATION',
    'OTHER'
);

CREATE TYPE "HoldReleaseReason" AS ENUM (
    'RESOLVED',
    'INFO_RECEIVED',
    'ADMIN_OVERRIDE',
    'OTHER'
);

-- ---------------------------------------------------------------------
-- 2. New table: order_hold
--
--    `reasonText` and `releaseReasonText` MAY contain PHI. The
--    command bus's redactor scrubs them from
--    `command_log.requestPayload`; the audit row and outbox
--    payload carry `hasReasonText: boolean` /
--    `hasReleaseReasonText: boolean` instead.
-- ---------------------------------------------------------------------

CREATE TABLE "order_hold" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,

    -- Placement (always set on insert)
    "reason" "HoldReason" NOT NULL,
    "reasonText" TEXT,
    "heldByUserId" UUID NOT NULL,
    "heldFromStatus" "OrderStatus" NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,
    "placeCommandLogId" UUID NOT NULL,

    -- Release (null while active; filled by ReleaseHold)
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" UUID,
    "releasedToStatus" "OrderStatus",
    "releaseReason" "HoldReleaseReason",
    "releaseReasonText" TEXT,
    "releaseCommandLogId" UUID,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_hold_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
--    `order_hold_active_hold_unique` is the PARTIAL unique on
--    `(orderId) WHERE releasedAt IS NULL` — the anti-double-place
--    invariant AND the lookup index for "find the active hold for
--    this order" (the ReleaseHold handler's primary query).
--
--    Reporting indexes:
--      - "how many active/historical holds by reason this month?"
--      - "what did <user> place on hold?"
--      - "show me hold history for this order"
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "order_hold_active_hold_unique"
    ON "order_hold"("orderId")
    WHERE "releasedAt" IS NULL;
CREATE INDEX "order_hold_organizationId_heldAt_idx"
    ON "order_hold"("organizationId", "heldAt");
CREATE INDEX "order_hold_organizationId_reason_idx"
    ON "order_hold"("organizationId", "reason");
CREATE INDEX "order_hold_organizationId_heldByUserId_idx"
    ON "order_hold"("organizationId", "heldByUserId");
CREATE INDEX "order_hold_organizationId_releasedAt_idx"
    ON "order_hold"("organizationId", "releasedAt");
CREATE INDEX "order_hold_orderId_heldAt_idx"
    ON "order_hold"("orderId", "heldAt");

-- ---------------------------------------------------------------------
-- 4. Foreign keys.
--    All RESTRICT. An order, user, workflow policy, or command log
--    referenced by a hold cycle cannot be deleted out from under
--    the audit trail. Release-side FKs are nullable because the
--    columns themselves are nullable until release.
-- ---------------------------------------------------------------------

ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_heldByUserId_fkey"
    FOREIGN KEY ("heldByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_placeCommandLogId_fkey"
    FOREIGN KEY ("placeCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_releasedByUserId_fkey"
    FOREIGN KEY ("releasedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_hold" ADD CONSTRAINT "order_hold_releaseCommandLogId_fkey"
    FOREIGN KEY ("releaseCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Grants for application roles. Mirrors the baseline RLS pattern.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "order_hold"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 6. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "order_hold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_hold" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 7. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'order_hold'
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

COMMENT ON TABLE "order_hold" IS
  'Reversible structured domain record for the PlaceHold / ReleaseHold command pair. One row per hold cycle; at most one ACTIVE row per orderId (partial unique on (orderId) WHERE releasedAt IS NULL). Placement columns are set on insert by PlaceHold; release columns are populated by ReleaseHold updating the same row. reasonText and releaseReasonText MAY carry PHI and are redacted from command_log; structured enums + boolean hasReasonText flags are the primary signal for reporting/audit.';
