// Flat config for ESLint 10.
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
//   - packages/auth/     — in-house identity engine; every entry
//                          point is pre-tenant by definition
//                          (see Override 3i).
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
      // Drill/audit evidence artifacts (gitignored): one-off scripts
      // captured for the evidence record, not maintained source code.
      "evidence/**",
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

  // Override 3a: prisma/seed.ts is the database seed — a
  // system-bootstrap entry point that creates the org the tenancy
  // frames would scope to, the same category as scripts/. It
  // legitimately calls withSystemContext (and prints progress to
  // stdout, hence the file-level eslint-disable for no-console).
  // The Prisma-client ban stays in force.
  {
    files: ["prisma/seed.ts"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
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

  // Override 3c-portal: apps/web/src/server/portal/** is the portal
  // twin of the auth bridge above (3c) — the portal-cookie →
  // portal-session → provider-identity hop (ADR-0033 slice 2), plus
  // the public application-status lookup where the applicant has no
  // principal at all (the unguessable application id is the
  // capability). No tenancy frame can exist before these resolutions
  // by definition. Keep the Prisma ban; drop the system-context ban.
  {
    files: ["apps/web/src/server/portal/**/*.{ts,tsx}"],
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

  // Override 3f: apps/worker/src/metrics/** are cross-tenant
  // observability scrapers. The flow mirrors security/ and
  // compliance/:
  //   1. A poll-loop tick fires (tenant-less by definition).
  //   2. The tick runs aggregate-only reads (groupBy / count) across
  //      ALL organizations via withSystemContext — the cross-tenant
  //      enumeration IS the scrape; entering one tenancy frame would
  //      defeat the gauge.
  //   3. The result populates OTel gauge label tuples limited to
  //      `stage`, `bucket`, `organization_id` (opaque UUID). No PHI:
  //      no order ids, no patient ids, no JSON payloads.
  // Same shape as security/ and compliance/ — infrastructure
  // telemetry, not state transitions, no order aggregate to gate.
  // Keep the Prisma ban; drop the system-context ban.
  {
    files: ["apps/worker/src/metrics/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3g: apps/worker/src/notifications/** is the persistent
  // NotificationDeliveryStore wired into PersistentNotificationChannel
  // at boot. The worker's notify handler fans out cross-tenant in one
  // outbox tick and has no per-request tenancy frame, so the store
  // runs its upsert/update under withSystemContext. The
  // `organizationId` is carried explicitly on every call, so rows
  // land tenant-scoped (RLS WITH CHECK still validates the non-null
  // column) — the GUC is in system mode only because there is no
  // single tenant to enter. Same shape as drains/. Keep the Prisma
  // ban; drop the system-context ban.
  {
    files: ["apps/worker/src/notifications/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3h: apps/web/app/api/webhooks/** are inbound webhook
  // receivers (Clerk, Stripe, EasyPost, Resend). They are tenant-less
  // by definition — the HTTP caller is a third party with no operator
  // session. The established pattern is: verify signature, write an
  // idempotency-ledger row, and either defer to a worker drain (Clerk,
  // Stripe, EasyPost) OR apply a tenant-scoped *projection* update
  // resolved by a globally-unique provider id (Resend's
  // notification_delivery status). Both motions require
  // withSystemContext because there is no operator GUC to enter; the
  // target row carries its own org and RLS WITH CHECK validates it.
  // CONSTRAINT: webhook routes may only write idempotency ledgers and
  // delivery/status projections here — any business state transition
  // MUST go through a command handler (dispatched from a worker drain
  // under Override 3b). Keep the Prisma ban; drop the system-context
  // ban.
  {
    files: ["apps/web/app/api/webhooks/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3h-portal: apps/web/app/api/portal/** are the public
  // provider-portal API routes (ADR-0033) — pre-credential by
  // definition, the same tenant-less-caller shape as the webhook
  // receivers above. The apply route resolves (org, machine actor)
  // from the submitted slug in system context, then dispatches
  // through the normal bus inside the resolved tenancy; the auth
  // routes bridge an emailed token / portal cookie to a frame. Any
  // business state transition still goes through a command handler.
  // Keep the Prisma ban; drop the system-context ban.
  {
    files: ["apps/web/app/api/portal/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3i: packages/auth/** is the in-house identity engine
  // (ADR-0030) — the successor to the Clerk bridge that Override 3c
  // covers in apps/web/src/server/auth/**. Every entry point here is
  // PRE-TENANT by definition:
  //   - SignIn resolves an email to a user row BEFORE any tenancy
  //     exists (the org is discovered FROM the user row).
  //   - LoginAttempt rows must be writable for lockout / rate-limit
  //     counting even when the email matches NO user (organizationId
  //     is nullable by design).
  //   - Session resolution turns an opaque token hash into the
  //     (org, user) pair that BECOMES the tenancy frame.
  //   - Password-reset / invite tokens are presented by callers with
  //     no session at all; the token row is the only bridge.
  // Same shape as 3b/3c: infrastructure bridge from a tenant-less
  // identifier to a tenancy frame, not business logic — workflow
  // state never moves here. Keep the Prisma ban; drop the
  // system-context ban.
  {
    files: ["packages/auth/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3j: two NAMED partner-api bridge modules (ADR-0032) —
  // the same pre-tenant shape as 3i, deliberately scoped to the two
  // files rather than the package:
  //   - api-key/resolve-api-key.ts turns an opaque bearer-token hash
  //     into the (org, key) pair that BECOMES the tenancy frame —
  //     the partner-path twin of packages/auth session resolution.
  //   - webhooks/fan-out.ts is called from the worker's outbox drain
  //     (itself an allowed bridge zone) and must read subscriptions
  //     across the org the CLAIMED row belongs to before any frame
  //     exists; the WHERE is explicitly org-scoped.
  // Everything else in the package (commands/, signing, transport)
  // stays under the full ban — commands go through the bus like any
  // domain package. Keep the Prisma ban; drop the system-context ban.
  {
    files: [
      "packages/partner-api/src/api-key/resolve-api-key.ts",
      "packages/partner-api/src/webhooks/fan-out.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3k: the print-agent's ONE boot-time bridge module —
  // the same pre-tenant shape as 3b/3c/3i, deliberately scoped to
  // the single file rather than the app:
  //   - resolve-runtime-context.ts turns the agent's tenant-less
  //     configuration (org slug + workstation code + actor email
  //     env vars) into the (org, workstation, actor) tuple that
  //     BECOMES the tenancy frame every subsequent poll-loop tick
  //     runs in via withTenancyContext. No frame can exist before
  //     this resolution by definition (chicken-and-egg).
  // Everything else in the app stays under the full ban — print-job
  // processing dispatches through the command bus inside the
  // resolved tenancy. Keep the Prisma ban; drop the system-context
  // ban.
  {
    files: ["apps/print-agent/src/resolve-runtime-context.ts"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3l: the break-glass Prisma adapter — ONE named module,
  // same deliberately-narrow scoping as 3j/3k. The break_glass_session
  // and break_glass_action tables are platform-level and RLS-exempt
  // by definition (see the module's SCHEMA.md): a break-glass session
  // is opened precisely because normal tenancy/RBAC paths are
  // unavailable, so there is no tenant frame to enter. The adapter
  // wraps every write in withSystemContext so the tenancy layer
  // records WHY a cross-tenant touch happened, and the session
  // wrapper in break-glass-session.ts is itself the audit mechanism
  // (per-operation action ledger). Everything else in
  // packages/security stays under the full ban. Keep the Prisma ban;
  // drop the system-context ban.
  {
    files: ["packages/security/src/break-glass/prisma-break-glass-client.ts"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3m: the nightly payment-ledger reconciliation verifier —
  // ONE named module, same cross-tenant integrity-cron shape as the
  // security/ jobs in 3d:
  //   1. A daily scheduler tick fires (tenant-less by definition).
  //   2. The job enumerates ALL organizations via withSystemContext —
  //      the cross-tenant sweep IS the job.
  //   3. Per org, it runs READ-ONLY parity checks (payment-ledger
  //      sums vs invoice projections) and emits logs + counters. No
  //      writes, no state transitions, no order aggregate to gate.
  // Deliberately scoped to the single file so the rest of
  // apps/worker/src/billing (Stripe adapters and any future business
  // logic) stays under the full ban. Keep the Prisma ban; drop the
  // system-context ban.
  {
    files: ["apps/worker/src/billing/payment-ledger-reconciliation-loop.ts"],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3n: the provider-portal auth bridge modules (ADR-0033
  // slice 2) — the portal twin of packages/auth (3i), deliberately
  // scoped to the four named files rather than the package. Every one
  // is PRE-TENANT by definition:
  //   - portal/session.ts turns an opaque portal-token hash into the
  //     (org, portalAccount, provider) tuple that BECOMES the frame —
  //     structurally identical to packages/auth session resolution.
  //   - portal/sign-in.ts orchestrates the PortalSignIn system command
  //     (rate limits + shared login_attempt lockout ledger) with no
  //     session yet in hand.
  //   - portal/setup-account.ts wraps the SetupPortalAccount system
  //     command — the caller holds only the emailed one-time token.
  //   - portal/issue-setup-token.ts wraps IssuePortalSetupToken; it
  //     runs post-commit from approval flows to mint the token whose
  //     raw value must never ride an event or command log.
  //   - portal/change-password.ts wraps ChangePortalPassword (slice
  //     3); the portal principal has no tenant frame — the wrapper is
  //     the same pre-tenant bridge shape as setup-account.ts.
  // Everything else in packages/providers (onboarding commands,
  // portal/provision.ts, portal/sign-in-command.ts, etc.) stays under
  // the full ban — they run inside the bus. Keep the Prisma ban; drop
  // the system-context ban.
  {
    files: [
      "packages/providers/src/portal/session.ts",
      "packages/providers/src/portal/sign-in.ts",
      "packages/providers/src/portal/setup-account.ts",
      "packages/providers/src/portal/issue-setup-token.ts",
      "packages/providers/src/portal/change-password.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", PRISMA_CLIENT_RESTRICTION],
    },
  },

  // Override 3o: the daily invoice auto-finalize loop. The flow
  // mirrors the reconciliation loop in 3m:
  //   1. Daily scheduler tick fires (tenant-less by definition).
  //   2. The loop enumerates ALL organizations via withSystemContext —
  //      the cross-tenant sweep IS the job — and runs a READ-ONLY
  //      scan per org (period-ended DRAFT invoices + approval state).
  //   3. Every WRITE goes through executeSystemCommand
  //      (AutoFinalizeDueInvoice) — full command_log / audit /
  //      outbox ritual inside the command's own tx. The loop itself
  //      never mutates rows; withSystemContext only brackets the
  //      scan and the dispatch, exactly like drains/ bridge code.
  // Deliberately scoped to the single file so the rest of
  // apps/worker/src/billing stays under the full ban. Keep the
  // Prisma ban; drop the system-context ban.
  {
    files: ["apps/worker/src/billing/invoice-auto-finalize-loop.ts"],
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
