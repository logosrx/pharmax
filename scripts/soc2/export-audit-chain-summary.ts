#!/usr/bin/env tsx
// scripts/soc2/export-audit-chain-summary.ts
//
// SOC 2 evidence script. For every active organization, emit:
//   - latestSeq      (current chain head sequence number)
//   - latestHashHex  (current chain head SHA-256, hex)
//   - chainHeadUpdatedAt  (when the head row last advanced)
//   - rowsInPeriod   (count of audit_log rows inserted in the window)
//   - lastRowAt      (most recent audit_log occurredAt in the window)
//
// Used as primary evidence for CC7.2-2 (tamper-evident audit log) and
// PI1.4-2 (tamper-evidence of processing records). Complements the
// daily verifier output captured under
// evidence/audit-chain-verifications/<period>/.
//
// PHI posture: no PHI in `audit_log` schema (metadata is PHI-redacted
// at write time per the audit chain design). This script reports
// counts and chain-head bytes only.
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-audit-chain-summary.ts \
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
Usage: pnpm exec tsx scripts/soc2/export-audit-chain-summary.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/audit-chain-summary.csv

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

  const orgs = await withSystemContext("soc2:list-orgs-for-chain-summary", () =>
    prisma.organization.findMany({
      select: { id: true, slug: true },
      orderBy: { slug: "asc" },
    })
  );

  const header = [
    "organizationId",
    "slug",
    "latestSeq",
    "latestHashHex",
    "chainHeadUpdatedAt",
    "rowsInPeriod",
    "lastRowAt",
  ];
  const lines: string[] = [rowToCsv(header)];

  for (const org of orgs) {
    const chainHead = await withSystemContext("soc2:read-chain-head", () =>
      prisma.auditChainState.findUnique({
        where: { organizationId: org.id },
        select: { latestSeq: true, latestHash: true, updatedAt: true },
      })
    );

    const inPeriodCount = await withSystemContext("soc2:count-audit-rows-in-period", () =>
      prisma.auditLog.count({
        where: {
          organizationId: org.id,
          occurredAt: { gte: args.from, lte: args.to },
        },
      })
    );

    const lastRow = await withSystemContext("soc2:read-last-audit-row", () =>
      prisma.auditLog.findFirst({
        where: {
          organizationId: org.id,
          occurredAt: { gte: args.from, lte: args.to },
        },
        select: { occurredAt: true },
        orderBy: { seq: "desc" },
      })
    );

    lines.push(
      rowToCsv([
        org.id,
        org.slug,
        chainHead === null ? "" : chainHead.latestSeq.toString(),
        chainHead === null ? "" : Buffer.from(chainHead.latestHash).toString("hex"),
        chainHead === null ? "" : chainHead.updatedAt.toISOString(),
        inPeriodCount.toString(),
        lastRow === null ? "" : lastRow.occurredAt.toISOString(),
      ])
    );
  }

  const body = `${lines.join("\n")}\n`;

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const outPath = resolve(outDir, "audit-chain-summary.csv");

  if (args.dryRun) {
    process.stdout.write(
      `[audit-chain-summary] dry-run — would write ${outPath} (${orgs.length} orgs)\n`
    );
    process.stdout.write(body);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
    process.stdout.write(`[audit-chain-summary] wrote ${outPath} — ${orgs.length} orgs\n`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[audit-chain-summary] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
