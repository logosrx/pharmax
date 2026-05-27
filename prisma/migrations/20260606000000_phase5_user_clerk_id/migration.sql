-- migration: 20260606000000_phase5_user_clerk_id
--
-- Add `clerkUserId` to the `user` table so the Clerk session
-- (identity layer) can resolve to a Pharmax user row (authorization +
-- tenancy layer).
--
-- Identity model:
--
--   Clerk owns authentication: sign-in/sign-up, MFA, password
--   reset, OAuth providers, session lifecycle. Each Clerk user has
--   a stable `user_xxxxx` id surfaced via `auth()` in the Next.js
--   request scope.
--
--   Pharmax owns authorization + tenancy: organization, role
--   grants (UserRole), site/clinic/team scope, audit history.
--   The `clerkUserId` column is the bridge — `resolveOperatorTenancyContext`
--   (in apps/web) maps Clerk session → Pharmax user → TenancyContext
--   that the existing command bus already understands.
--
-- Nullable because:
--   - System-only users (`shipping-webhook@<org-slug>.test`,
--     `print-agent@<org-slug>.test`) never log in via Clerk.
--   - Historical users created before Clerk wiring exist (seed +
--     bootstrap).
--   - Operators may be created server-side first (RBAC + scope
--     pre-provisioned) and linked to a Clerk identity on first
--     sign-in.
--
-- Unique-when-present:
--   One Pharmax user maps to AT MOST one Clerk identity (and vice
--   versa). A duplicate clerkUserId across two rows would mean a
--   single Clerk identity has two Pharmax shells — the operator
--   would see the wrong org's data after auth resolution. Fail
--   loud at insert time.

ALTER TABLE "user" ADD COLUMN "clerkUserId" TEXT;

CREATE UNIQUE INDEX "user_clerkUserId_unique"
    ON "user"("clerkUserId")
    WHERE "clerkUserId" IS NOT NULL;
