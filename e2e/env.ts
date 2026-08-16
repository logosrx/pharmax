// Single source of truth for the E2E harness environment.
//
// Everything here is SYNTHETIC. The credentials below exist only in
// the throwaway `pharmax_e2e` database that `e2e/setup.ts` provisions;
// they are not secrets and must never be reused outside this suite.
// No PHI, no real patient/provider/clinic data — same rule as
// prisma/seed.ts.

import process from "node:process";

/** Dedicated port so the suite never collides with a dev server on 3000. */
export const E2E_PORT = 3100;

/** Public (no-tenant) origin — health endpoint, generic redirects. */
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/**
 * Tenant origin for the seeded demo org. Sign-in resolves the
 * organization from the request subdomain (ADR-0030), and Chromium
 * resolves `*.localhost` to loopback without /etc/hosts entries.
 */
export const E2E_ORG_BASE_URL = `http://acme.localhost:${E2E_PORT}`;

/**
 * Throwaway database, isolated from the shared `pharmax` dev database
 * so an E2E run can never contaminate another agent's working data.
 * Overridable for CI (the service container maps the same URL).
 */
export const E2E_DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/pharmax_e2e";

/** Local KMS seed (>= 32 chars). Synthetic; dev/test adapter only. */
export const E2E_KMS_SEED = "pharmax-e2e-local-kms-seed-synthetic-never-production";

/**
 * The seeded operator. A Pharmacist deliberately: the role is NOT on
 * the platform MFA floor (OrgAdmin / BillingManager are), so the suite
 * exercises the real password sign-in path without inventing an MFA
 * bypass. Seeded by scripts/e2e-seed.ts through the same Argon2id
 * hasher the app boots with.
 */
export const E2E_OPERATOR_EMAIL = "e2e-pharmacist@acme.test";
export const E2E_OPERATOR_PASSWORD = "pharmax-e2e-smoke-Password-1!";

/**
 * Environment for `next build` / `next start` of apps/web.
 *
 * NODE_ENV is intentionally ABSENT here: the webServer runs
 * `next dev`, which sets NODE_ENV=development itself. See
 * playwright.config.ts for why the suite targets the dev server
 * rather than a production build (short version: `next build` bakes
 * NODE_ENV=production into the bundle, which forces the RDS TLS path
 * in packages/database and cannot connect to the local plaintext
 * Postgres).
 */
export const E2E_WEB_ENV: Readonly<Record<string, string>> = Object.freeze({
  DATABASE_URL: E2E_DATABASE_URL,
  DIRECT_URL: E2E_DATABASE_URL,
  PHARMAX_LOCAL_KMS_SEED: E2E_KMS_SEED,
  APP_URL: E2E_BASE_URL,
  LOG_LEVEL: "warn",
});
