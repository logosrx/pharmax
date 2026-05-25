-- =====================================================================
-- AUDIT HASH-CHAIN BASELINE
--
-- Lands BEFORE any PHI-bearing table. Turns audit_log into a
-- tamper-evident chain by linking each row to the previous one in the
-- same tenant's chain via a SHA-256 hash, and tracks the per-tenant
-- chain head in a new audit_chain_state table.
--
-- Why this lands now:
--
--   Once PHI flows through audit_log (PV1 approvals, label reprints,
--   PHI access events, etc.), the chain head's signed manifest becomes
--   the only way an auditor can prove that no row was deleted or
--   silently mutated. Adding the columns AFTER PHI is in the table
--   would leave a window of unprovable history.
--
-- Two invariants this migration codifies:
--
--   1. audit_log rows are append-only. Already enforced by the RLS
--      baseline (no UPDATE/DELETE policy + explicit REVOKE). This
--      migration adds the columns the chain depends on but does NOT
--      relax any prior immutability control.
--
--   2. Chain writes serialize per tenant via a Postgres advisory lock.
--      `pg_try_advisory_xact_lock(audit_chain_lock_key(orgId))` is
--      acquired inside the writer's transaction; concurrent inserts
--      in the SAME tenant block briefly, concurrent inserts in
--      DIFFERENT tenants do not interact. The lock is transaction-
--      scoped so it releases automatically on commit/rollback.
--
-- ---------------------------------------------------------------------
-- 1. audit_log: new columns
--
--    prevHash:  the previous row's entryHash. NULL on the genesis
--               row for this tenant. Subsequent rows MUST set it to
--               the prior row's entryHash; the writer enforces this.
--
--    entryHash: sha256 over the canonical serialization of this row.
--               Pre-computed in application code (not as a generated
--               column) because the canonical encoder must match the
--               verifier byte-for-byte regardless of Postgres locale,
--               JSON key ordering, or future column additions.
--
--    seq:       monotonic per organization starting at 1. The
--               (organizationId, seq) unique index is the integrity
--               guarantee — no two rows in the same tenant can share
--               a sequence number. Use BIGINT because audit_log is
--               write-heavy and 32 bits would overflow for a busy
--               tenant within a decade.
--
--    We backfill existing rows with synthetic values to satisfy the
--    NOT NULL constraints on entryHash and seq. seq is assigned in
--    occurredAt order per organization (window function). entryHash
--    is set to the SHA-256 of "legacy:<id>" — clearly distinguishable
--    from genuine chained entries (no canonical-encoded row maps to
--    that input). The verifier treats rows with seq below the
--    chain head's first chained seq as legacy and skips chain checks
--    for them. In dev/seed this set is small (the bootstrap
--    organization's audit history); in prod it MUST be empty (we
--    only ship this after the baseline migration with no audit
--    activity yet).
-- ---------------------------------------------------------------------

ALTER TABLE "audit_log"
  ADD COLUMN "prevHash"  BYTEA,
  ADD COLUMN "entryHash" BYTEA,
  ADD COLUMN "seq"       BIGINT;

-- Backfill seq per organization in occurredAt order. This is
-- deterministic: ties (rows with identical occurredAt) are broken by
-- id to keep the assignment stable across re-runs.
UPDATE "audit_log" AS al
SET "seq" = w.row_number
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "organizationId"
      ORDER BY "occurredAt" ASC, id ASC
    ) AS row_number
  FROM "audit_log"
) AS w
WHERE al.id = w.id;

-- Backfill entryHash for legacy rows with a sentinel that the
-- application-side verifier recognizes and excludes. `'legacy:' ||
-- id::text` is hashed by Postgres' digest() — we use sha256 via the
-- pgcrypto extension, enabled below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE "audit_log"
SET "entryHash" = digest('legacy:' || id::text, 'sha256')
WHERE "entryHash" IS NULL;

-- Enforce non-nullability now that all rows have values.
ALTER TABLE "audit_log"
  ALTER COLUMN "entryHash" SET NOT NULL,
  ALTER COLUMN "seq"       SET NOT NULL;

-- One sequence per tenant — the integrity guarantee.
CREATE UNIQUE INDEX "audit_log_organizationId_seq_key"
  ON "audit_log" ("organizationId", "seq");

