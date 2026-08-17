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
  // Dev-mode route compiles are lazy; the first hit on a heavy page can
  // exceed Playwright's 30s default.
  timeout: 90_000,
  forbidOnly: process.env["CI"] !== undefined,
  retries: process.env["CI"] !== undefined ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    // Compiles every ops route the suites touch before any assertion
    // runs — see warmup.setup.ts. Without it, `next dev`'s lazy
    // first-request compile is billed to whichever test gets there
    // first, which is why CI (always a cold `.next`) failed where a
    // warm local worktree passed.
    { name: "warmup", testMatch: /warmup\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /warmup\.setup\.ts$/,
      dependencies: ["warmup"],
    },
  ],
  webServer: {
    // Same flags as the apps/web `dev` script, on the dedicated port.
    command: `pnpm exec next dev --webpack --port ${E2E_PORT}`,
    cwd: webAppDir,
    url: `${E2E_BASE_URL}/api/health`,
    // First compile of the health route on a cold CI runner is slow.
    timeout: 600_000,
    reuseExistingServer: process.env["CI"] === undefined,
    env: { ...E2E_WEB_ENV },
  },
});
