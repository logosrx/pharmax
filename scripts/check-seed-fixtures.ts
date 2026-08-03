#!/usr/bin/env tsx
// scripts/check-seed-fixtures.ts
//
// Post-seed assertion that the demo dataset is COMPLETE, not merely
// that `prisma/seed.ts` exited 0.
//
// Why this exists. On 2026-08-02 the ADR-0033 provider portal was found
// merged without its seed wiring: the onboarding package, the portal API
// routes, the role templates and the worker's proofing drain were all on
// main, but `prisma/seed.ts` had never received the fixtures that make
// them reachable. A freshly seeded org had `providerOnboardingEnabled`
// at its default of false (so the public apply endpoint rejected every
// request), no portal or onboarding service identity, and no
// `provider.onboarding` workflow policy for applications to pin
// `workflowPolicyId` + version against.
//
// Nothing caught it, for a reason worth naming: a seed that OMITS a
// fixture still exits 0. Running the seed proves it isn't broken; it
// cannot prove it isn't incomplete. Completeness needs assertions, and
// these are them.
//
// What is checked:
//
//   1. ROLE COVERAGE — every `ROLE_TEMPLATES` code has a Role row in
//      the demo org. Catches a template added to @pharmax/rbac that
//      the seed never materializes.
//   2. SERVICE IDENTITIES — each machine actor the runtime resolves by
//      email at boot exists AND carries at least one role grant. An
//      identity with no grant authenticates and then fails every
//      permission check, which is harder to debug than a missing user.
//   3. WORKFLOW POLICIES — every policy code the commands pin against
//      exists and is ACTIVE. A verification or application record
//      cannot store `workflowPolicyId` + version without it.
//   4. BOOT-CRITICAL IDENTITY — the org slug and workstation code
//      apps/print-agent resolves at startup. Its production
//      crash-loop that same day was exactly this lookup failing
//      against fixture values, so the seed must keep providing them
//      for the local path to work at all.
//
// Exit codes:
//   0  Demo dataset is complete.
//   1  One or more fixtures missing.
//   2  Internal error (database unreachable / query failure).
//
// Pairs with: scripts/check-migration-rls.ts (RLS coverage),
// scripts/check-package-layers.ts (dependency graph).

import process from "node:process";
import { fileURLToPath } from "node:url";

import { prisma } from "@pharmax/database";
import { ROLE_TEMPLATES } from "@pharmax/rbac";
import { withSystemContext } from "@pharmax/tenancy";

/** The org `prisma/seed.ts` creates, and that apps resolve locally. */
const DEMO_ORG_SLUG = "acme";

/**
 * Machine actors the runtime resolves by email. Each must exist and hold
 * at least one role grant.
 */
const EXPECTED_SERVICE_IDENTITIES: ReadonlyArray<{
  readonly email: string;
  readonly why: string;
}> = [
  {
    email: `provider-onboarding@${DEMO_ORG_SLUG}.test`,
    why: "public apply endpoint + worker NPPES proofing drain (ADR-0033)",
  },
  {
    email: `provider-portal@${DEMO_ORG_SLUG}.test`,
    why: "portal profile route dispatching UpdateProvider (ADR-0033 slice 3)",
  },
  {
    email: `print-agent@${DEMO_ORG_SLUG}.test`,
    why: "apps/print-agent polling loop confirming thermal print jobs",
  },
];

/** Workflow policy codes the commands pin `workflowPolicyId` against. */
const EXPECTED_WORKFLOW_POLICIES: ReadonlyArray<{
  readonly code: string;
  readonly why: string;
}> = [
  { code: "order.standard", why: "order workflow verification records" },
  { code: "provider.onboarding", why: "onboarding application records (ADR-0033)" },
];

/** Workstation code apps/print-agent resolves at boot. */
const EXPECTED_WORKSTATION_CODE = "WS-01";

/** A single missing or misconfigured fixture. */
export interface FixtureViolation {
  readonly fixture: string;
  readonly detail: string;
}

/** Everything the checker needs, already read out of the database. */
export interface SeedSnapshot {
  readonly orgFound: boolean;
  readonly providerOnboardingEnabled: boolean;
  readonly roleCodes: ReadonlyArray<string>;
  /** email -> number of role grants held. Absent key means no such user. */
  readonly serviceIdentityGrants: Readonly<Record<string, number>>;
  /** Codes of ACTIVE workflow policies. */
  readonly activeWorkflowPolicyCodes: ReadonlyArray<string>;
  readonly workstationCodes: ReadonlyArray<string>;
}

/**
 * Pure evaluation so the rules are unit-testable without a database.
 */
