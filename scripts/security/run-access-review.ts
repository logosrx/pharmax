#!/usr/bin/env tsx
// scripts/security/run-access-review.ts
//
// Quarterly access review generator (SOC 2 CC6.2 evidence).
//
// Reads the @pharmax/rbac tables for the target organization and
// writes a structured JSON snapshot of every (user → role → scope →
// permission) assignment, plus a reviewer's-eye summary, to:
//
//   evidence/access-reviews/<YYYY-Q#>/<org-slug>.json
//
// Pair the generated file with the human sign-off process documented
// in `packages/security/src/access-review/README.md`.
//
// Usage:
//   pnpm tsx scripts/security/run-access-review.ts \
//     --org=<organization-uuid> \
//     [--out-dir=evidence/access-reviews/<YYYY-Q#>] \
//     [--dry-run]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars (KMS adapter probes the
//                             seed at boot; we wire it even though
//                             this script does not encrypt anything).
//
// Exits:
//   0  report generated (or printed in dry-run mode).
//   1  validation error / org not found / unexpected failure.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";
import {
  generateAccessReview,
  OrganizationNotFoundForAccessReviewError,
  type AccessReviewClient,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm tsx scripts/security/run-access-review.ts \\
  --org=<organization-uuid> \\
  [--out-dir=evidence/access-reviews/<YYYY-Q#>] \\
  [--dry-run]

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars; must match apps/web + apps/worker.
`.trim();

interface ParsedArgs {
  readonly orgId: string;
  readonly outDir?: string;
  readonly dryRun: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      org: { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (typeof values.org !== "string" || values.org.length === 0) {
    process.stderr.write(`--org is required.\n\n${USAGE}\n`);
    process.exit(1);
  }
  return {
    orgId: values.org,
    ...(typeof values["out-dir"] === "string" ? { outDir: values["out-dir"] } : {}),
    dryRun: values["dry-run"] === true,
  };
}

function currentQuarterLabel(now: Date): string {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

function buildAccessReviewClient(): AccessReviewClient {
  return {
    async loadOrganization({ organizationId }) {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, slug: true },
      });
      return org === null ? null : { id: org.id, slug: org.slug };
    },
    async loadUsersWithRoles({ organizationId }) {
      const users = await prisma.user.findMany({
        where: { organizationId },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          clerkUserId: true,
          lastLoginAt: true,
          userRoles: {
            select: {
              id: true,
              createdAt: true,
              organizationId: true,
              siteId: true,
              clinicId: true,
              teamId: true,
              role: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  scope: true,
                  rolePermissions: {
                    select: { permission: { select: { code: true } } },
                  },
                },
              },
            },
          },
        },
      });
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        status: u.status,
        clerkUserId: u.clerkUserId,
        lastLoginAt: u.lastLoginAt,
        userRoles: u.userRoles.map((ur) => ({
          id: ur.id,
          createdAt: ur.createdAt,
          organizationId: ur.organizationId,
          siteId: ur.siteId,
          clinicId: ur.clinicId,
          teamId: ur.teamId,
          role: {
            id: ur.role.id,
            code: ur.role.code,
            name: ur.role.name,
            scope: ur.role.scope,
            rolePermissions: ur.role.rolePermissions.map((rp) => ({
              permission: { code: rp.permission.code },
            })),
          },
        })),
      }));
    },
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  const databaseUrl = process.env["DATABASE_URL"];
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  const logger = loggerNs.createPinoLogger({
    service: "run-access-review",
    level: "info",
  });

  const now = new Date();
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 90 * 86_400_000);

  let report;
  try {
    report = await withSystemContext("security:access-review", () =>
      generateAccessReview({
        organizationId: args.orgId,
        periodStart,
        periodEnd,
        client: buildAccessReviewClient(),
        now,
      })
    );
  } catch (cause) {
    if (cause instanceof OrganizationNotFoundForAccessReviewError) {
      logger.error("access-review.org_not_found", { organizationId: args.orgId });
      process.stderr.write(`Organization ${args.orgId} not found.\n`);
      await prisma.$disconnect();
      process.exit(1);
    }
    throw cause;
  }

  const outDir =
    args.outDir ?? resolve(process.cwd(), "evidence", "access-reviews", currentQuarterLabel(now));
  const outPath = resolve(outDir, `${report.organizationSlug}.json`);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    logger.info("access-review.dry_run", {
      organizationId: args.orgId,
      totalPrincipals: report.summary.totalPrincipals,
      elevated: report.summary.principalsWithElevatedRoles.length,
      stale: report.summary.staleAssignments.length,
    });
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${outPath}\n`);
    logger.info("access-review.written", {
      outPath,
      organizationId: args.orgId,
      totalPrincipals: report.summary.totalPrincipals,
    });
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
