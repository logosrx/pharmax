#!/usr/bin/env tsx
// scripts/soc2/export-incident-log.ts
//
// SOC 2 + HIPAA evidence script.
//
// Emits the structured incident log from `incident_log`, plus the
// HIPAA §164.408 annual breach register for the period.
//
// This script was previously a stub, because no structured table
// existed and incidents lived only in the issue tracker and the
// `evidence/incidents/<year>/` postmortems. The audit-log proxy it
// emitted is retained as a cross-check — it answers "did something
// incident-shaped happen that nobody registered?", which a register
// cannot answer about itself.
//
// Three artifacts:
//
//   1. incident-log.csv — every incident in the period.
//   2. breach-register.csv — the §164.414 view: PHI-involved rows with
//      their determination, notification record, and evidence pointer.
//   3. incident-log-audit-proxy.csv — incident-adjacent `audit_log`
//      rows, as an independent cross-check against 1.
//
// Evidence for CC7.3-1 (defined incident response process), CC7.4-1
// (response to identified security events), and HIPAA §164.408 /
// §164.414.
//
// PHI posture: no PHI columns are read, and `incident_log` holds none
// by construction — counts, coded categories and references only. The
// identified material stays in the evidence file that `evidencePath`
// points at, which is NOT exported here.
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
  <out-dir>/incident-log.csv             — every incident in the period
  <out-dir>/breach-register.csv          — §164.414 view of PHI-involved incidents
  <out-dir>/incident-log-audit-proxy.csv — incident-adjacent audit rows (cross-check)

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

const INCIDENT_HEADER = [
  "incidentRef",
  "severity",
  "status",
  "title",
  "detectedAt",
  "discoveredAt",
  "discoveredBy",
  "containedAt",
  "resolvedAt",
  "phiInvolved",
  "determination",
  "subjectOrganizationId",
];

const BREACH_HEADER = [
  "incidentRef",
  "discoveredAt",
  "breachRole",
  "determination",
  "determinationBasis",
  "exceptionRelied",
  "affectedIndividualCount",
  "stateDistribution",
  "phiCategories",
  "notifications",
  "hhsAnnualLogSubmittedAt",
  "evidencePath",
  "determinedAt",
];

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

  const incidents = await withSystemContext("soc2:export-incident-log", () =>
    prisma.incidentLog.findMany({
      where: { discoveredAt: { gte: args.from, lte: args.to } },
      orderBy: [{ discoveredAt: "asc" }],
    })
  );

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

  const incidentLines: string[] = [rowToCsv(INCIDENT_HEADER)];
  for (const i of incidents) {
    incidentLines.push(
      rowToCsv([
        i.incidentRef,
        i.severity,
        i.status,
        i.title,
        i.detectedAt.toISOString(),
        i.discoveredAt.toISOString(),
        i.discoveredBy,
        i.containedAt?.toISOString() ?? "",
        i.resolvedAt?.toISOString() ?? "",
        String(i.phiInvolved),
        i.determination,
        i.subjectOrganizationId ?? "",
      ])
    );
  }
  const incidentBody = `${incidentLines.join("\n")}\n`;

  // The §164.414 view. Only PHI-involved rows: an incident with no PHI
  // is a SOC 2 record and has no place in a breach register.
  const breaches = incidents.filter((i) => i.phiInvolved);
  const breachLines: string[] = [rowToCsv(BREACH_HEADER)];
  for (const b of breaches) {
    breachLines.push(
      rowToCsv([
        b.incidentRef,
        b.discoveredAt.toISOString(),
        b.breachRole ?? "",
        b.determination,
        b.determinationBasis ?? "",
        b.exceptionRelied ?? "",
        b.affectedIndividualCount?.toString() ?? "",
        b.stateDistribution === null ? "" : JSON.stringify(b.stateDistribution),
        b.phiCategories.join(";"),
        b.notifications === null ? "" : JSON.stringify(b.notifications),
        b.hhsAnnualLogSubmittedAt?.toISOString() ?? "",
        b.evidencePath ?? "",
        b.determinedAt?.toISOString() ?? "",
      ])
    );
  }
  const breachBody = `${breachLines.join("\n")}\n`;

  // Surfaced loudly rather than left for the reader to notice. An
  // undetermined row is not a neutral state — §164.402 presumes a
  // breach until the four-factor assessment says otherwise, so a
  // PENDING row in a closed audit period is an open obligation.
  const pending = breaches.filter((b) => b.determination === "PENDING");
  const subFiveHundredUnfiled = breaches.filter(
    (b) =>
      b.determination === "BREACH" &&
      (b.affectedIndividualCount ?? 0) < 500 &&
      b.hhsAnnualLogSubmittedAt === null
  );

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const incidentPath = resolve(outDir, "incident-log.csv");
  const breachPath = resolve(outDir, "breach-register.csv");
  const proxyPath = resolve(outDir, "incident-log-audit-proxy.csv");

  const summary =
    `[incident-log] period ${args.from.toISOString()} → ${args.to.toISOString()}\n` +
    `[incident-log] incidents=${incidents.length} phiInvolved=${breaches.length} ` +
    `proxyRows=${proxyRows.length}\n`;

  if (args.dryRun) {
    process.stdout.write(`[incident-log] dry-run — would write:\n`);
    process.stdout.write(`  ${incidentPath}\n  ${breachPath}\n  ${proxyPath}\n`);
    process.stdout.write(summary);
  } else {
    mkdirSync(dirname(incidentPath), { recursive: true });
    writeFileSync(incidentPath, incidentBody, "utf8");
    writeFileSync(breachPath, breachBody, "utf8");
    writeFileSync(proxyPath, body, "utf8");
    process.stdout.write(`[incident-log] wrote 3 artifacts to ${outDir}\n`);
    process.stdout.write(summary);
  }

  if (pending.length > 0) {
    process.stdout.write(
      `[incident-log] WARNING: ${pending.length} PHI-involved incident(s) still PENDING ` +
        `determination — §164.402 presumes a breach until the four-factor assessment ` +
        `concludes otherwise: ${pending.map((p) => p.incidentRef).join(", ")}\n`
    );
  }
  if (subFiveHundredUnfiled.length > 0) {
    process.stdout.write(
      `[incident-log] NOTE: ${subFiveHundredUnfiled.length} sub-500 breach(es) not yet in an ` +
        `annual HHS submission — due within 60 days of calendar year end (§164.408): ` +
        `${subFiveHundredUnfiled.map((p) => p.incidentRef).join(", ")}\n`
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
