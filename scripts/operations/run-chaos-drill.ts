#!/usr/bin/env tsx
// scripts/operations/run-chaos-drill.ts
//
// CLI shell for chaos drills (printer outage, queue backpressure,
// Stripe outage). The scenario PROCEDURES — what to break, how, and
// what must hold — live in docs/operations/chaos-drills.md. This
// tool does the two mechanical parts so drill evidence is consistent
// across quarters and operators:
//
//   --phase=snapshot   Capture a labeled point-in-time snapshot of
//                      the four queue tables (event_outbox,
//                      webhook_delivery, print_job,
//                      stripe_webhook_event): row counts by status +
//                      age of the oldest non-terminal row. Run it at
//                      least three times per drill: baseline (before
//                      injection), during (fault active), recovery
//                      (after the fault is cleared and queues drain).
//
//   --phase=finalize   Read every snapshot-*.json in the drill
//                      folder and compose evidence.md + evidence.json
//                      from the operator's flags (hypothesis,
//                      injection, recovery, checks, findings,
//                      sign-off).
//
// Connection: run against STAGING with a DATABASE_URL that can see
// every org's queue rows (`pharmax_system` / the staging admin URL).
// Chaos drills are NEVER run against production.
//
// PHI: snapshots read GROUP BY status counts and MIN(created
// timestamps) only — no payloads, no order data, nothing patient-
// shaped ends up in the evidence artifacts.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

import {
  composeChaosEvidenceJson,
  composeChaosEvidenceMarkdown,
  isChaosScenario,
  CHAOS_SCENARIOS,
  type ChaosDrillRecord,
  type ChaosSnapshot,
  type QueueTableSnapshot,
  type StatusCount,
  type SuccessCheck,
} from "./chaos-drill-evidence.js";
import { currentQuarterLabel, utcDateStamp } from "./restore-drill-ids.js";

const USAGE = `
Usage: pnpm tsx scripts/operations/run-chaos-drill.ts \\
  --phase=<snapshot|finalize> --scenario=<${CHAOS_SCENARIOS.join("|")}> \\
  [phase-specific flags]

Phase flags:
  snapshot:
    --label=<name>          Snapshot label (baseline | during | recovery | free-form).
                            (uses DATABASE_URL; staging system role required)

  finalize:
    --captain=<name>
    --observer=<name>
    --hypothesis=<text>     What the drill set out to prove.
    --injection=<text>      Exact fault injected (knob / host / env var).
    --recovery=<text>       How the fault was cleared.
    --check=<PASS|FAIL: description>   Repeatable, one per success criterion.
    --findings=<f1>,<f2>,…  Optional comma-separated findings.
    --sign-off=<text>       Optional captain's sign-off note.

Shared flags:
  --out-dir=<dir>           Defaults to evidence/chaos-drills/<period>/<date>-<scenario>/.
  --environment=<name>      Defaults to "staging".
  --now=<iso>               Test-only override for the drill date.
  --help, -h
`.trim();

interface SharedArgs {
  readonly phase: "snapshot" | "finalize";
  readonly scenario: ChaosDrillRecord["scenario"];
  readonly outDir: string;
  readonly environment: string;
  readonly now: Date;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(1);
}

function parseCli(): {
  shared: SharedArgs;
  values: Record<string, string | boolean | string[] | undefined>;
} {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      scenario: { type: "string" },
      label: { type: "string" },
      captain: { type: "string" },
      observer: { type: "string" },
      hypothesis: { type: "string" },
      injection: { type: "string" },
      recovery: { type: "string" },
      check: { type: "string", multiple: true },
      findings: { type: "string" },
      "sign-off": { type: "string" },
      "out-dir": { type: "string" },
      environment: { type: "string" },
      now: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const phase = values.phase;
  if (phase !== "snapshot" && phase !== "finalize") {
    fail("--phase must be snapshot or finalize.");
  }
  const scenario = values.scenario;
  if (typeof scenario !== "string" || !isChaosScenario(scenario)) {
    fail(`--scenario must be one of: ${CHAOS_SCENARIOS.join(", ")}.`);
  }

  const now = typeof values.now === "string" ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    fail(`--now "${String(values.now)}" is not a parseable instant.`);
  }

  const outDir = resolve(
    typeof values["out-dir"] === "string"
      ? values["out-dir"]
      : join(
          "evidence",
          "chaos-drills",
          currentQuarterLabel(now),
          `${utcDateStamp(now)}-${scenario}`
        )
  );

  const environment = typeof values.environment === "string" ? values.environment : "staging";

  return { shared: { phase, scenario, outDir, environment, now }, values };
}

