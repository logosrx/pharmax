#!/usr/bin/env tsx
// scripts/soc2/export-user-roster.ts
//
// SOC 2 evidence script. Exports the full user roster (one row per
// Pharmax user) with role memberships, Clerk linkage status, MFA
// enrollment flag, and last-login timestamp. Used as primary evidence
// for CC6.1-1 (identity established before access) and CC6.5-1
// (deprovisioning on termination).
//
// PHI posture: this script writes opaque UUIDs for `id`,
// `organizationId`, and `roleId`. `email` and `displayName` ARE
// emitted because the auditor needs to confirm that the named
// reviewer recognizes the principal — these are operator identifiers
// (workforce), not patient PHI.
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-user-roster.ts \
//     --from=<YYYY-MM-DD> \
//     --to=<YYYY-MM-DD> \
//     [--out-dir=evidence/<YYYY-Q#>] \
//     [--dry-run]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars (required at boot by
//                             @pharmax/crypto; this script does not
//                             encrypt anything).
//
// Exits:
//   0  CSV written (or printed in dry-run mode).
//   1  Validation failure or unexpected error.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm exec tsx scripts/soc2/export-user-roster.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/user-roster.csv (default out-dir derived from --to)

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars.
`.trim();

interface ParsedArgs {
  readonly from: Date;
  readonly to: Date;
  readonly outDir?: string;
  readonly dryRun: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: "string" },
      to: { type: "string" },
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
  if (typeof values.from !== "string" || typeof values.to !== "string") {
    process.stderr.write(`--from and --to are required.\n\n${USAGE}\n`);
    process.exit(1);
  }
  const from = new Date(`${values.from}T00:00:00.000Z`);
  const to = new Date(`${values.to}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    process.stderr.write(`--from and --to must be YYYY-MM-DD.\n\n${USAGE}\n`);
    process.exit(1);
  }
  return {
    from,
    to,
    ...(typeof values["out-dir"] === "string" ? { outDir: values["out-dir"] } : {}),
    dryRun: values["dry-run"] === true,
  };
}

function currentQuarterLabel(d: Date): string {
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCsv(values: ReadonlyArray<string>): string {
  return values.map(csvEscape).join(",");
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  const users = await withSystemContext("soc2:export-user-roster", () =>
    prisma.user.findMany({
      select: {
        id: true,
        organizationId: true,
        email: true,
        displayName: true,
        status: true,
        clerkUserId: true,
        mfaEnrolled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: { select: { code: true } },
          },
        },
      },
      orderBy: [{ organizationId: "asc" }, { email: "asc" }],
    })
  );

  const header = [
    "userId",
    "organizationId",
    "email",
    "displayName",
    "status",
    "clerkLinked",
    "mfaEnrolled",
    "lastLoginAt",
    "createdAt",
    "updatedAt",
    "lastLoginInPeriod",
    "roleCodes",
  ];

  const lines: string[] = [rowToCsv(header)];
  let inPeriodCount = 0;
  for (const u of users) {
    const lastLogin = u.lastLoginAt;
    const lastLoginInPeriod = lastLogin !== null && lastLogin >= args.from && lastLogin <= args.to;
    if (lastLoginInPeriod) inPeriodCount += 1;
    const roleCodes = u.userRoles
      .map((ur) => ur.role.code)
      .sort()
      .join("|");
    lines.push(
      rowToCsv([
        u.id,
        u.organizationId,
        u.email,
        u.displayName,
        u.status,
        u.clerkUserId === null ? "false" : "true",
        u.mfaEnrolled ? "true" : "false",
        lastLogin === null ? "" : lastLogin.toISOString(),
        u.createdAt.toISOString(),
        u.updatedAt.toISOString(),
        lastLoginInPeriod ? "true" : "false",
        roleCodes,
      ])
    );
  }
  const body = `${lines.join("\n")}\n`;

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const outPath = resolve(outDir, "user-roster.csv");

  if (args.dryRun) {
    process.stdout.write(
      `[user-roster] dry-run — would write ${outPath} (${users.length} users, ${inPeriodCount} active in period)\n`
    );
    process.stdout.write(body);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
    process.stdout.write(
      `[user-roster] wrote ${outPath} — ${users.length} users, ${inPeriodCount} active in period\n`
    );
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[user-roster] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
