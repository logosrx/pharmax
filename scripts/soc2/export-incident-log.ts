#!/usr/bin/env tsx
// scripts/soc2/export-incident-log.ts
//
// SOC 2 evidence script — STUB MODE.
//
// Pharmax does not yet maintain a structured `incident_log` table.
// Incidents are tracked outside the production database (issue
// tracker + `evidence/incidents/<year>/` postmortems) per the
// incident-response policy. Until a database-backed incident log
// exists, this script emits a stub artifact that:
//
//   1. Documents the absence and points at where incidents ARE
//      tracked (the issue tracker, the postmortem folder).
//   2. Surfaces a best-effort proxy from `audit_log`: rows whose
//      `action` matches incident-related prefixes (e.g.,
//      `incident.*`, `rbac.breakglass.*`, `audit.chain.broken`).
//      These are not a substitute for a structured incident log —
//      they help the auditor cross-check.
//
// When the `incident_log` table is added, this script will be
// upgraded to emit the structured CSV directly. The stub artifact
// surfaces a banner at the top so the auditor sees the gap.
//
// Primary evidence for CC7.3-1 (defined incident response process)
// and CC7.4-1 (response to identified security events) — the
// authoritative evidence remains the postmortem files.
//
// PHI posture: no PHI columns are read.
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-incident-log.ts \
//     --from=<YYYY-MM-DD> \
//     --to=<YYYY-MM-DD> \
//     [--out-dir=evidence/<YYYY-Q#>] \
//     [--dry-run]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm exec tsx scripts/soc2/export-incident-log.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/incident-log-stub.txt        — banner + pointer
  <out-dir>/incident-log-audit-proxy.csv — incident-adjacent audit rows in period

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

const STUB_BANNER = `
INCIDENT LOG STUB — no structured incident_log table exists yet.

The authoritative incident evidence for the period is the set of
postmortem files under:

  evidence/incidents/<year>/<incident-id>/

If no postmortem files exist for the period, the period had no
incidents at MINOR or above severity. Land a one-line file at
evidence/incidents/<year>/no-incidents-<period>.txt to confirm the
absence is intentional.

A companion CSV at incident-log-audit-proxy.csv enumerates audit_log
rows whose action prefix is incident-adjacent (incident.*,
rbac.breakglass.*, audit.chain.broken, sod.violation). These are a
best-effort cross-check and are NOT a substitute for a structured
incident log.

When the incident_log table is added (tracked in the engineering
backlog), this script will emit a structured incident-log.csv and
the stub will be retired.
`.trim();

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

  const proxyRows = await withSystemContext("soc2:export-incident-audit-proxy", () =>
    prisma.auditLog.findMany({
      where: {
        occurredAt: { gte: args.from, lte: args.to },
        OR: [
          { action: { startsWith: "incident." } },
          { action: { startsWith: "rbac.breakglass." } },
          { action: { startsWith: "sod." } },
          { action: { startsWith: "audit.chain." } },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        actorUserId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        occurredAt: true,
        seq: true,
      },
      orderBy: [{ organizationId: "asc" }, { seq: "asc" }],
    })
  );

  const header = [
    "auditLogId",
    "organizationId",
    "actorUserId",
    "action",
    "resourceType",
    "resourceId",
    "occurredAt",
    "seq",
  ];
  const lines: string[] = [rowToCsv(header)];
  for (const r of proxyRows) {
    lines.push(
      rowToCsv([
        r.id,
        r.organizationId,
        r.actorUserId ?? "",
        r.action,
        r.resourceType,
        r.resourceId ?? "",
        r.occurredAt.toISOString(),
        r.seq.toString(),
      ])
    );
  }
  const body = `${lines.join("\n")}\n`;

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const stubPath = resolve(outDir, "incident-log-stub.txt");
  const proxyPath = resolve(outDir, "incident-log-audit-proxy.csv");
  const stubText =
    `${STUB_BANNER}\n\n` +
    `Period: ${args.from.toISOString()} → ${args.to.toISOString()}\n` +
    `Audit-proxy rows in period: ${proxyRows.length}\n`;

  if (args.dryRun) {
    process.stdout.write(
      `[incident-log] dry-run — would write ${stubPath} and ${proxyPath} (${proxyRows.length} proxy rows)\n`
    );
    process.stdout.write(stubText);
  } else {
    mkdirSync(dirname(stubPath), { recursive: true });
    writeFileSync(stubPath, stubText, "utf8");
    writeFileSync(proxyPath, body, "utf8");
    process.stdout.write(
      `[incident-log] wrote ${stubPath} + ${proxyPath} (${proxyRows.length} proxy rows)\n`
    );
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[incident-log] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
