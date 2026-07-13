-- NULL-safe uniqueness for user_role grants.
--
-- The Prisma-level `@@unique([userId, roleId, siteId, clinicId,
-- teamId])` compiles to a standard Postgres unique index, and
-- Postgres treats NULLs as DISTINCT in unique indexes. Every valid
-- grant leaves at least one scope column NULL (org-wide grants
-- leave all three NULL), so the constraint never actually fired:
-- the same OrgAdmin grant could be created twice, and revoking one
-- row left the duplicate silently keeping the user's access. That
-- makes revocation unreliable — a security defect, not a data
-- nicety.
--
-- Fix in two steps, same transaction:
--   1. Dedupe existing rows: keep the EARLIEST grant per
--      (userId, roleId, scope triple with NULLs coalesced), delete
--      the rest. Deleting duplicates does not change effective
--      access — the kept row grants the identical permission set.
--   2. Add an expression unique index that coalesces each nullable
--      scope column to a sentinel UUID, so two rows with the same
--      NULL pattern collide. Expression indexes cannot be modelled
--      in schema.prisma (same Prisma limitation as the partial
--      unique indexes already in the drift baseline); the
--      corresponding drift lines are hand-added to
--      prisma/migrations/drift-baseline.txt.
--
-- The all-zeros UUID cannot collide with a real scope id: it would
-- require an actual site/clinic/team row with id
-- 00000000-0000-0000-0000-000000000000, which the id generators
-- never produce.

DELETE FROM "user_role" a
USING "user_role" b
WHERE a."userId" = b."userId"
  AND a."roleId" = b."roleId"
  AND COALESCE(a."siteId",   '00000000-0000-0000-0000-000000000000'::uuid)
    = COALESCE(b."siteId",   '00000000-0000-0000-0000-000000000000'::uuid)
  AND COALESCE(a."clinicId", '00000000-0000-0000-0000-000000000000'::uuid)
    = COALESCE(b."clinicId", '00000000-0000-0000-0000-000000000000'::uuid)
  AND COALESCE(a."teamId",   '00000000-0000-0000-0000-000000000000'::uuid)
    = COALESCE(b."teamId",   '00000000-0000-0000-0000-000000000000'::uuid)
  AND (a."createdAt" > b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" > b."id"));

CREATE UNIQUE INDEX "user_role_grant_null_safe_key"
  ON "user_role" (
    "userId",
    "roleId",
    COALESCE("siteId",   '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("clinicId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("teamId",   '00000000-0000-0000-0000-000000000000'::uuid)
  );
