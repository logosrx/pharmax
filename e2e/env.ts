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
 * The seeded operator. A Pharmacist deliberately: PV1 and final
 * verification require pharmacist authority, so the golden path cannot
 * be walked by a lesser role.
 *
 * `Pharmacist` is ON the platform MFA floor (ELEVATED_ROLE_CODES), so
 * this operator signs in with password + TOTP. The seed enrolls a real
 * authenticator and passes the secret through the state file; the specs
 * mint codes with the same module `SignIn` verifies against. No MFA
 * bypass anywhere — the floor is enforced exactly as in production.
 * Seeded by scripts/e2e-seed.ts through the same Argon2id hasher the
 * app boots with.
 */
export const E2E_OPERATOR_EMAIL = "e2e-pharmacist@acme.test";
export const E2E_OPERATOR_PASSWORD = "pharmax-e2e-smoke-Password-1!";

/**
 * Additional synthetic operators for the full-dispense suite. The
 * Separation-of-Duties registry (packages/rbac separation-of-duties.ts)
 * forbids the same actor from: completing typing AND approving PV1,
 * approving PV1 AND approving final, completing fill AND approving
 * final. Walking intake → ship therefore needs four pairs of hands:
 *
 *   - tech (PharmacyTechnician): transcription, typing, fill
 *   - E2E_OPERATOR (Pharmacist): PV1 approve/reject
 *   - pharmacist 2 (Pharmacist): final verification
 *   - shipping clerk (ShippingClerk): release / create / confirm shipment
 *
 * The two Pharmacists are on the MFA floor and sign in with a second
 * factor; the technicians and the shipping clerk are below it and sign
 * in with a password only. The suite therefore covers both shapes, and
 * which is which follows ELEVATED_ROLE_CODES rather than a list here —
 * the list is what broke when `Pharmacist` joined the floor.
 */
export const E2E_TECH_EMAIL = "e2e-tech@acme.test";
export const E2E_TECH_PASSWORD = "pharmax-e2e-tech-Password-1!";
/**
 * Second technician, used ONLY by the patient-search coverage test.
 * It must be a different user from E2E_TECH: auditPatientView's
 * minute-bucketed idempotency key is per (operator, patient) but its
 * payload includes the surface, so one operator searching
 * (PATIENT_SEARCH_RESULT) and transcribing (PATIENT_ADMIN_PAGE)
 * against the same patient within a minute trips
 * COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH (known product bug — see
 * full-dispense.spec.ts).
 */
export const E2E_TECH2_EMAIL = "e2e-tech-2@acme.test";
export const E2E_TECH2_PASSWORD = "pharmax-e2e-tech2-Password-1!";
export const E2E_PHARMACIST2_EMAIL = "e2e-pharmacist-2@acme.test";
export const E2E_PHARMACIST2_PASSWORD = "pharmax-e2e-rph2-Password-1!";
export const E2E_SHIPPING_EMAIL = "e2e-shipping@acme.test";
export const E2E_SHIPPING_PASSWORD = "pharmax-e2e-ship-Password-1!";

/**
 * Fixed partner API key for order intake (POST /api/v1/orders). There
 * is deliberately no ops-console surface for creating an order — the
 * v1 partner API is the production intake path — so the suite calls
 * it directly. The token is a synthetic constant (valid `pxk_` + 43
 * base64url chars shape) so the seed can mint it idempotently by
 * hash; it authenticates nothing outside the throwaway e2e database.
 */
export const E2E_API_KEY_TOKEN = "pxk_e2e-full-dispense-synthetic-Token-000000001";

/**
 * Tenant ids the specs need (clinic/site/patient/provider) that only
 * exist after seeding. scripts/e2e-seed.ts writes them here; the
 * specs and scripts/e2e-dispatch.ts read them. Gitignored.
 */
export const E2E_STATE_FILE = new URL("./.e2e-state.json", import.meta.url).pathname;

export interface E2ESeedState {
  readonly organizationId: string;
  readonly clinicId: string;
  readonly siteId: string;
  readonly patientId: string;
  readonly patientLastName: string;
  readonly providerId: string;
  /**
   * Base32 TOTP secrets by operator email, for the operators whose role
   * sits on the platform MFA floor. Generated fresh on every seed run
   * and handed over here rather than fixed in this file: a constant
   * shaped like a shared secret is both a secret-scanner finding and a
   * standing invitation to reuse it somewhere that matters.
   *
   * Absent for below-floor roles, which stay password-only.
   */
  readonly totpSecrets: Readonly<Record<string, string>>;
}

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

  // ---- Database and transaction budgets, raised for this harness ----
  //
  // The suite runs `next dev --webpack` (see playwright.config.ts for
  // why a production build cannot reach the plaintext docker Postgres).
  // Dev mode compiles a route on first request, so a cold, contended CI
  // runner is several times slower than a developer laptop, and the
  // 2026-08-17 `full-dispense` failure was the result. It failed in two
  // stages, and both are represented here because fixing only the first
  // is what made the second visible:
  //
  //   1. Transaction API error: A commit cannot be executed on an
  //      expired transaction. The timeout for this transaction was
  //      5000 ms, however 10406 ms passed…
  //   2. Transaction API error: Unable to start a transaction in the
  //      given time.
  //
  // (1) is the transaction's own duration and is fixed by
  // COMMAND_TX_TIMEOUT_MS. (2) is *acquiring a connection at all*, and
  // it is governed by the smaller of Prisma's `maxWait` and the pg
  // pool's acquisition timeout — raising `maxWait` alone did nothing,
  // because pg still gave up at its own 5 s. So the pool timeout is
  // raised to match, and the pool itself is widened: a single command
  // request serially takes connections in resolve-org-from-host,
  // resolve-tenancy, the session service, and three more inside the
  // command bus, which leaves little of a 10-connection pool for
  // anything concurrent.
  //
  // INVARIANT: COMMAND_TX_MAX_WAIT_MS <= DATABASE_POOL_ACQUIRE_TIMEOUT_MS.
  // Above that, the extra wait is unreachable and the configuration
  // lies about itself. `assertTransactionWaitWithinPoolTimeout` checks
  // this at boot; e2e/setup.ts asserts it here too so a bad edit fails
  // before a 15-minute suite does.
  //
  // None of this touches production, which runs a prebuilt server with
  // no lazy compilation. If the golden path ever exceeds THESE numbers,
  // that is a real finding about the command path rather than a
  // dev-mode artifact.
  //
  // Overridable from the shell so the pool can be squeezed deliberately
  // to reproduce contention locally, e.g.
  //   DATABASE_POOL_MAX=3 pnpm test:e2e
  COMMAND_TX_TIMEOUT_MS: process.env["COMMAND_TX_TIMEOUT_MS"] ?? "60000",
  COMMAND_TX_MAX_WAIT_MS: process.env["COMMAND_TX_MAX_WAIT_MS"] ?? "20000",
  DATABASE_POOL_MAX: process.env["DATABASE_POOL_MAX"] ?? "25",
  DATABASE_POOL_ACQUIRE_TIMEOUT_MS: process.env["DATABASE_POOL_ACQUIRE_TIMEOUT_MS"] ?? "20000",
});
