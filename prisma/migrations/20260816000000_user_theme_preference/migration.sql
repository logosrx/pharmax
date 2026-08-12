-- Per-user console theme preference (self-service appearance setting).
-- DARK is the product default; SYSTEM follows the device's
-- prefers-color-scheme. Additive column on the existing RLS-scoped
-- "user" table — no new RLS policy needed.

CREATE TYPE "UserThemePreference" AS ENUM ('DARK', 'LIGHT', 'SYSTEM');

ALTER TABLE "user"
    ADD COLUMN "themePreference" "UserThemePreference" NOT NULL DEFAULT 'DARK';
