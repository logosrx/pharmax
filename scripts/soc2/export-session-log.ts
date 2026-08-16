#!/usr/bin/env tsx
// scripts/soc2/export-session-log.ts
//
// SOC 2 evidence script. Exports the session lifecycle for the period
// from the tables the in-house identity engine actually writes:
// `auth_session` (operator console) and `portal_session` (provider
// portal). Primary evidence for CC6.1-1 (identity established before
// access) and CC6.5-1 (deprovisioning on termination).
//
// Why two artifacts:
//
//   - `session-log.csv` — every session OPENED in the period. A row
//     exists only because SignIn (or the portal equivalent) completed,
//     so the file is the period's record that access was preceded by
//     an established identity. `mfaSatisfied` carries the CC6.1-4
//     step-up outcome for the operator surface.
//   - `session-revocations.csv` — every session REVOKED in the period,
//     whenever it was opened, with its `revokedReason`. The auditor
//     filters `USER_TERMINATED` and cross-checks against the quarter's
//     terminations; `ADMIN_REVOKED` and `SECURITY_EVENT` are the
//     adjacent off-boarding reasons.
//
// This script replaces `export-clerk-session-log.ts`, which exported
// `clerk_webhook_event`. ADR-0030 retired Clerk and removed the route
// and handler that wrote that table, so the old artifact was a frozen
// slice presented as current evidence for two controls (EI-6). The
// controls still require session evidence — see
// `docs/soc2/trust-service-criteria-mapping.md` CC6.1-1 and CC6.5-1,
// which name session rows and the `USER_TERMINATED` revocation reason
// directly — so the exporter is re-pointed rather than deleted.
//
// PHI posture: opaque UUIDs and lifecycle timestamps only. No patient
// data is reachable from either table. Three columns that DO exist on
// the rows are deliberately NOT exported:
//
//   - `tokenHash` — a credential-adjacent value with no audit value.
//   - `ipAddress` / `userAgent` — workforce personal data that neither
//     control requires. If a per-IP / per-device review is ever scoped,
//     it needs its own artifact and its own retention decision.
//
// Operator email and display name are likewise omitted: the principal
// UUID joins to `user-roster.csv`, which is the pack's one place that
// resolves a UUID to a person.
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-session-log.ts \
//     --from=<YYYY-MM-DD> \
//     --to=<YYYY-MM-DD> \
//     [--out-dir=evidence/<YYYY-Q#>] \
//     [--dry-run]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars.
//
// Exits:
//   0  CSVs written (or described in dry-run mode).
//   1  Validation failure or unexpected error.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma, type PrismaClient } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm exec tsx scripts/soc2/export-session-log.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/session-log.csv          — sessions opened in the period
  <out-dir>/session-revocations.csv  — sessions revoked in the period

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars.
`.trim();

export const SESSION_LOG_FILENAME = "session-log.csv";
export const SESSION_REVOCATION_FILENAME = "session-revocations.csv";

/** Which session engine issued the row. The two tables are disjoint by design. */
export type SessionSurface = "OPERATOR" | "PORTAL";

/** Whether the window filters on session issue or on session revocation. */
export type SessionWindowAnchor = "OPENED" | "REVOKED";

export interface SessionQuery {
  readonly from: Date;
  readonly to: Date;
  readonly anchor: SessionWindowAnchor;
}

export interface OperatorSessionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly mfaSatisfied: boolean;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

export interface PortalSessionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly portalAccountId: string;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

/**
 * Repository-shaped port the exporter depends on. `main` wires the
 * Prisma-backed implementation; tests inject a fake.
 */
export interface SessionEvidenceClient {
  listOperatorSessions(query: SessionQuery): Promise<ReadonlyArray<OperatorSessionRecord>>;
  listPortalSessions(query: SessionQuery): Promise<ReadonlyArray<PortalSessionRecord>>;
}

/** Surface-neutral evidence row. Both tables normalize into this shape. */
export interface SessionEvidenceRow {
  readonly surface: SessionSurface;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly principalId: string;
  /** `null` on the portal surface — `portal_session` carries no MFA column. */
  readonly mfaSatisfied: boolean | null;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

export function toOperatorEvidenceRow(record: OperatorSessionRecord): SessionEvidenceRow {
  return {
    surface: "OPERATOR",
    sessionId: record.id,
    organizationId: record.organizationId,
    principalId: record.userId,
    mfaSatisfied: record.mfaSatisfied,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
  };
}

export function toPortalEvidenceRow(record: PortalSessionRecord): SessionEvidenceRow {
  return {
    surface: "PORTAL",
    sessionId: record.id,
    organizationId: record.organizationId,
    principalId: record.portalAccountId,
    mfaSatisfied: null,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
  };
}

// Two tables merge into one artifact, so ordering cannot come from the
// database. Sorting here keeps the CSV byte-identical across runs —
// the manifest hashes it.
function sortByOrgThen(rows: ReadonlyArray<SessionEvidenceRow>, key: "createdAt" | "revokedAt") {
  return [...rows].sort((a, b) => {
    if (a.organizationId !== b.organizationId) {
      return a.organizationId < b.organizationId ? -1 : 1;
    }
    const aTime = a[key]?.getTime() ?? 0;
    const bTime = b[key]?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
}

export interface SessionEvidence {
  readonly opened: ReadonlyArray<SessionEvidenceRow>;
  readonly revoked: ReadonlyArray<SessionEvidenceRow>;
}

export async function collectSessionEvidence(
  client: SessionEvidenceClient,
  from: Date,
  to: Date
): Promise<SessionEvidence> {
  const [openedOperator, openedPortal, revokedOperator, revokedPortal] = await Promise.all([
    client.listOperatorSessions({ from, to, anchor: "OPENED" }),
    client.listPortalSessions({ from, to, anchor: "OPENED" }),
    client.listOperatorSessions({ from, to, anchor: "REVOKED" }),
    client.listPortalSessions({ from, to, anchor: "REVOKED" }),
  ]);

  const opened = [
    ...openedOperator.map(toOperatorEvidenceRow),
    ...openedPortal.map(toPortalEvidenceRow),
  ];
  const revoked = [
    ...revokedOperator.map(toOperatorEvidenceRow),
    ...revokedPortal.map(toPortalEvidenceRow),
  ];

  return {
    opened: sortByOrgThen(opened, "createdAt"),
    revoked: sortByOrgThen(revoked, "revokedAt"),
  };
}

type SessionDelegates = Pick<PrismaClient, "authSession" | "portalSession">;

const OPERATOR_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  mfaSatisfied: true,
  createdAt: true,
  lastActivityAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

const PORTAL_SELECT = {
  id: true,
  organizationId: true,
  portalAccountId: true,
  createdAt: true,
  lastActivityAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

// `REVOKED` filters on `revokedAt`, which is nullable — an active
// session must not fall into the revocation artifact just because its
// null sorts inside the range.
function whereForAnchor(query: SessionQuery) {
  return query.anchor === "OPENED"
    ? { createdAt: { gte: query.from, lte: query.to } }
    : { revokedAt: { gte: query.from, lte: query.to, not: null } };
}

export function createPrismaSessionEvidenceClient(
  delegates: SessionDelegates
): SessionEvidenceClient {
  return {
    async listOperatorSessions(query) {
      return withSystemContext("soc2:export-session-log:operator", () =>
        delegates.authSession.findMany({
          where: whereForAnchor(query),
          select: OPERATOR_SELECT,
          orderBy: [{ organizationId: "asc" }, { createdAt: "asc" }],
        })
      );
    },
    async listPortalSessions(query) {
      return withSystemContext("soc2:export-session-log:portal", () =>
        delegates.portalSession.findMany({
          where: whereForAnchor(query),
          select: PORTAL_SELECT,
          orderBy: [{ organizationId: "asc" }, { createdAt: "asc" }],
        })
      );
    },
  };
}

interface ParsedArgs {
  readonly from: Date;
  readonly to: Date;
  readonly outDir?: string;
  readonly dryRun: boolean;
}

export function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
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

export function currentQuarterLabel(d: Date): string {
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

const SESSION_LOG_HEADER = [
  "surface",
  "sessionId",
  "organizationId",
  "principalId",
  "mfaSatisfied",
  "createdAt",
  "lastActivityAt",
  "idleExpiresAt",
  "absoluteExpiresAt",
  "revokedAt",
  "revokedReason",
] as const;

const REVOCATION_HEADER = [
  "surface",
  "sessionId",
  "organizationId",
  "principalId",
  "createdAt",
  "revokedAt",
  "revokedReason",
  "sessionLifetimeMinutes",
] as const;

export function composeSessionLogCsv(rows: ReadonlyArray<SessionEvidenceRow>): string {
  const lines: string[] = [rowToCsv([...SESSION_LOG_HEADER])];
  for (const r of rows) {
    lines.push(
      rowToCsv([
        r.surface,
        r.sessionId,
        r.organizationId,
        r.principalId,
        r.mfaSatisfied === null ? "" : r.mfaSatisfied ? "true" : "false",
        r.createdAt.toISOString(),
        r.lastActivityAt.toISOString(),
        r.idleExpiresAt.toISOString(),
        r.absoluteExpiresAt.toISOString(),
        r.revokedAt === null ? "" : r.revokedAt.toISOString(),
        r.revokedReason ?? "",
      ])
    );
  }
  return `${lines.join("\n")}\n`;
}

export function composeRevocationCsv(rows: ReadonlyArray<SessionEvidenceRow>): string {
  const lines: string[] = [rowToCsv([...REVOCATION_HEADER])];
  for (const r of rows) {
    const lifetimeMinutes =
      r.revokedAt === null
        ? ""
        : Math.floor((r.revokedAt.getTime() - r.createdAt.getTime()) / 60_000).toString();
    lines.push(
      rowToCsv([
        r.surface,
        r.sessionId,
        r.organizationId,
        r.principalId,
        r.createdAt.toISOString(),
        r.revokedAt === null ? "" : r.revokedAt.toISOString(),
        r.revokedReason ?? "",
        lifetimeMinutes,
      ])
    );
  }
  return `${lines.join("\n")}\n`;
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

  const evidence = await collectSessionEvidence(
    createPrismaSessionEvidenceClient(prisma),
    args.from,
    args.to
  );

  const logBody = composeSessionLogCsv(evidence.opened);
  const revocationBody = composeRevocationCsv(evidence.revoked);

  const outDir = args.outDir ?? resolve(process.cwd(), "evidence", currentQuarterLabel(args.to));
  const logPath = resolve(outDir, SESSION_LOG_FILENAME);
  const revocationPath = resolve(outDir, SESSION_REVOCATION_FILENAME);

  if (args.dryRun) {
    process.stdout.write(
      `[session-log] dry-run — would write ${logPath} (${evidence.opened.length} opened) ` +
        `and ${revocationPath} (${evidence.revoked.length} revoked)\n`
    );
  } else {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, logBody, "utf8");
    writeFileSync(revocationPath, revocationBody, "utf8");
    process.stdout.write(
      `[session-log] wrote ${logPath} (${evidence.opened.length}), ` +
        `${revocationPath} (${evidence.revoked.length})\n`
    );
  }

  await prisma.$disconnect();
  process.exit(0);
}

// Only execute when run as a CLI (tests import the pure helpers).
const isDirectRun = process.argv[1]?.includes("export-session-log") ?? false;
if (isDirectRun) {
  main().catch((cause: unknown) => {
    process.stderr.write(
      `\n[session-log] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
    );
    process.exit(1);
  });
}
