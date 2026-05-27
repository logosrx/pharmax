#!/usr/bin/env tsx
// scripts/soc2/export-change-control-summary.ts
//
// SOC 2 evidence script. Summarizes change-control activity in a
// period: Prisma migrations applied, workflow-policy lifecycle
// transitions, and command-bus activity (rolled up by command name).
// Used as primary evidence for CC8.1-1 (PR + review + CI), CC8.1-2
// (versioned schema migrations), and CC8.1-3 (versioned workflow
// policy).
//
// What this script does NOT export:
//   - Pull-request metadata (author, reviewer, merge SHA, CI status).
//     That data lives in GitHub, not in the Pharmax database. The
//     auditor reads it from GitHub directly — see
//     docs/soc2/playbooks/change-management-review.md.
//   - Branch-protection state. Cross-reference
//     docs/security/branch-protection.{md,json}.
//
// PHI posture: opaque UUIDs only; no command payloads.
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-change-control-summary.ts \
//     --from=<YYYY-MM-DD> \
//     --to=<YYYY-MM-DD> \
//     [--out-dir=evidence/<YYYY-Q#>] \
//     [--dry-run]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars.

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm exec tsx scripts/soc2/export-change-control-summary.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/change-control-summary.csv         — per-source rollup
  <out-dir>/change-control-migrations.csv      — migration directory listing
  <out-dir>/change-control-workflow-policy.csv — workflow-policy lifecycle in period
  <out-dir>/change-control-commands.csv        — command-bus activity in period

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

/**
 * Parse a Prisma migration directory name (`YYYYMMDDHHMMSS_<name>`)
 * into a UTC Date. Returns null if the name doesn't match.
 */
function parseMigrationTimestamp(dirname_: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(dirname_);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match;
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    h === undefined ||
    mi === undefined ||
    s === undefined
  ) {
    return null;
  }
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

interface MigrationEntry {
  readonly name: string;
  readonly declaredAt: Date;
  readonly inPeriod: boolean;
}

