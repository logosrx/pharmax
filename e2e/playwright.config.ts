// Playwright configuration for the Pharmax smoke suite.
//
// Scope (deliberately small — this is the repo's FIRST e2e layer):
//   - Chromium only. Cross-browser coverage is a follow-up once the
//     suite has proven stable in CI.
//   - One worker. The suite shares a single seeded database; serial
//     execution keeps queue counts and sign-in rate limits
//     deterministic.
//
// The webServer runs `next dev` — the same way developers run the
// console — NOT a production build. That is deliberate, not lazy:
// `next build` hard-inlines NODE_ENV=production into the server
// bundle (webpack DefinePlugin), and packages/database keys Postgres
// TLS on that value, so a production bundle unconditionally demands
// RDS TLS and cannot talk to the plaintext docker-compose Postgres.
// (Verified empirically: with a prod build every DB-touching request
// 500s with "server does not support SSL connections", even when the
// server process runs with NODE_ENV=test.) Smoke-testing the real
// production bundle is a documented follow-up in e2e/README.md.
//
// In dev mode `src/server/bootstrap.ts` takes the dev/test path:
// LocalKmsAdapter from PHARMAX_LOCAL_KMS_SEED, in-memory
// package-photo storage, no Sentry/OTel/S3/Stripe/DB-TLS — the
// supported way to run this app hermetically.
//
// `e2e/setup.ts` must run first (the `test:e2e` script chains it) so
// the database exists, is migrated, and is seeded before the server
// answers its first request.

import { fileURLToPath } from "node:url";
import process from "node:process";

import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL, E2E_PORT, E2E_WEB_ENV } from "./env";

const webAppDir = fileURLToPath(new URL("../apps/web", import.meta.url));

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  // Dev-mode route compiles are lazy, so the first request to any route
  // pays for compiling it, and a test that walks the whole dispense
  // workflow pays that once per stage. On a two-vCPU CI runner sharing
  // those cores with Chromium, a single cold ops route can take over a
  // minute, and the golden path crosses fifteen of them.
  //
  // Compiling them up front instead was tried and reverted: eagerly
  // holding the whole ops surface in the dev server's module graph
  // exhausts its heap, and `next dev` responds by restarting itself
  // mid-suite (dropping sockets, abandoning Postgres transactions, and
  // discarding every compile). Lazy-and-patient is what this app's dev
  // server can actually sustain, so the budget has to cover it.
  // Default for the short smoke specs. The long workflow tests set their
  // own budgets with `test.setTimeout`, which overrides this — see
  // WORKFLOW_TEST_TIMEOUT_MS in full-dispense.spec.ts.
  timeout: 90_000,
  forbidOnly: process.env["CI"] !== undefined,
  retries: process.env["CI"] !== undefined ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Same flags as the apps/web `dev` script, on the dedicated port.
    command: `pnpm exec next dev --webpack --port ${E2E_PORT}`,
    cwd: webAppDir,
    url: `${E2E_BASE_URL}/api/health`,
    // First compile of the health route on a cold CI runner is slow.
    timeout: 600_000,
    reuseExistingServer: process.env["CI"] === undefined,
    env: {
      ...E2E_WEB_ENV,
      // Raise the dev server's heap ceiling.
      //
      // Next's dev server self-restarts when it approaches ~80% of the
      // V8 old-space limit, logging "Server is approaching the used
      // memory threshold, restarting...". On a cold CI runner it
      // compiles the whole operator console route-by-route as the
      // golden-path spec walks intake → typing → PV1 → fill → label →
      // final → ship, and the accumulated compilation output reaches
      // that ceiling partway through.
      //
      // The restart drops every in-flight request. What the suite then
      // reports is a 120s `waitForResponse` timeout on whichever POST
      // was open — most often assign-lot, sometimes a sign-in — plus a
      // Postgres "unexpected EOF on client connection with an open
      // transaction" a second later. None of that names the real cause,
      // which is why this flake has been diagnosed as a product
      // regression more than once.
      //
      // Observed rate before this change: roughly 5 failures in 30
      // completed e2e runs, across `main` and four unrelated PR
      // branches, always in full-dispense.spec.ts and always at a
      // different step. That is frequent enough to make a red e2e run
      // uninformative, which is worse than a slow one — go-live D1
      // exists so this suite means something.
      //
      // 4 GB against the 7 GB a standard GitHub runner has: enough
      // headroom for the full route set without competing with
      // Postgres and Chromium in the same container.
      NODE_OPTIONS: [process.env["NODE_OPTIONS"], "--max-old-space-size=4096"]
        .filter((v) => v !== undefined && v.length > 0)
        .join(" "),
    },
  },
});