-- ---------------------------------------------------------------------
-- 2. audit_chain_state: per-tenant chain head pointer
--
--    One row per organization. Created lazily on the tenant's first
--    chained audit_log insert. Holds the latest entryHash and seq so
--    the writer doesn't need to scan audit_log to find the head.
-- ---------------------------------------------------------------------

CREATE TABLE "audit_chain_state" (
  "organizationId" UUID        NOT NULL,
  "latestHash"     BYTEA       NOT NULL,
  "latestSeq"      BIGINT      NOT NULL,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "audit_chain_state_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "audit_chain_state_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "organization"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

-- Seed audit_chain_state from any pre-existing audit_log rows so the
-- chain head reflects the highest-seq legacy row per tenant. This
-- keeps the invariant `latestSeq = MAX(seq) per tenant` true even on
-- migrate-up against an existing dev DB.
INSERT INTO "audit_chain_state" ("organizationId", "latestHash", "latestSeq", "updatedAt")
SELECT
  al."organizationId",
  al."entryHash",
  al."seq",
  now()
FROM "audit_log" al
INNER JOIN (
  SELECT "organizationId", MAX("seq") AS max_seq
  FROM "audit_log"
  GROUP BY "organizationId"
) tops
  ON tops."organizationId" = al."organizationId"
 AND tops.max_seq         = al."seq"
ON CONFLICT ("organizationId") DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Grants for the app role
--
--    audit_chain_state is read+written by the chain writer (which
--    runs under the same pharmax_app role as the rest of the bus).
--    INSERT and UPDATE only — the row is upserted per tenant; DELETE
--    is intentionally NOT granted (the chain head must never
--    disappear; reasoning identical to audit_log immutability).
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "audit_chain_state"
  TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 4. RLS on audit_chain_state
--
--    Tenant-scoped — same policy shape as the other tenant tables.
-- ---------------------------------------------------------------------

ALTER TABLE "audit_chain_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_chain_state" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_chain_state"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 5. audit_chain_lock_key(uuid) — advisory lock key derivation
--
--    Postgres advisory locks take a BIGINT key. We derive one from
--    the organization UUID so each tenant has its own lock space,
--    and the same tenant always hashes to the same key.
--
--    Strategy: take the first 8 bytes of the UUID, interpret as
--    big-endian int64, XOR with a salt so we don't collide with
--    other advisory-lock callers (e.g. Prisma's migration lock).
--    The salt is a compile-time constant; collisions across the
--    pharmax codebase are managed by allocating salts in this file.
--
--    Allocated salts (keep in sync with code):
--      audit_chain_lock_key:    0x6175646974636861  -- ASCII 'auditcha'
--
--    The function is IMMUTABLE so Postgres can inline it in
--    `SELECT pg_advisory_xact_lock(audit_chain_lock_key(...))`.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_chain_lock_key(org_id UUID)
  RETURNS BIGINT
  LANGUAGE plpgsql
  IMMUTABLE
  PARALLEL SAFE
AS $$
DECLARE
  bytes      BYTEA := uuid_send(org_id);
  k          BIGINT;
BEGIN
  -- First 8 bytes, big-endian → BIGINT. uuid_send returns 16 bytes.
  k :=
      ((get_byte(bytes, 0)::BIGINT) << 56)
    | ((get_byte(bytes, 1)::BIGINT) << 48)
    | ((get_byte(bytes, 2)::BIGINT) << 40)
    | ((get_byte(bytes, 3)::BIGINT) << 32)
    | ((get_byte(bytes, 4)::BIGINT) << 24)
    | ((get_byte(bytes, 5)::BIGINT) << 16)
    | ((get_byte(bytes, 6)::BIGINT) <<  8)
    | ((get_byte(bytes, 7)::BIGINT));
  -- XOR with the 'auditcha' salt so we don't collide with other
  -- callers of pg_advisory_xact_lock on the same database.
  RETURN k # x'6175646974636861'::BIGINT;
END;
$$;

GRANT EXECUTE ON FUNCTION audit_chain_lock_key(UUID) TO pharmax_app, pharmax_system;

COMMENT ON TABLE "audit_chain_state" IS
  'Per-tenant audit chain head. Updated atomically with audit_log inserts under pg_advisory_xact_lock(audit_chain_lock_key(organizationId)).';
COMMENT ON FUNCTION audit_chain_lock_key(UUID) IS
  'Derive a per-tenant BIGINT advisory-lock key from an organization UUID. Used by the @pharmax/audit chain writer.';
