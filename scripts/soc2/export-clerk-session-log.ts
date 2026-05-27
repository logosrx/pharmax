#!/usr/bin/env tsx
// scripts/soc2/export-clerk-session-log.ts
//
// SOC 2 evidence script. Exports the Clerk webhook event log
// (`clerk_webhook_event` table) for the period, plus a derived
// last-login-per-user summary. Used as primary evidence for
// CC6.1-1 (identity established) and CC6.5-1 (deprovisioning on
// termination).
//
// Pharmax does not store Clerk session state directly — Clerk owns
// the session surface (ADR-0015). The auditable signal Pharmax holds
// is the lifecycle webhook stream Pharmax received and processed from
// Clerk (ADR-0025), plus `User.lastLoginAt` updated by the operator
// console on successful Clerk-authenticated requests.
//
// If a deeper session log is required (e.g., per-IP, per-device), it
// must be exported from the Clerk dashboard directly; this script
// emits the Pharmax-side audit slice only.
//
// PHI posture: opaque UUIDs only. Webhook payload column is NOT
// included in the output (it contains the raw Clerk event; the
// dispatcher outcome and event type are sufficient for audit).
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-clerk-session-log.ts \
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
Usage: pnpm exec tsx scripts/soc2/export-clerk-session-log.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/clerk-session-log.csv  — Clerk webhook events in period
  <out-dir>/clerk-last-login.csv   — last-login per user as of period end

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

  const events = await withSystemContext("soc2:export-clerk-session-log", () =>
    prisma.clerkWebhookEvent.findMany({
      where: { receivedAt: { gte: args.from, lte: args.to } },
      select: {
        id: true,
        svixMessageId: true,
        eventType: true,
        status: true,
        dispatchOutcome: true,
        attempts: true,
        receivedAt: true,
        signatureVerifiedAt: true,
        dispatchedAt: true,
      },
      orderBy: { receivedAt: "asc" },
    })
  );

  const lastLogin = await withSystemContext("soc2:export-clerk-last-login", () =>
    prisma.user.findMany({
      where: { clerkUserId: { not: null } },
      select: {
        id: true,
        organizationId: true,
        email: true,
        status: true,
        mfaEnrolled: true,
        lastLoginAt: true,
      },
      orderBy: [{ organizationId: "asc" }, { lastLoginAt: "desc" }],
    })
  );

  const eventHeader = [
    "id",
    "svixMessageId",
    "eventType",
    "status",
    "dispatchOutcome",
    "attempts",
    "receivedAt",
    "signatureVerifiedAt",
    "dispatchedAt",
  ];
  const eventLines: string[] = [rowToCsv(eventHeader)];
  for (const e of events) {
    eventLines.push(
      rowToCsv([
        e.id,
        e.svixMessageId,
        e.eventType,
        e.status,
        e.dispatchOutcome ?? "",
        e.attempts.toString(),
        e.receivedAt.toISOString(),
        e.signatureVerifiedAt.toISOString(),
        e.dispatchedAt === null ? "" : e.dispatchedAt.toISOString(),
      ])
    );
  }
  const eventBody = `${eventLines.join("\n")}\n`;

  const loginHeader = [
    "userId",
    "organizationId",
    "email",
    "status",
    "mfaEnrolled",
    "lastLoginAt",
    "daysSinceLogin",
  ];
  const loginLines: string[] = [rowToCsv(loginHeader)];
  const periodEndMs = args.to.getTime();
  for (const u of lastLogin) {
    const daysSinceLogin =
      u.lastLoginAt === null
        ? ""
        : Math.floor((periodEndMs - u.lastLoginAt.getTime()) / 86_400_000).toString();
    loginLines.push(
      rowToCsv([
        u.id,
        u.organizationId,
        u.email,
        u.status,
        u.mfaEnrolled ? "true" : "false",
        u.lastLoginAt === null ? "" : u.lastLoginAt.toISOString(),
        daysSinceLogin,
      ])
    );
  }
  const loginBody = `${loginLines.join("\n")}\n`;

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const eventPath = resolve(outDir, "clerk-session-log.csv");
  const loginPath = resolve(outDir, "clerk-last-login.csv");

  if (args.dryRun) {
    process.stdout.write(
      `[clerk-session-log] dry-run — would write ${eventPath} (${events.length} events) and ${loginPath} (${lastLogin.length} users)\n`
    );
  } else {
    mkdirSync(dirname(eventPath), { recursive: true });
    writeFileSync(eventPath, eventBody, "utf8");
    writeFileSync(loginPath, loginBody, "utf8");
    process.stdout.write(
      `[clerk-session-log] wrote ${eventPath} (${events.length}), ${loginPath} (${lastLogin.length})\n`
    );
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[clerk-session-log] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
