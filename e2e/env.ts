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
 * All four roles sit BELOW the platform MFA floor (OrgAdmin /
 * BillingManager), so every sign-in is the real password-only path.
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

  // Command transaction budget, raised well above the production
  // default for this harness only.
  //
  // The suite runs `next dev --webpack` (see playwright.config.ts for
  // why a production build cannot reach the plaintext docker Postgres).
  // In dev mode a route is compiled on first request, and that compile
  // can land INSIDE an open command transaction — so the transaction is
  // held for however long webpack takes. On a cold, contended CI runner
  // that exceeded the 5 s default and Prisma refused the commit:
  //
  //   Transaction API error: A commit cannot be executed on an expired
  //   transaction. The timeout for this transaction was 5000 ms,
  //   however 10406 ms passed since the start of the transaction.
  //
  // That surfaced as a flaky `full-dispense` golden path, which is the
  // dangerous kind of failure: retry it once and it goes green, so the
  // signal gets discarded. Raising the budget here removes the
  // compile-time confound WITHOUT touching production, where a
  // prebuilt server does no lazy compilation and the tight default is
  // wanted — it bounds how long a command holds its order row lock.
  //
  // If the golden path ever exceeds THIS budget, that is a real
  // finding about the command path rather than a dev-mode artifact.
  COMMAND_TX_TIMEOUT_MS: "60000",
  COMMAND_TX_MAX_WAIT_MS: "30000",
});
