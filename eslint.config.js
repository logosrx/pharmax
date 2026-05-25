// Flat config for ESLint 9.
//
// Boundary rules below codify the architectural promises in
// `docs/ARCHITECTURE_PRINCIPLES.md` §D. They are the cheapest layer
// of enforcement: a developer who tries to import the wrong thing
// gets a red squiggle in the editor, not a "please refactor" PR
// comment three days later.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// The generated Prisma client and the @prisma/client package are
// PRIVATE to @pharmax/database. Every other workspace member imports
// the singleton, the typed model exports, and the namespaced Prisma
// helpers from `@pharmax/database` itself. Reaching past that
// boundary bypasses the tenancy extension, the singleton's logging,
// and the type re-export contract — all silently.
const PRISMA_CLIENT_RESTRICTION = {
  paths: [
    {
      name: "@prisma/client",
      message:
        "Import from '@pharmax/database' instead. The generated Prisma " +
        "client is a private dependency of @pharmax/database; importing " +
        "it directly bypasses the singleton, the tenancy extension, and " +
        "the type re-exports.",
    },
  ],
  patterns: [
    {
      group: [
        "**/generated/client/**",
        "@pharmax/database/src/generated/**",
        "@pharmax/database/**/generated/**",
      ],
      message:
        "The generated Prisma client is private to @pharmax/database. " +
        "Import from '@pharmax/database' instead.",
    },
  ],
};

// withSystemContext is the bootstrap-only escape hatch that disables
// tenant filtering and skips the RBAC check. Allowed call sites:
//
//   - @pharmax/tenancy   — definition + re-export
//   - @pharmax/command-bus — executeSystemCommand orchestrator
//   - apps/worker        — webhook drainers that bridge from
//                          tenant-less external systems (Stripe,
//                          EasyPost) to per-tenant commands. The
//                          system-context read resolves the
//                          (org, actor) pair; the subsequent
//                          command runs through the normal bus.
//   - scripts/           — operator CLIs (e.g. bootstrap-org)
//   - **/*.test.ts       — test fixtures
//
// Application **business logic** (apps/web, every domain package,
// every apps/worker file outside the drains/ bridge layer) MUST go
// through a command handler. A command handler in turn uses
// executeSystemCommand if it is a system command; the orchestrator
// is the one place that calls withSystemContext.
const SYSTEM_CONTEXT_RESTRICTION = {
  paths: [
    {
      name: "@pharmax/tenancy",
      importNames: ["withSystemContext"],
      message:
        "withSystemContext is the system-bootstrap escape hatch from " +
        "tenancy and RBAC. Allowed call sites: @pharmax/tenancy, " +
        "@pharmax/command-bus, scripts/, and *.test.ts. Application " +
        "code must go through a command handler. See " +
        "docs/ARCHITECTURE_PRINCIPLES.md §B.1.",
    },
  ],
};

// Combined restriction (default) — applies everywhere unless an
// override below relaxes it. `no-restricted-imports` is overridden
// (not merged) by later config blocks, so each zone re-states the
// full set of paths/patterns that should apply there.
const FULL_RESTRICTION = {
  paths: [...PRISMA_CLIENT_RESTRICTION.paths, ...SYSTEM_CONTEXT_RESTRICTION.paths],
  patterns: [...PRISMA_CLIENT_RESTRICTION.patterns],
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/generated/**",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node-runtime config files (build/runtime config that runs under
  // Node, not in the browser). Declares Node globals so `no-undef`
  // does not fire on `process`, `__dirname`, etc.
  //
  // Scope: top-level *.config.{js,mjs,cjs,ts} (vitest, next, postcss,
  // eslint itself), plus apps/*/next.config.* and apps/*/postcss.config.*.
  {
    files: [
      "*.config.{js,mjs,cjs,ts}",
      "**/next.config.{js,mjs,cjs,ts}",
      "**/postcss.config.{js,mjs,cjs,ts}",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        global: "readonly",
        console: "readonly",
        module: "readonly",
        require: "readonly",
      },
    },
  },

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-restricted-imports": ["error", FULL_RESTRICTION],
    },
  },

  // Override 1: @pharmax/database is the only package allowed to
  // import @prisma/client and the generated client path. Both bans
  // off here. (withSystemContext isn't used in this package; the
  // override is "everything off" for simplicity.)
  {
    files: ["packages/database/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },

  // Override 2: @pharmax/tenancy and @pharmax/command-bus are the
  // legitimate runtime homes for withSystemContext. Keep the Prisma
  // ban; drop the system-context ban.
  {
    files: ["packages/tenancy/**/*.{ts,tsx}", "packages/command-bus/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3: scripts/ are operator CLIs that legitimately drive
  // the bus from system context (bootstrap-org, etc.). Keep the
  // Prisma ban.
  {
    files: ["scripts/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3b: apps/worker/src/drains/** are the system-context
  // bridge layer for webhook ingestion. The flow is:
  //   1. Worker claims an inbound row (tenant-less).
  //   2. Worker wraps the lookup in withSystemContext so the Prisma
  //      tenancy extension passes the read through unmodified.
  //   3. Worker resolves (organizationId, actorUserId) and enters
  //      that tenancy via withTenancyContext, then dispatches the
  //      domain command via executeCommand.
  // The system-context use is infrastructure plumbing, not business
  // logic. Keep the Prisma ban; drop the system-context ban.
  {
    files: ["apps/worker/src/drains/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 4: tests legitimately set up tenancy/system context as
  // fixtures and may exercise both code paths. Keep the Prisma ban.
  // Tests inside @pharmax/database are excluded — they validate the
  // generated client itself and must reach into ./generated/.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test-helpers.ts"],
    ignores: ["packages/database/**"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  prettier
);