export function evaluateSeedSnapshot(
  snapshot: SeedSnapshot,
  roleTemplateCodes: ReadonlyArray<string>
): ReadonlyArray<FixtureViolation> {
  const violations: FixtureViolation[] = [];

  if (!snapshot.orgFound) {
    // Nothing downstream is meaningful without the org, so report once
    // and stop rather than emitting a cascade of derived failures.
    return [
      {
        fixture: `organization "${DEMO_ORG_SLUG}"`,
        detail: "not found — did `pnpm db:seed` run against this database?",
      },
    ];
  }

  if (!snapshot.providerOnboardingEnabled) {
    violations.push({
      fixture: "organization.providerOnboardingEnabled",
      detail:
        "false — the public provider apply endpoint rejects every request. " +
        "The demo org must opt in (ADR-0033) for the flow to be exercisable.",
    });
  }

  const presentRoles = new Set(snapshot.roleCodes);
  for (const code of roleTemplateCodes) {
    if (!presentRoles.has(code)) {
      violations.push({
        fixture: `role "${code}"`,
        detail:
          "declared in ROLE_TEMPLATES (@pharmax/rbac) but not seeded. " +
          "seedDemoOrganization materializes every template; a gap here means " +
          "the loop was bypassed or the template was added without reseeding.",
      });
    }
  }

  for (const { email, why } of EXPECTED_SERVICE_IDENTITIES) {
    const grants = snapshot.serviceIdentityGrants[email];
    if (grants === undefined) {
      violations.push({
        fixture: `service identity "${email}"`,
        detail: `missing — needed by ${why}.`,
      });
    } else if (grants === 0) {
      violations.push({
        fixture: `service identity "${email}"`,
        detail:
          `exists but holds no role grant, so it authenticates and then fails ` +
          `every permission check. Needed by ${why}.`,
      });
    }
  }

  const activePolicies = new Set(snapshot.activeWorkflowPolicyCodes);
  for (const { code, why } of EXPECTED_WORKFLOW_POLICIES) {
    if (!activePolicies.has(code)) {
      violations.push({
        fixture: `workflow policy "${code}"`,
        detail:
          `missing or not ACTIVE — ${why} cannot store workflowPolicyId + version ` + "without it.",
      });
    }
  }

  if (!snapshot.workstationCodes.includes(EXPECTED_WORKSTATION_CODE)) {
    violations.push({
      fixture: `workstation "${EXPECTED_WORKSTATION_CODE}"`,
      detail:
        "missing — apps/print-agent resolves its workstation by this code at " +
        "boot and exits fatally when the lookup fails.",
    });
  }

  return violations;
}

async function readSnapshot(): Promise<SeedSnapshot> {
  const org = await prisma.organization.findUnique({
    where: { slug: DEMO_ORG_SLUG },
    select: { id: true, providerOnboardingEnabled: true },
  });

  if (org === null) {
    return {
      orgFound: false,
      providerOnboardingEnabled: false,
      roleCodes: [],
      serviceIdentityGrants: {},
      activeWorkflowPolicyCodes: [],
      workstationCodes: [],
    };
  }

  const [roles, users, policies, workstations] = await Promise.all([
    prisma.role.findMany({ where: { organizationId: org.id }, select: { code: true } }),
    prisma.user.findMany({
      where: {
        organizationId: org.id,
        email: { in: EXPECTED_SERVICE_IDENTITIES.map((s) => s.email) },
      },
      select: { email: true, _count: { select: { userRoles: true } } },
    }),
    prisma.workflowPolicy.findMany({
      where: { organizationId: org.id, status: "ACTIVE" },
      select: { code: true },
    }),
    prisma.workstation.findMany({
      where: { organizationId: org.id },
      select: { code: true },
    }),
  ]);

  const serviceIdentityGrants: Record<string, number> = {};
  for (const user of users) {
    serviceIdentityGrants[user.email] = user._count.userRoles;
  }

  return {
    orgFound: true,
    providerOnboardingEnabled: org.providerOnboardingEnabled,
    roleCodes: roles.map((r) => r.code),
    serviceIdentityGrants,
    activeWorkflowPolicyCodes: policies.map((p) => p.code),
    workstationCodes: workstations.map((w) => w.code),
  };
}

async function main(): Promise<void> {
  // Cross-tenant read, so it runs in an explicit system context — same
  // posture as prisma/seed.ts and scripts/bootstrap-org.ts.
  const snapshot = await withSystemContext("check:seed-fixtures", readSnapshot);

  const templateCodes = ROLE_TEMPLATES.map((t) => t.code);
  const violations = evaluateSeedSnapshot(snapshot, templateCodes);

  if (violations.length > 0) {
    process.stderr.write(
      `[check-seed-fixtures] ${violations.length} incomplete fixture(s) in the demo dataset:\n`
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.fixture}\n    ${v.detail}\n`);
    }
    process.stderr.write(
      "    The seed exiting 0 does not mean it is complete. Add the missing\n" +
        "    fixture to prisma/seed.ts (seedDemoOrganization) and reseed.\n"
    );
    process.exit(1);
  }

  process.stdout.write(
    `[check-seed-fixtures] ok — ${templateCodes.length} role(s), ` +
      `${EXPECTED_SERVICE_IDENTITIES.length} service identity(ies), ` +
      `${EXPECTED_WORKFLOW_POLICIES.length} workflow policy(ies) present\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main()
    .catch((err) => {
      process.stderr.write(`[check-seed-fixtures] internal error: ${String(err)}\n`);
      process.exit(2);
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
