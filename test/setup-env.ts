// Test-wide env defaults.
//
// Several modules (apps/web env, packages/platform-core env) read
// REQUIRED env values at module load time via Zod schema parsing.
// In CI / local test runs, no .env file is loaded — tests would
// fail at IMPORT time if these aren't seeded before the first
// import resolves. Vitest's `setupFiles` runs before each test
// file's imports, which is exactly the hook we need.
//
// The values here are SYNTHETIC defaults safe for tests:
//   - DATABASE_URL: a non-routable Postgres URL; no test code
//     should actually open a connection (Prisma is mocked).
//   - PHARMAX_LOCAL_KMS_SEED: 32+ chars, deterministic per test
//     run so re-runs produce stable ciphertexts when assertions
//     compare envelopes.
//
// Real test scenarios that need real DBs (e.g. integration-tests
// package) override these in their own setup.

import process from "node:process";

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5432/pharmax_test";
process.env["DIRECT_URL"] ??= "postgresql://test:test@localhost:5432/pharmax_test";
process.env["NODE_ENV"] ??= "test";
process.env["LOG_LEVEL"] ??= "warn";
process.env["PHARMAX_LOCAL_KMS_SEED"] ??=
  "pharmax-local-test-seed-do-not-use-in-production-32chars";
