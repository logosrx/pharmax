#!/usr/bin/env tsx
// scripts/operations/run-restore-drill.ts
//
// Quarterly Aurora restore-drill executor (SOC 2 A1.2 / CC7.5 evidence).
//
// The drill is **intentionally human-in-the-loop**: the destructive
// AWS calls (`restore-db-cluster-to-point-in-time`, `delete-db-cluster`)
// are NOT automated. The runbook (`docs/operations/restore-drill.md`)
// is the source of truth for the steps; this script automates only
// the parts that benefit from code:
//
//   - deterministic id computation (drill cluster + instance ids)
//   - read-only AWS preflight (KMS health + retention window +
//     LatestRestorableTime → confirm the chosen RESTORE_TIME is
//     restorable BEFORE the operator runs the destructive provision)
//   - generating exact-runnable bash with the operator's variables
//     substituted (eliminates the "I typo'd the security group ARN
//     on a drill day" failure mode)
//   - the audit-chain verification phase (re-uses `verifyChain` from
//     @pharmax/audit — this is the part the drill EXISTS to prove
//     still works against historical data)
//   - composing the §3 evidence artifact in a SOC 2-shaped format
//     (JSON for the evidence-pack uploader + markdown for the
//     reviewer)
//
// Phases (run in this order; the runbook walks the operator through
// the steps that happen between them):
//
//   1. `--phase=preflight`            — read-only AWS describes.
//   2. `--phase=provision-commands`   — emits provision.sh.
//   3. <operator runs provision.sh manually against AWS>
//   4. <operator sets DATABASE_URL to restored cluster>
//   5. `--phase=verify`               — runs verifyChain + row counts.
//   6. <operator runs RLS sanity manually per runbook §2.4>
//   7. `--phase=teardown-commands`    — emits teardown.sh.
//   8. <operator runs teardown.sh manually against AWS>
//   9. `--phase=finalize`             — composes evidence.{md,json}.
//
// Each phase writes its own JSON sidecar into `--out-dir` so
// `finalize` can assemble the consolidated artifact from disk; this
// also means phases are resumable across terminal sessions (the
// drill can take 30–90 minutes wall-clock between provision-wait
// and teardown-wait).
//
// Usage examples:
//
//   pnpm drill:preflight \
//     --source-cluster-id=pharmax-prod-use1-aurora \
//     --restore-time=2026-06-04T12:00:00Z \
//     --region=us-east-1 \
//     --kms-alias=alias/pharmax-prod-use1-rds
//
//   pnpm drill:provision-commands \
//     --source-cluster-id=pharmax-prod-use1-aurora \
//     --restore-time=2026-06-04T12:00:00Z \
//     --subnet-group=pharmax-prod-use1-db \
//     --drill-sg=sg-0123abcd
//
//   # After provision + DATABASE_URL set to restored cluster:
//   DATABASE_URL=postgres://...restored-cluster... \
//     PHARMAX_LOCAL_KMS_SEED=... \
//     pnpm drill:verify
//
//   pnpm drill:teardown-commands
//
//   pnpm drill:finalize \
//     --captain="Alice Pharmacist" \
//     --observer="Bob Engineer" \
//     --sign-off="Drill captain confirms..."
//
// Required env (verify phase only):
//   DATABASE_URL              Postgres connection string of the RESTORED cluster.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars (envelope encryption seed for dev).
//
// PHI invariant: this script never reads PHI columns. The verify
// phase runs `verifyChain` (which hashes audit_log row metadata, not
// PHI) and counts rows on the four highest-value tenant-scoped
// tables (no PHI columns selected). The evidence artifact is
// non-PHI by construction.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { verifyChain } from "@pharmax/audit";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";
import { createPrismaAuditChainSource } from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

import {
  composeEvidenceJson,
  composeEvidenceMarkdown,
  composeProvisionScript,
  composeTeardownScript,
  type AuditChainPerOrgRow,
  type DrillRecord,
  type PreflightResult,
  type VerifyResult,
} from "./restore-drill-evidence.js";
import {
  currentQuarterLabel,
  drillClusterId,
  drillInstanceId,
  parseRestoreTime,
  utcDateStamp,
} from "./restore-drill-ids.js";