// ---------------------------------------------------------------------------
// snapshot phase
// ---------------------------------------------------------------------------

interface TableSpec {
  readonly table: QueueTableSnapshot["table"];
  readonly nonTerminalStatuses: ReadonlyArray<string>;
  readonly groupBy: () => Promise<ReadonlyArray<StatusCount>>;
  readonly oldestNonTerminal: () => Promise<Date | null>;
}

function tableSpecs(): ReadonlyArray<TableSpec> {
  return [
    {
      table: "event_outbox",
      nonTerminalStatuses: ["PENDING", "FAILED"],
      groupBy: async () => {
        const rows = await prisma.eventOutbox.groupBy({
          by: ["status"],
          _count: { _all: true },
        });
        return rows.map((r) => ({ status: r.status, count: r._count._all }));
      },
      oldestNonTerminal: async () => {
        const agg = await prisma.eventOutbox.aggregate({
          where: { status: { in: ["PENDING", "FAILED"] } },
          _min: { createdAt: true },
        });
        return agg._min.createdAt;
      },
    },
    {
      table: "webhook_delivery",
      nonTerminalStatuses: ["PENDING", "FAILED"],
      groupBy: async () => {
        const rows = await prisma.webhookDelivery.groupBy({
          by: ["status"],
          _count: { _all: true },
        });
        return rows.map((r) => ({ status: r.status, count: r._count._all }));
      },
      oldestNonTerminal: async () => {
        const agg = await prisma.webhookDelivery.aggregate({
          where: { status: { in: ["PENDING", "FAILED"] } },
          _min: { createdAt: true },
        });
        return agg._min.createdAt;
      },
    },
    {
      table: "print_job",
      nonTerminalStatuses: ["PENDING", "SENT"],
      groupBy: async () => {
        const rows = await prisma.printJob.groupBy({
          by: ["status"],
          _count: { _all: true },
        });
        return rows.map((r) => ({ status: r.status, count: r._count._all }));
      },
      oldestNonTerminal: async () => {
        const agg = await prisma.printJob.aggregate({
          where: { status: { in: ["PENDING", "SENT"] } },
          _min: { requestedAt: true },
        });
        return agg._min.requestedAt;
      },
    },
    {
      table: "stripe_webhook_event",
      nonTerminalStatuses: ["PENDING", "FAILED"],
      groupBy: async () => {
        const rows = await prisma.stripeWebhookEvent.groupBy({
          by: ["status"],
          _count: { _all: true },
        });
        return rows.map((r) => ({ status: r.status, count: r._count._all }));
      },
      oldestNonTerminal: async () => {
        const agg = await prisma.stripeWebhookEvent.aggregate({
          where: { status: { in: ["PENDING", "FAILED"] } },
          _min: { receivedAt: true },
        });
        return agg._min.receivedAt;
      },
    },
  ];
}