function readMigrationDirectory(
  repoRoot: string,
  from: Date,
  to: Date
): ReadonlyArray<MigrationEntry> {
  const migrationsDir = join(repoRoot, "prisma", "migrations");
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    return [];
  }
  const out: MigrationEntry[] = [];
  for (const entry of entries) {
    const full = join(migrationsDir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const ts = parseMigrationTimestamp(entry);
    if (ts === null) continue;
    out.push({
      name: entry,
      declaredAt: ts,
      inPeriod: ts >= from && ts <= to,
    });
  }
  out.sort((a, b) => a.declaredAt.getTime() - b.declaredAt.getTime());
  return out;
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

  const repoRoot = process.cwd();
  const migrations = readMigrationDirectory(repoRoot, args.from, args.to);
  const migrationsInPeriod = migrations.filter((m) => m.inPeriod);

  const workflowPolicyChanges = await withSystemContext(
    "soc2:export-change-control-workflow-policy",
    () =>
      prisma.workflowPolicy.findMany({
        where: {
          OR: [
            { createdAt: { gte: args.from, lte: args.to } },
            { updatedAt: { gte: args.from, lte: args.to } },
            { publishedAt: { gte: args.from, lte: args.to } },
            { retiredAt: { gte: args.from, lte: args.to } },
          ],
        },
        select: {
          id: true,
          organizationId: true,
          code: true,
          version: true,
          status: true,
          publishedAt: true,
          retiredAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ organizationId: "asc" }, { code: "asc" }, { version: "asc" }],
      })
  );

  const commandRollup = await withSystemContext("soc2:export-change-control-commands", () =>
    prisma.commandLog.groupBy({
      by: ["commandName", "status"],
      where: { startedAt: { gte: args.from, lte: args.to } },
      _count: { id: true },
    })
  );

  // Migrations CSV.
  const migHeader = ["name", "declaredAtUtc", "inPeriod"];
  const migLines: string[] = [rowToCsv(migHeader)];
  for (const m of migrations) {
    migLines.push(rowToCsv([m.name, m.declaredAt.toISOString(), m.inPeriod ? "true" : "false"]));
  }
  const migBody = `${migLines.join("\n")}\n`;

  // Workflow-policy CSV.
  const wfHeader = [
    "workflowPolicyId",
    "organizationId",
    "code",
    "version",
    "status",
    "createdAt",
    "updatedAt",
    "publishedAt",
    "retiredAt",
  ];
  const wfLines: string[] = [rowToCsv(wfHeader)];
  for (const w of workflowPolicyChanges) {
    wfLines.push(
      rowToCsv([
        w.id,
        w.organizationId,
        w.code,
        w.version.toString(),
        w.status,
        w.createdAt.toISOString(),
        w.updatedAt.toISOString(),
        w.publishedAt === null ? "" : w.publishedAt.toISOString(),
        w.retiredAt === null ? "" : w.retiredAt.toISOString(),
      ])
    );
  }
  const wfBody = `${wfLines.join("\n")}\n`;

  // Commands rollup CSV.
  const cmdHeader = ["commandName", "status", "count"];
  const cmdLines: string[] = [rowToCsv(cmdHeader)];
  const sortedRollup = [...commandRollup].sort((a, b) => {
    const byName = a.commandName.localeCompare(b.commandName);
    if (byName !== 0) return byName;
    return a.status.localeCompare(b.status);
  });
  for (const r of sortedRollup) {
    const count = r._count?.id ?? 0;
    cmdLines.push(rowToCsv([r.commandName, r.status, count.toString()]));
  }
  const cmdBody = `${cmdLines.join("\n")}\n`;

  // Summary CSV.
  const summaryHeader = ["source", "totalInPeriod", "notes"];
  const summaryLines: string[] = [rowToCsv(summaryHeader)];
  summaryLines.push(
    rowToCsv([
      "prisma_migrations",
      migrationsInPeriod.length.toString(),
      "from prisma/migrations/ directory; declaredAt parsed from directory name",
    ])
  );
  summaryLines.push(
    rowToCsv([
      "workflow_policy_changes",
      workflowPolicyChanges.length.toString(),
      "rows with create/update/publish/retire timestamp in period",
    ])
  );
  const commandTotal = sortedRollup.reduce((acc, r) => acc + (r._count?.id ?? 0), 0);
  summaryLines.push(
    rowToCsv([
      "command_bus_invocations",
      commandTotal.toString(),
      "count of command_log rows created in period",
    ])
  );
  summaryLines.push(
    rowToCsv([
      "pull_requests",
      "n/a",
      "PR data lives in GitHub; pull via gh pr list --search 'merged:<from>..<to>'",
    ])
  );
  const summaryBody = `${summaryLines.join("\n")}\n`;

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const summaryPath = resolve(outDir, "change-control-summary.csv");
  const migPath = resolve(outDir, "change-control-migrations.csv");
  const wfPath = resolve(outDir, "change-control-workflow-policy.csv");
  const cmdPath = resolve(outDir, "change-control-commands.csv");

  if (args.dryRun) {
    process.stdout.write(
      `[change-control] dry-run — would write ${summaryPath}, ${migPath}, ${wfPath}, ${cmdPath}\n` +
        `[change-control] migrations in period=${migrationsInPeriod.length}, ` +
        `workflow_policy changes=${workflowPolicyChanges.length}, ` +
        `commands=${commandTotal}\n`
    );
  } else {
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, summaryBody, "utf8");
    writeFileSync(migPath, migBody, "utf8");
    writeFileSync(wfPath, wfBody, "utf8");
    writeFileSync(cmdPath, cmdBody, "utf8");
    process.stdout.write(
      `[change-control] wrote ${summaryPath} + 3 detail files — ` +
        `migrations=${migrationsInPeriod.length}, ` +
        `workflow_policy=${workflowPolicyChanges.length}, ` +
        `commands=${commandTotal}\n`
    );
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[change-control] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