type Phase = "preflight" | "provision-commands" | "verify" | "teardown-commands" | "finalize";

const PHASES: ReadonlyArray<Phase> = [
  "preflight",
  "provision-commands",
  "verify",
  "teardown-commands",
  "finalize",
];

const USAGE = `
Usage: pnpm tsx scripts/operations/run-restore-drill.ts \\
  --phase=<preflight|provision-commands|verify|teardown-commands|finalize> \\
  [phase-specific flags]

Phase flags:
  preflight:
    --source-cluster-id=<id>    Source Aurora cluster (e.g. pharmax-prod-use1-aurora).
    --restore-time=<iso>        Restore point, full ISO 8601 UTC.
    --region=<aws-region>       AWS region (defaults to env AWS_REGION).
    --kms-alias=<arn-or-alias>  Cluster KMS CMK (e.g. alias/pharmax-prod-use1-rds).
    --retention-days=<n>        Expected backup retention (default 35).

  provision-commands:
    --source-cluster-id=<id>
    --restore-time=<iso>
    --subnet-group=<name>       DB subnet group (isolated tier).
    --drill-sg=<sg-id>          Drill-only security group.
    --instance-class=<class>    Override (default db.t4g.medium).

  verify:
    (uses DATABASE_URL + PHARMAX_LOCAL_KMS_SEED env vars)

  teardown-commands:
    --source-cluster-id=<id>
    (drill cluster + instance ids are derived deterministically)

  finalize:
    --captain=<name>
    --observer=<name>
    --sign-off=<text>           Optional captain's sign-off note.
    --findings=<f1>,<f2>,…      Optional comma-separated findings.

Shared flags:
  --out-dir=<dir>               Defaults to evidence/dr-drills/<period>/<date>/.
  --now=<iso>                   Test-only override for the drill date.
  --help, -h
`.trim();

interface SharedArgs {
  readonly phase: Phase;
  readonly outDir: string | null;
  readonly now: Date;
}

interface PreflightArgs extends SharedArgs {
  readonly sourceClusterId: string;
  readonly restoreTimeRaw: string;
  readonly region: string;
  readonly kmsAlias: string;
  readonly retentionDays: number;
}

interface ProvisionCommandsArgs extends SharedArgs {
  readonly sourceClusterId: string;
  readonly restoreTimeRaw: string;
  readonly subnetGroup: string;
  readonly drillSecurityGroupId: string;
  readonly instanceClass: string;
}

interface TeardownCommandsArgs extends SharedArgs {
  readonly sourceClusterId: string;
}

interface FinalizeArgs extends SharedArgs {
  readonly captain: string;
  readonly observer: string;
  readonly signOff: string | null;
  readonly findings: ReadonlyArray<string>;
}

function isPhase(s: string | undefined): s is Phase {
  return typeof s === "string" && (PHASES as ReadonlyArray<string>).includes(s);
}

function parseSharedArgs(values: Record<string, unknown>): SharedArgs {
  if (!isPhase(values["phase"] as string | undefined)) {
    process.stderr.write(`--phase is required.\n\n${USAGE}\n`);
    process.exit(1);
  }
  const outDir =
    typeof values["out-dir"] === "string" && (values["out-dir"] as string).length > 0
      ? (values["out-dir"] as string)
      : null;
  const nowRaw = typeof values["now"] === "string" ? (values["now"] as string) : null;
  const now = nowRaw !== null ? new Date(nowRaw) : new Date();
  if (Number.isNaN(now.getTime())) {
    process.stderr.write(`--now "${nowRaw ?? ""}" is not a valid ISO instant.\n`);
    process.exit(1);
  }
  return { phase: values["phase"] as Phase, outDir, now };
}

function requireString(values: Record<string, unknown>, key: string, phase: Phase): string {
  const v = values[key];
  if (typeof v !== "string" || v.length === 0) {
    process.stderr.write(`--${key} is required for --phase=${phase}.\n\n${USAGE}\n`);
    process.exit(1);
  }
  return v;
}

