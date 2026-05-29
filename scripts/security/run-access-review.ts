#!/usr/bin/env tsx
// scripts/security/run-access-review.ts
//
// Quarterly access review generator (SOC 2 CC6.2 evidence).
//
// Reads the @pharmax/rbac tables for the target organization and
// produces a structured snapshot of every (user → role → scope →
// permission) assignment plus a reviewer's-eye summary.
//
// Two persistence modes (run in this order):
//
//   1. Database (canonical): dispatches the `RecordAccessReviewSnapshot`
//      tenant command, which writes an immutable
//      `access_review_snapshot` row keyed by SHA-256 digest of the
//      report, emits the `compliance.access_review_snapshot.recorded.v1`
//      outbox event, and writes the matching audit_log + command_log
//      entries. This is the row a SOC 2 auditor relies on.
//
//   2. JSON file (evidence pack): also writes the same report to
//      `evidence/access-reviews/<YYYY-Q#>/<org-slug>.json` so the
//      file can be attached to a reviewer's sign-off page in the
//      external evidence repository. The on-disk file is byte-
//      identical to the JSON column on the DB row (canonical
//      stringify + the same `report` content).
//
// Operator identity: the snapshot row records the operator who ran
// the CLI in `recordedByUserId`. The operator must have the
// `compliance.access_review.record` permission (granted to OrgAdmin
// by default; the dedicated SecurityOfficer role template will be
// added as separate work).
//
// Usage:
//   pnpm tsx scripts/security/run-access-review.ts \
//     --org=<organization-uuid> \
//     --as-user=<operator-email> \
//     [--out-dir=evidence/access-reviews/<YYYY-Q#>] \
//     [--dry-run]                # do not write DB row, do not write file
//     [--skip-db]                # write the JSON file only (back-compat)
//     [--skip-file]              # write the DB row only (CI smoke checks)
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars (KMS adapter probes the
//                             seed at boot; we wire it even though
//                             this script does not encrypt anything).
//
// Exits:
//   0  report generated (DB row + JSON file unless flags requested otherwise).
//   1  validation error / org or user not found / RBAC denial / unexpected failure.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configureCommandBus, executeCommand } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { clock, errors, ids, logger as loggerNs } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import {
  generateAccessReview,
  OrganizationNotFoundForAccessReviewError,
  RecordAccessReviewSnapshot,
  type AccessReviewClient,
} from "@pharmax/security";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm tsx scripts/security/run-access-review.ts \\
  --org=<organization-uuid> \\
  --as-user=<operator-email> \\
  [--out-dir=evidence/access-reviews/<YYYY-Q#>] \\
  [--dry-run] [--skip-db] [--skip-file]

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars; must match apps/web + apps/worker.
`.trim();

interface ParsedArgs {
  readonly orgId: string;
  readonly asUserEmail: string;
  readonly outDir?: string;
  readonly dryRun: boolean;
  readonly skipDb: boolean;
  readonly skipFile: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      org: { type: "string" },
      "as-user": { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "skip-db": { type: "boolean", default: false },
      "skip-file": { type: "boolean", default: false },
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
  const dryRun = values["dry-run"] === true;
  const asUserEmail = typeof values["as-user"] === "string" ? values["as-user"] : "";
  if (!dryRun && asUserEmail.length === 0) {
    process.stderr.write(
      `--as-user=<operator-email> is required (omit only with --dry-run).\n\n${USAGE}\n`
    );
    process.exit(1);
  }
  return {
    orgId: values.org,
    asUserEmail,
    ...(typeof values["out-dir"] === "string" ? { outDir: values["out-dir"] } : {}),
    dryRun,
    skipDb: values["skip-db"] === true,
    skipFile: values["skip-file"] === true,
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

  // The DB write path needs the bus + RBAC configured. The JSON-only
  // path can skip these, but we configure unconditionally so a
  // future flip from --skip-db to dispatch-only doesn't require
  // re-bootstrapping the script.
  configureCommandBus({ prisma, clock: clock.systemClock, logger });
  configureRbac({ loader: new PrismaPermissionLoader(prisma) });

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

  // -----------------------------------------------------------
  // 1. Persist to the database via the command bus (canonical).
  // -----------------------------------------------------------
  let snapshotId: string | null = null;
  let digestSha256: string | null = null;

  if (!args.dryRun && !args.skipDb) {
    const operator = await withSystemContext("security:access-review:user-lookup", async () => {
      return prisma.user.findFirst({
        where: { organizationId: args.orgId, email: args.asUserEmail },
        select: { id: true, organizationId: true, status: true },
      });
    });
    if (operator === null) {
      process.stderr.write(
        `No user with email "${args.asUserEmail}" found in organization ${args.orgId}. ` +
          `The operator must exist in the target org to record an access-review snapshot.\n`
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    if (operator.status !== "ACTIVE") {
      process.stderr.write(
        `User "${args.asUserEmail}" is not ACTIVE (status=${operator.status}). Aborting.\n`
      );
      await prisma.$disconnect();
      process.exit(1);
    }

    const tenancy = buildTenancyContext({
      organizationId: operator.organizationId,
      actor: { userId: operator.id, correlationId: ids.generateUlid() },
    });

    // Idempotency key collapses a same-quarter re-run of the same
    // org under the same operator into a no-op replay (returns the
    // cached snapshot id rather than producing a new row). Operators
    // who genuinely want a fresh row can use --dry-run + a manual
    // dispatch with a new key, or wait for the next quarter.
    const idempotencyKey = `cli:access-review:${currentQuarterLabel(now)}:${args.orgId}:${operator.id}`;

    try {
      const out = await withTenancyContext(tenancy, () =>
        executeCommand(
          RecordAccessReviewSnapshot,
          { organizationId: args.orgId, report },
          { idempotencyKey }
        )
      );
      snapshotId = out.snapshotId;
      digestSha256 = out.digestSha256;
      logger.info("access-review.recorded", {
        snapshotId,
        digestSha256,
        organizationId: args.orgId,
        totalPrincipals: out.totalPrincipals,
        elevatedPrincipalCount: out.elevatedPrincipalCount,
        inactivePrincipalCount: out.inactivePrincipalCount,
        staleAssignmentCount: out.staleAssignmentCount,
        cryptoShredCapableRoleCount: out.cryptoShredCapableRoleCount,
      });
    } catch (cause: unknown) {
      if (cause instanceof errors.PharmaxError) {
        logger.error("access-review.record_failed", {
          code: cause.code,
          category: cause.category,
          message: cause.message,
        });
        process.stderr.write(`\n[${cause.code}] ${cause.message}\n`);
      } else {
        logger.error("access-review.record_failed.unknown", {
          errorName: cause instanceof Error ? cause.name : "Unknown",
          errorMessage: cause instanceof Error ? cause.message : String(cause),
        });
        process.stderr.write(`\nUnexpected error while recording the snapshot.\n`);
      }
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    }
  }

  // -----------------------------------------------------------
  // 2. JSON evidence pack (dual-write).
  // -----------------------------------------------------------
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
  } else if (!args.skipFile) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${outPath}\n`);
    logger.info("access-review.written", {
      outPath,
      organizationId: args.orgId,
      snapshotId,
      digestSha256,
      totalPrincipals: report.summary.totalPrincipals,
    });
  } else {
    // skip-file: emit the snapshot id + digest on stdout so CI can
    // pipe it into the next step (e.g. evidence-pack uploader).
    if (snapshotId !== null && digestSha256 !== null) {
      process.stdout.write(`${snapshotId}\t${digestSha256}\n`);
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
