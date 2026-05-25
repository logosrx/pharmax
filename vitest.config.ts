// Root Vitest config for the Pharmax monorepo.
//
// Coverage thresholds intentionally use a two-tier policy:
//
//   1. A REPO-WIDE floor (lines / statements / functions / branches)
//      that every new commit must hold. Today this is 70% — pitched
//      conservatively so the gate trips on regressions, not on
//      one-off package gaps. The ratchet plan: bump global floors
//      by +5pts per quarter until 90/85 across the board.
//
//   2. Per-package OVERRIDES for security-critical packages that
//      must stay at a higher bar than the rest of the codebase.
//      Today: 85% for @pharmax/crypto, @pharmax/audit,
//      @pharmax/command-bus, @pharmax/tenancy, @pharmax/rbac, and
//      @pharmax/sla. Lowering these requires a security review.
//
// The `100` reporter would also pin every file individually, but
// that breaks on legitimate `index.ts` re-export barrels and on
// `types.ts` files that carry no runtime code. We exclude those
// instead (see `exclude` below) and rely on aggregate thresholds.

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Next.js's `server-only` and `client-only` packages are virtual
      // guard modules: importing `server-only` from a Client Component
      // throws at build time. Vitest knows nothing about Next, so the
      // import resolves to a missing module and the whole test file
      // fails to load. Alias to an empty shim — the imports exist
      // purely to fire Next's compile-time check.
      "server-only": new URL("./test/shims/empty.ts", import.meta.url).pathname,
      "client-only": new URL("./test/shims/empty.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: [
      "packages/**/*.{test,spec}.ts",
      "apps/**/*.{test,spec}.ts",
      "scripts/**/*.{test,spec}.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      // DB-bound integration tests run via their own config under
      // `pnpm test:integration`. Excluded here so the default
      // `pnpm test` runs without a live Postgres dependency.
      "packages/integration-tests/**",
    ],
    environment: "node",
    globals: false,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      exclude: [
        // Test files themselves are not "covered by" tests in any
        // meaningful sense.
        "**/*.test.ts",
        "**/*.spec.ts",
        // Re-export barrels have zero conditional logic; counting
        // them would distort the floor and discourage barrel files.
        "**/index.ts",
        // Type-only modules are erased at runtime.
        "**/types.ts",
        // Generated Prisma client.
        "**/generated/**",
        // Test helpers / fixtures are themselves test-only code.
        "**/test-helpers.ts",
        "**/test-clocks.ts",
        "**/test-utils/**",
        // Bootstrap files are exercised via integration tests, not
        // the default unit-test pass.
        "**/bootstrap.ts",
        "**/main.ts",
      ],
      thresholds: {
        // Global floor. Ratchet up over time; see header.
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 65,

        // Per-package overrides for security/safety-critical code.
        // Lowering any of these requires a security review and a
        // note in the PR description.
        "packages/crypto/src/**": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 80,
        },
        "packages/audit/src/**": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 80,
        },
        "packages/command-bus/src/**": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 80,
        },
        "packages/tenancy/src/**": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 80,
        },
        "packages/rbac/src/**": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 80,
        },
        "packages/sla/src/**": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 80,
        },
      },
    },
  },
});