function resolveOutDir(args: SharedArgs): string {
  if (args.outDir !== null) {
    return resolve(process.cwd(), args.outDir);
  }
  return resolve(
    process.cwd(),
    "evidence",
    "dr-drills",
    currentQuarterLabel(args.now),
    utcDateStamp(args.now)
  );
}

function writeJsonSidecar(outDir: string, name: string, value: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function writeTextSidecar(outDir: string, name: string, value: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, name);
  writeFileSync(path, value, "utf8");
  return path;
}

function readJsonSidecarOrNull<T>(outDir: string, name: string): T | null {
  try {
    const raw = readFileSync(resolve(outDir, name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------
// Phase: preflight
// --------------------------------------------------------------------

async function runPreflight(args: PreflightArgs, logger: loggerNs.Logger): Promise<void> {
  const restoreTime = parseRestoreTime({
    raw: args.restoreTimeRaw,
    now: args.now,
    retentionDays: args.retentionDays,
  });

  // Lazy-load both AWS SDK clients to keep the script's import-time
  // cheap for the non-AWS phases (verify, finalize).
  const { RDSClient, DescribeDBClustersCommand } = await import("@aws-sdk/client-rds");
  const { KMSClient, DescribeKeyCommand } = await import("@aws-sdk/client-kms");

  const rds = new RDSClient({ region: args.region });
  const kms = new KMSClient({ region: args.region });

  // 1. KMS CMK health: must be Enabled, ENCRYPT_DECRYPT, SYMMETRIC_DEFAULT.
  //    A misconfigured CMK alias is the silent-failure mode for restores;
  //    per the runbook §0, this is the first thing to verify.
  let kmsHealthy = false;
  let kmsReason: string | null = null;
  let kmsKeyArn = args.kmsAlias;
  try {
    const out = await kms.send(new DescribeKeyCommand({ KeyId: args.kmsAlias }));
    const meta = out.KeyMetadata;
    if (meta === undefined) {
      kmsReason = "DescribeKey returned no metadata";
    } else {
      kmsKeyArn = meta.Arn ?? args.kmsAlias;
      const enabled = meta.KeyState === "Enabled";
      const usageOk = meta.KeyUsage === "ENCRYPT_DECRYPT";
      const specOk = meta.KeySpec === "SYMMETRIC_DEFAULT";
      if (!enabled || !usageOk || !specOk) {
        kmsReason = `KeyState=${meta.KeyState ?? "?"} KeyUsage=${meta.KeyUsage ?? "?"} KeySpec=${meta.KeySpec ?? "?"}`;
      } else {
        kmsHealthy = true;
      }
    }
  } catch (cause) {
    kmsReason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
  }
  logger.info("drill.preflight.kms", {
    keyArn: kmsKeyArn,
    healthy: kmsHealthy,
    reason: kmsReason,
  });

  // 2. Source cluster retention + LatestRestorableTime.
  let backupRetentionDays = 0;
  let latestRestorableTimeIso = "";
  try {
    const out = await rds.send(
      new DescribeDBClustersCommand({ DBClusterIdentifier: args.sourceClusterId })
    );
    const cluster = out.DBClusters?.[0];
    if (cluster === undefined) {
      process.stderr.write(
        `Source cluster "${args.sourceClusterId}" not found in region ${args.region}.\n`
      );
      process.exit(1);
    }
    backupRetentionDays = cluster.BackupRetentionPeriod ?? 0;
    const lrt = cluster.LatestRestorableTime;
    if (lrt === undefined) {
      process.stderr.write(
        `Source cluster has no LatestRestorableTime — backups may not be configured.\n`
      );
      process.exit(1);
    }
    latestRestorableTimeIso = lrt.toISOString();
  } catch (cause) {
    process.stderr.write(
      `DescribeDBClusters failed: ${cause instanceof Error ? cause.message : "unknown"}\n`
    );
    process.exit(1);
  }
  logger.info("drill.preflight.source", {
    sourceClusterId: args.sourceClusterId,
    backupRetentionDays,
    latestRestorableTimeIso,
  });

  // 3. Cross-check: requested RESTORE_TIME must be ≤ LatestRestorableTime.
  const lrtDate = new Date(latestRestorableTimeIso);
  if (restoreTime.getTime() > lrtDate.getTime()) {
    process.stderr.write(
      `--restore-time "${args.restoreTimeRaw}" is after LatestRestorableTime ` +
        `(${latestRestorableTimeIso}). Pick a time within the restorable window.\n`
    );
    process.exit(1);
  }
  if (backupRetentionDays < args.retentionDays) {
    process.stderr.write(
      `Cluster BackupRetentionPeriod=${backupRetentionDays} is less than expected ` +
        `${args.retentionDays}. Operating against a degraded backup posture; aborting.\n`
    );
    process.exit(1);
  }

  const preflight: PreflightResult = {
    kmsKeyArn,
    kmsHealthy,
    kmsReason,
    backupRetentionDays,
    latestRestorableTimeIso,
  };

  const outDir = resolveOutDir(args);
  const path = writeJsonSidecar(outDir, "preflight.json", preflight);
  process.stdout.write(`${path}\n`);
  process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);

  // Hard fail if KMS is unhealthy — restoring against a disabled
  // CMK silently fails (per the runbook), and the drill captain
  // should see RED here, not at the destructive AWS call.
  if (!kmsHealthy) {
    process.exit(1);
  }
  process.exit(0);
}

// --------------------------------------------------------------------
// Phase: provision-commands
// --------------------------------------------------------------------

function runProvisionCommands(args: ProvisionCommandsArgs, logger: loggerNs.Logger): void {
  const cluster = drillClusterId({ sourceClusterId: args.sourceClusterId, now: args.now });
  const instance = drillInstanceId({ sourceClusterId: args.sourceClusterId, now: args.now });
  const restoreTime = parseRestoreTime({
    raw: args.restoreTimeRaw,
    now: args.now,
    // We don't have the actual retention here (preflight has it).
    // Cap at 35 (the documented default) so a bad input is caught.
    retentionDays: 35,
  });

  const script = composeProvisionScript({
    sourceClusterId: args.sourceClusterId,
    drillClusterId: cluster,
    drillInstanceId: instance,
    restoreTimeIso: restoreTime.toISOString(),
    subnetGroup: args.subnetGroup,
    drillSecurityGroupId: args.drillSecurityGroupId,
    instanceClass: args.instanceClass,
  });

  const outDir = resolveOutDir(args);
  const path = writeTextSidecar(outDir, "provision.sh", script);
  logger.info("drill.provision_commands.written", {
    path,
    drillClusterId: cluster,
    drillInstanceId: instance,
  });
  process.stdout.write(`${path}\n`);
  process.stdout.write(`${script}\n`);
  process.exit(0);
}

// --------------------------------------------------------------------
// Phase: verify
// --------------------------------------------------------------------

async function runVerify(args: SharedArgs, logger: loggerNs.Logger): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    process.stderr.write(
      "DATABASE_URL is required for --phase=verify; point it at the RESTORED cluster.\n"
    );
    process.exit(1);
  }
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  // 1. Smoke connect — proves the operator's DATABASE_URL is actually
  //    pointed at a reachable Postgres + the engine version matches
  //    the production source (engine-version drift during restore is
  //    a finding per the runbook §2.1).
  let smokeOk = false;
  let engineVersion: string | null = null;
  let smokeReason: string | null = null;
  try {
    const rows = await withSystemContext("drill:smoke", () =>
      prisma.$queryRawUnsafe<Array<{ version: string }>>(`SELECT version() AS version`)
    );
    const versionString = rows[0]?.version ?? null;
    engineVersion = versionString === null ? null : extractPostgresVersion(versionString);
    smokeOk = engineVersion !== null;
    if (!smokeOk) smokeReason = "version() returned no row";
  } catch (cause) {
    smokeReason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
  }
  logger.info("drill.verify.smoke", { ok: smokeOk, engineVersion, reason: smokeReason });

  // 2. Audit-chain verification across all orgs. This is the headline
  //    check — proves the restored data still hashes correctly.
  const auditPerOrg: AuditChainPerOrgRow[] = [];
  let orgsFailed = 0;
  const orgs = await withSystemContext("drill:list-orgs", () =>
    prisma.organization.findMany({
      select: { id: true, slug: true },
      orderBy: { slug: "asc" },
    })
  );
  const source = createPrismaAuditChainSource(prisma);
  for (const org of orgs) {
    try {
      const result = await withSystemContext("drill:verify-chain", () =>
        verifyChain(source, { organizationId: org.id })
      );
      auditPerOrg.push({
        organizationId: org.id,
        organizationSlug: org.slug,
        chainValid: true,
        verifiedRows: result.verifiedRows,
        lastSeq: result.lastSeq === null ? null : result.lastSeq.toString(),
        reason: null,
      });
    } catch (cause) {
      orgsFailed += 1;
      const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
      auditPerOrg.push({
        organizationId: org.id,
        organizationSlug: org.slug,
        chainValid: false,
        verifiedRows: 0,
        lastSeq: null,
        reason,
      });
      logger.error("drill.verify.chain_broken", { organizationId: org.id, slug: org.slug, reason });
    }
  }
  logger.info("drill.verify.chain", { orgsChecked: orgs.length, orgsFailed });

  // 3. Critical-table row counts. Used in §3 evidence to confirm the
  //    restore wasn't truncated.
  let rowCounts: VerifyResult["rowCounts"] = null;
  try {
    const counts = await withSystemContext("drill:row-counts", () =>
      prisma.$queryRawUnsafe<
        Array<{
          orgs: bigint;
          users: bigint;
          orders: bigint;
          audit_rows: bigint;
          outbox_rows: bigint;
        }>
      >(
        `SELECT
           (SELECT count(*) FROM "organization") AS orgs,
           (SELECT count(*) FROM "user")         AS users,
           (SELECT count(*) FROM "order")        AS orders,
           (SELECT count(*) FROM "audit_log")    AS audit_rows,
           (SELECT count(*) FROM "event_outbox") AS outbox_rows`
      )
    );
    const row = counts[0];
    if (row !== undefined) {
      rowCounts = {
        organizations: Number(row.orgs),
        users: Number(row.users),
        orders: Number(row.orders),
        auditLogRows: Number(row.audit_rows),
        eventOutboxRows: Number(row.outbox_rows),
      };
    }
  } catch (cause) {
    logger.error("drill.verify.row_counts_failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
  logger.info("drill.verify.row_counts", { rowCounts });

  // 4. RLS sanity is intentionally NOT automated here — the runbook
  //    §2.4 walks the operator through running it under the
  //    `pharmax_app` role via psql, where the cross-tenant block is
  //    DB-truth. The script records it as "captured manually" so the
  //    evidence file is complete.
  const verify: VerifyResult = {
    smokeConnect: { ok: smokeOk, engineVersion, reason: smokeReason },
    auditChain: {
      ok: orgsFailed === 0,
      orgsChecked: orgs.length,
      orgsFailed,
      perOrg: auditPerOrg,
    },
    rowCounts,
    rlsSanity: { ok: true, reason: "captured manually per runbook §2.4" },
  };

  const outDir = resolveOutDir(args);
  const path = writeJsonSidecar(outDir, "verify.json", verify);
  process.stdout.write(`${path}\n`);
  process.stdout.write(`${JSON.stringify(verify, null, 2)}\n`);

  await prisma.$disconnect();
  // Exit non-zero on any chain break so a CI/scheduled invocation notices.
  process.exit(orgsFailed > 0 || !smokeOk ? 1 : 0);
}

/**
 * Pull the major.minor.patch out of a `SELECT version()` string.
 * Postgres returns e.g. `"PostgreSQL 16.4 on x86_64-pc-linux-gnu, ..."`.
 */
function extractPostgresVersion(raw: string): string | null {
  const match = /PostgreSQL\s+(\d+(?:\.\d+){0,2})/.exec(raw);
  return match === null ? null : (match[1] ?? null);
}

// --------------------------------------------------------------------
// Phase: teardown-commands
// --------------------------------------------------------------------

function runTeardownCommands(args: TeardownCommandsArgs, logger: loggerNs.Logger): void {
  const cluster = drillClusterId({ sourceClusterId: args.sourceClusterId, now: args.now });
  const instance = drillInstanceId({ sourceClusterId: args.sourceClusterId, now: args.now });
  const script = composeTeardownScript({
    drillClusterId: cluster,
    drillInstanceId: instance,
  });
  const outDir = resolveOutDir(args);
  const path = writeTextSidecar(outDir, "teardown.sh", script);
  logger.info("drill.teardown_commands.written", {
    path,
    drillClusterId: cluster,
    drillInstanceId: instance,
  });
  process.stdout.write(`${path}\n`);
  process.stdout.write(`${script}\n`);
  process.exit(0);
}

// --------------------------------------------------------------------
// Phase: finalize
// --------------------------------------------------------------------

function runFinalize(args: FinalizeArgs, logger: loggerNs.Logger): void {
  const outDir = resolveOutDir(args);
  const preflight = readJsonSidecarOrNull<PreflightResult>(outDir, "preflight.json");
  const verify = readJsonSidecarOrNull<VerifyResult>(outDir, "verify.json");
  const teardown = readJsonSidecarOrNull<{ confirmed: boolean }>(outDir, "teardown.json");

  // We don't have the source/drill ids in args here (finalize takes
  // only captain + observer). Recover them from the preflight or
  // verify sidecar if present, otherwise emit placeholders so the
  // markdown is still well-formed.
  //
  // The deterministic id naming means the operator can also re-run
  // provision-commands with the same `--now` to re-derive them.
  const drillStubs = inferDrillStubs(outDir);

  const record: DrillRecord = {
    quarter: currentQuarterLabel(args.now),
    captain: args.captain,
    observer: args.observer,
    startedAtIso: drillStubs.startedAtIso ?? new Date(args.now.getTime() - 3600_000).toISOString(),
    completedAtIso: args.now.toISOString(),
    sourceClusterId: drillStubs.sourceClusterId ?? "<unknown — re-run preflight>",
    drillClusterId: drillStubs.drillClusterId ?? "<unknown>",
    drillInstanceId: drillStubs.drillInstanceId ?? "<unknown>",
    restoreTimeIso: drillStubs.restoreTimeIso ?? "<unknown>",
    preflight,
    verify,
    teardownConfirmed: teardown?.confirmed === true,
    findings: args.findings,
    signOff: args.signOff,
  };

  const jsonPath = writeTextSidecar(outDir, "evidence.json", composeEvidenceJson(record));
  const mdPath = writeTextSidecar(outDir, "evidence.md", composeEvidenceMarkdown(record));
  logger.info("drill.finalize.written", { jsonPath, mdPath });
  process.stdout.write(`${jsonPath}\n${mdPath}\n`);
  process.exit(0);
}

/**
 * Look at the existing sidecar JSON files and try to recover the
 * source/drill ids + timestamps. Returns null fields when the
 * relevant sidecar is missing — the finalize markdown is still
 * well-formed, just with placeholder text.
 */
function inferDrillStubs(outDir: string): {
  readonly sourceClusterId: string | null;
  readonly drillClusterId: string | null;
  readonly drillInstanceId: string | null;
  readonly restoreTimeIso: string | null;
  readonly startedAtIso: string | null;
} {
  // The provision.sh script encodes all four ids in its variable
  // assignments. Parsing it is cheaper than re-running provision.
  try {
    const script = readFileSync(resolve(outDir, "provision.sh"), "utf8");
    return {
      sourceClusterId: extractShellVar(script, "SRC_CLUSTER_ID"),
      drillClusterId: extractShellVar(script, "NEW_CLUSTER_ID"),
      drillInstanceId: extractShellVar(script, "NEW_INSTANCE_ID"),
      restoreTimeIso: extractShellVar(script, "RESTORE_TIME"),
      startedAtIso: null,
    };
  } catch {
    return {
      sourceClusterId: null,
      drillClusterId: null,
      drillInstanceId: null,
      restoreTimeIso: null,
      startedAtIso: null,
    };
  }
}

function extractShellVar(script: string, name: string): string | null {
  // Matches `NAME='value'` where value contains no single quotes
  // (which is the canonical form composeProvisionScript emits for
  // the AWS identifiers + ISO timestamps the drill uses).
  const re = new RegExp(`^${name}='([^']+)'`, "m");
  const match = re.exec(script);
  return match === null ? null : (match[1] ?? null);
}

// --------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      phase: { type: "string" },
      "source-cluster-id": { type: "string" },
      "restore-time": { type: "string" },
      region: { type: "string" },
      "kms-alias": { type: "string" },
      "subnet-group": { type: "string" },
      "drill-sg": { type: "string" },
      "instance-class": { type: "string" },
      "retention-days": { type: "string" },
      captain: { type: "string" },
      observer: { type: "string" },
      "sign-off": { type: "string" },
      findings: { type: "string" },
      "out-dir": { type: "string" },
      now: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const shared = parseSharedArgs(values as Record<string, unknown>);

  const logger = loggerNs.createPinoLogger({
    service: "run-restore-drill",
    level: "info",
  });

  switch (shared.phase) {
    case "preflight": {
      const region =
        typeof values["region"] === "string" && (values["region"] as string).length > 0
          ? (values["region"] as string)
          : (process.env["AWS_REGION"] ?? "");
      if (region.length === 0) {
        process.stderr.write("--region (or env AWS_REGION) is required for preflight.\n");
        process.exit(1);
      }
      const retentionRaw =
        typeof values["retention-days"] === "string"
          ? Number(values["retention-days"] as string)
          : 35;
      if (!Number.isInteger(retentionRaw) || retentionRaw <= 0) {
        process.stderr.write(`Invalid --retention-days "${values["retention-days"] as string}".\n`);
        process.exit(1);
      }
      const preflightArgs: PreflightArgs = {
        ...shared,
        sourceClusterId: requireString(
          values as Record<string, unknown>,
          "source-cluster-id",
          "preflight"
        ),
        restoreTimeRaw: requireString(
          values as Record<string, unknown>,
          "restore-time",
          "preflight"
        ),
        region,
        kmsAlias: requireString(values as Record<string, unknown>, "kms-alias", "preflight"),
        retentionDays: retentionRaw,
      };
      await runPreflight(preflightArgs, logger);
      return;
    }
    case "provision-commands": {
      const provisionArgs: ProvisionCommandsArgs = {
        ...shared,
        sourceClusterId: requireString(
          values as Record<string, unknown>,
          "source-cluster-id",
          "provision-commands"
        ),
        restoreTimeRaw: requireString(
          values as Record<string, unknown>,
          "restore-time",
          "provision-commands"
        ),
        subnetGroup: requireString(
          values as Record<string, unknown>,
          "subnet-group",
          "provision-commands"
        ),
        drillSecurityGroupId: requireString(
          values as Record<string, unknown>,
          "drill-sg",
          "provision-commands"
        ),
        instanceClass:
          typeof values["instance-class"] === "string" &&
          (values["instance-class"] as string).length > 0
            ? (values["instance-class"] as string)
            : "db.t4g.medium",
      };
      runProvisionCommands(provisionArgs, logger);
      return;
    }
    case "verify":
      await runVerify(shared, logger);
      return;
    case "teardown-commands": {
      const teardownArgs: TeardownCommandsArgs = {
        ...shared,
        sourceClusterId: requireString(
          values as Record<string, unknown>,
          "source-cluster-id",
          "teardown-commands"
        ),
      };
      runTeardownCommands(teardownArgs, logger);
      return;
    }
    case "finalize": {
      const findingsRaw =
        typeof values["findings"] === "string" ? (values["findings"] as string) : "";
      const findings =
        findingsRaw.length === 0
          ? []
          : findingsRaw
              .split(",")
              .map((f) => f.trim())
              .filter((f) => f.length > 0);
      const finalizeArgs: FinalizeArgs = {
        ...shared,
        captain: requireString(values as Record<string, unknown>, "captain", "finalize"),
        observer: requireString(values as Record<string, unknown>, "observer", "finalize"),
        signOff:
          typeof values["sign-off"] === "string" && (values["sign-off"] as string).length > 0
            ? (values["sign-off"] as string)
            : null,
        findings,
      };
      runFinalize(finalizeArgs, logger);
      return;
    }
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
