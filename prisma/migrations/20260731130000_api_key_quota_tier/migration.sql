-- migration: 20260731130000_api_key_quota_tier
--
-- Per-key quota tiers for the public v1 API (ADR-0032, P0 closeout).
--
-- The api_key row records WHICH named tier the key belongs to; the
-- numbers behind each tier (burst per-minute limit + sustained daily
-- quota) are code-owned in `@pharmax/partner-api` so they can change
-- without a migration. Every existing key backfills to STANDARD,
-- which carries the exact limits the shared limiter enforced before
-- tiers existed (120/min) — no partner's effective ceiling changes.
--
-- PHI: none. RLS: unchanged (column addition on an already-policied
-- table).

CREATE TYPE "ApiKeyQuotaTier" AS ENUM ('STANDARD', 'ELEVATED');

ALTER TABLE "api_key"
    ADD COLUMN "quotaTier" "ApiKeyQuotaTier" NOT NULL DEFAULT 'STANDARD';

COMMENT ON COLUMN "api_key"."quotaTier" IS
  'Named quota tier (ADR-0032). Tier numbers (burst rate + daily quota) are code-owned in @pharmax/partner-api; the row records only which tier the key was minted into.';
