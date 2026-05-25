// Vitest config for DB-bound integration tests.
//
// These tests REQUIRE a running Postgres (the docker-compose
// `postgres` service in this repo) and an up-to-date schema
// (`pnpm db:migrate:deploy`). They are deliberately excluded
// from the default `pnpm test` runner so contributors who haven't
// started the local DB still get useful unit-test feedback.
//
// Run them with:
//
//     pnpm db:up                   # ensure postgres is running
//     pnpm db:migrate:deploy       # apply migrations
//     pnpm test:integration        # run this config
//
// The tests use the SAME database as local dev by default
// (`DATABASE_URL`). Each test seeds its own organization with a
// uuid-randomized slug and cleans up after itself so concurrent
// dev work isn't disturbed. For full isolation, set
// `INTEGRATION_DATABASE_URL` to a separate database before
// running.
//
// pool: "forks" + singleThread: true ensures the tests run
// SEQUENTIALLY in a single process. Parallel execution would
// race on the session-set GUCs and the audit chain advisory
// lock (both per-tenant globals).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    globals: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // DB tests can be slow on first connect / migration check.
    testTimeout: 30000,
    hookTimeout: 30000,
    sequence: { concurrent: false },
    reporters: ["default"],
  },
});