async function runSnapshot(shared: SharedArgs, label: string): Promise<void> {
  const capturedAt = new Date();
  const tables: QueueTableSnapshot[] = [];

  // System context: queue tables are a cross-tenant work surface —
  // the drill needs totals across every staging org, same as the
  // worker's own claim queries.
  await withSystemContext("scripts:chaos-drill-snapshot", async () => {
    for (const spec of tableSpecs()) {
      const byStatus = [...(await spec.groupBy())].sort((a, b) => a.status.localeCompare(b.status));
      const oldest = await spec.oldestNonTerminal();
      tables.push({
        table: spec.table,
        byStatus,
        oldestNonTerminalAgeSeconds:
          oldest === null ? null : Math.max(0, (capturedAt.getTime() - oldest.getTime()) / 1000),
      });
    }
  });

  const snapshot: ChaosSnapshot = {
    label,
    capturedAtIso: capturedAt.toISOString(),
    tables,
  };

  mkdirSync(shared.outDir, { recursive: true });
  const file = join(shared.outDir, `snapshot-${label}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`Wrote ${file}\n`);
  for (const table of tables) {
    const statuses =
      table.byStatus.length === 0
        ? "empty"
        : table.byStatus.map((s) => `${s.status}=${s.count}`).join(", ");
    process.stdout.write(`  ${table.table}: ${statuses}\n`);
  }
}

// ---------------------------------------------------------------------------
// finalize phase
// ---------------------------------------------------------------------------

function parseCheck(raw: string): SuccessCheck {
  const match = /^(PASS|FAIL)\s*:\s*(.+)$/i.exec(raw.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    fail(`--check "${raw}" must look like "PASS: description" or "FAIL: description".`);
  }
  return { pass: match[1].toUpperCase() === "PASS", description: match[2] };
}

function readSnapshots(outDir: string): ChaosSnapshot[] {
  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    fail(`Drill folder ${outDir} does not exist — run --phase=snapshot first.`);
  }
  const snapshots = entries
    .filter((name) => name.startsWith("snapshot-") && name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(outDir, name), "utf8")) as ChaosSnapshot);
  return snapshots.sort((a, b) => a.capturedAtIso.localeCompare(b.capturedAtIso));
}

function requireString(
  values: Record<string, string | boolean | string[] | undefined>,
  key: string
): string {
  const v = values[key];
  if (typeof v !== "string" || v.length === 0) {
    fail(`--${key} is required for finalize.`);
  }
  return v;
}

function runFinalize(
  shared: SharedArgs,
  values: Record<string, string | boolean | string[] | undefined>
): void {
  const snapshots = readSnapshots(shared.outDir);
  const checksRaw = values.check;
  const checks: SuccessCheck[] = Array.isArray(checksRaw) ? checksRaw.map(parseCheck) : [];
  const findingsRaw = values.findings;
  const findings =
    typeof findingsRaw === "string" && findingsRaw.length > 0
      ? findingsRaw.split(",").map((f) => f.trim())
      : [];
  const signOff = typeof values["sign-off"] === "string" ? values["sign-off"] : null;

  const record: ChaosDrillRecord = {
    scenario: shared.scenario,
    period: currentQuarterLabel(shared.now),
    environment: shared.environment,
    captain: requireString(values, "captain"),
    observer: requireString(values, "observer"),
    startedAtIso: snapshots[0]?.capturedAtIso ?? shared.now.toISOString(),
    completedAtIso: shared.now.toISOString(),
    hypothesis: requireString(values, "hypothesis"),
    injection: requireString(values, "injection"),
    recovery: requireString(values, "recovery"),
    snapshots,
    checks,
    findings,
    signOff,
  };

  writeFileSync(join(shared.outDir, "evidence.md"), composeChaosEvidenceMarkdown(record));
  writeFileSync(join(shared.outDir, "evidence.json"), composeChaosEvidenceJson(record));
  process.stdout.write(`Wrote ${join(shared.outDir, "evidence.md")}\n`);
  process.stdout.write(`Wrote ${join(shared.outDir, "evidence.json")}\n`);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    process.stdout.write(
      `NOTE: ${failed.length} success criterion/criteria FAILED — file findings in the ` +
        `risk register / remediation backlog per docs/operations/chaos-drills.md.\n`
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { shared, values } = parseCli();
  if (shared.phase === "snapshot") {
    const label = typeof values.label === "string" && values.label.length > 0 ? values.label : null;
    if (label === null) {
      fail("--label is required for snapshot (baseline | during | recovery | free-form).");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) {
      fail(`--label "${label}" must be lowercase alphanumeric/hyphen (it becomes a filename).`);
    }
    await runSnapshot(shared, label);
    await prisma.$disconnect();
    return;
  }
  runFinalize(shared, values);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `chaos-drill failed: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(2);
});
