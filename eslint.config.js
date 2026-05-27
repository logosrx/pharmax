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
//   - apps/worker/src/drains/   — webhook drainers that bridge from
//                                 tenant-less external systems
//                                 (Stripe, EasyPost) to per-tenant
//                                 commands. The system-context read
//                                 resolves the (org, actor) pair;
//                                 the subsequent command runs
//                                 through the normal bus.
//   - apps/worker/src/security/ — cross-tenant integrity/security
//                                 cron jobs (daily Merkle root,
//                                 digest probes) that must fan
//                                 out across ALL organizations.
//                                 By definition cannot enter any
//                                 single tenancy frame because the
//                                 job itself is the enumeration.
//                                 Same shape as drains/: bridge
//                                 layer, not business logic.
//   - apps/worker/src/compliance/ — quarterly access-review job and
//                                 supporting aggregators. SOC 2
//                                 CC6.2 + HIPAA § 164.308(a)(4)
//                                 require periodic cross-org review
//                                 of who has access to what. Reads
//                                 are aggregate-only (counts, never
//                                 PHI payloads); the enumeration of
//                                 ALL organizations is the job.
//                                 Same shape as security/: bridge
//                                 layer, infrastructure output (an
//                                 evidence artifact + notification),
//                                 no per-tenant actor and no order
//                                 aggregate to gate through a
//                                 command handler.
//   - apps/web/src/server/auth/ — Clerk identity → Pharmax tenancy
//                                 resolution (see Override 3c).
//   - scripts/           — operator CLIs (e.g. bootstrap-org)
//   - **/*.test.ts       — test fixtures
//
// Application **business logic** (apps/web outside auth/, every
// domain package, every apps/worker file outside the drains/,
// security/, and compliance/ bridge layers) MUST go through a
// command handler. A command handler in turn uses
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
  // the bus from system context (bootstrap-org, validate-registry,
  // migrate-allowlist, etc.). Two relaxations apply here:
  //   - `no-restricted-imports`: scripts may import @pharmax/tenancy
  //     and call withSystemContext directly (that's the whole point
  //     — they're tenant-less operator tooling).
  //   - `no-console`: scripts produce human-readable stdout (progress
  //     messages, summary tables, exit-code rationale). Replacing
  //     console.log with a structured logger here would hurt the
  //     CLI UX without buying any safety, since these binaries
  //     never run in a production request path. The Prisma ban is
  //     preserved so scripts still go through the repository layer.
  {
    files: ["scripts/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
      "no-console": "off",
    },
  },

  // Override 3c: apps/web/src/server/auth/** is the system-context
  // bridge layer for the Clerk identity → Pharmax tenancy hop.
  // Same shape as the worker drain bridge (3b): a tenant-less
  // external identifier (Clerk userId) resolves to the Pharmax
  // user row inside a system-context frame, then every downstream
  // call runs inside the resolved tenancy. Without this override,
  // the resolver can't read the `user` table because there is
  // no tenancy frame established yet by definition.
  {
    files: ["apps/web/src/server/auth/**/*.{ts,tsx}"],
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

  // Override 3d: apps/worker/src/security/** are cross-tenant
  // integrity and security cron jobs. The flow is:
  //   1. Scheduler tick fires (tenant-less by definition).
  //   2. Job enumerates ALL organizations via withSystemContext
  //      (`prisma.organization.findMany`) — the enumeration IS
  //      the job; entering one tenancy frame would defeat it.
  //   3. For each org, the job reads chain rows / verifies the
  //      Merkle root / fetches outbox-dead counts under
  //      withSystemContext so the Prisma tenancy extension
  //      passes the per-org filter through unmodified.
  // Same shape as drains/: bridge layer, not business logic — the
  // signed Merkle manifest and digest report are infrastructure
  // outputs, not state transitions. No domain command pattern
  // applies because there is no per-tenant actor and no order
  // aggregate. Keep the Prisma ban; drop the system-context ban.
  {
    files: ["apps/worker/src/security/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3e: apps/worker/src/compliance/** is the quarterly
  // access-review job and its aggregators (command_log / audit_log
  // counts, anomaly detection, evidence publisher, notifier). The
  // flow mirrors security/:
  //   1. Daily scheduler tick fires (tenant-less by definition).
  //   2. On quarter boundary, job walks ALL organizations via
  //      withSystemContext — the enumeration IS the job.
  //   3. Per organization, the job runs aggregate-only reads
  //      (groupBy / count) on command_log + audit_log; never
  //      SELECTs the JSON payloads. PHI invariant preserved by
  //      "we only read counts" not "we run under tenancy".
  //   4. Output is a JSONL evidence artifact + a markdown summary
  //      + one notification per org — infrastructure outputs, not
  //      state transitions. No order aggregate to gate; no
  //      per-tenant actor.
  // Same shape as security/ and drains/. Keep the Prisma ban; drop
  // the system-context ban.
  {
    files: ["apps/worker/src/compliance/**/*.{ts,tsx}"],
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
