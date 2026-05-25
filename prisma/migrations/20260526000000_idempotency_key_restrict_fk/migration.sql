-- ============================================================================
-- Migration: tighten idempotency_key.organizationId FK to ON DELETE RESTRICT
-- ============================================================================
--
-- Surfaced by `scripts/check-prisma-schema.ts` rule R4: a relation to
-- Organization must not use ON DELETE CASCADE. The original principle
-- from ARCHITECTURE_PRINCIPLES.md is that an org deletion must force
-- an explicit shred path with audit rows, not silently destroy tenant
-- data. The baseline migration created the constraint with CASCADE;
-- this migration tightens it to RESTRICT.
--
-- Behavioral impact:
--   * Before: deleting an Organization automatically destroyed every
--     idempotency_key row owned by that org. Silent. No audit trail.
--   * After: deleting an Organization fails with a 23503 foreign key
--     violation if any idempotency_key row still references it.
--     Operators must run an explicit purge command (which itself
--     writes audit_log + event_outbox) before the org can be deleted.
--
-- Constraint name follows Prisma's default (`<table>_<column>_fkey`)
-- and matches the baseline definition at line 662 of
-- 20260514134704_baseline/migration.sql.

ALTER TABLE "idempotency_key"
  DROP CONSTRAINT "idempotency_key_organizationId_fkey";

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "idempotency_key_organizationId_fkey"
  FOREIGN KEY ("organizationId")
  REFERENCES "organization"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
