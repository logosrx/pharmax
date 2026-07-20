#!/usr/bin/env tsx
// scripts/operations/republish-dead-outbox.ts
//
// Operator CLI for the DEAD-letter side of the event outbox.
//
// The drainer parks a row as DEAD when its handler exhausted every
// retry — including the (deliberate) case where a REQUIRED event
// type had no handler registered at the time. DEAD is terminal by
// design: nothing retries it automatically, because retrying into
// the same broken handler forever is how retry storms happen. This
// CLI is the OTHER half of that contract — once the underlying
// cause is fixed (handler shipped, vendor recovered, env var set),
// an operator re-publishes the parked rows and the drainer picks
// them up on its next tick.
//
// Usage:
//   # See what is parked (always safe):
//   pnpm outbox:republish -- --list
//
//   # Re-publish specific rows:
//   pnpm outbox:republish -- --ids=<uuid>,<uuid> --yes
//
//   # Re-publish every DEAD row of one event type (optionally one org):
//   pnpm outbox:republish -- --event-type=order.sla_breach_escalated.v1 [--org=<uuid>] --yes
//
// Required env:
//   DATABASE_URL   Postgres connection string.
//
// Exits:
//   0  listed, or re-published >= 1 row.
//   1  bad arguments, or a re-publish matched zero rows.
//
// Notes:
//   - Re-publish resets status → PENDING, attempts → 0, and clears
//     the retry schedule, giving the row a full fresh retry budget.
//     `lastError` is preserved until the drainer overwrites it so
//     the row's history stays inspectable mid-flight.
//   - Handlers are idempotent by contract (billingEventKey uniques,
//     notification idempotency keys, command-bus idempotency), so
//     re-publishing a row whose side effect PARTIALLY happened is
//     safe — that is the same at-least-once semantic the drainer
//     already operates under.
//   - Requires --yes for any mutation. --list never mutates.
//   - PHI: this CLI prints event TYPE, ids, timestamps, and
//     lastError — never row payloads.

import { parseArgs } from "node:util";

import { prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage:
  pnpm outbox:republish -- --list
  pnpm outbox:republish -- --ids=<uuid>,<uuid> --yes
  pnpm outbox:republish -- --event-type=<name.vN> [--org=<uuid>] --yes

Required env:
  DATABASE_URL   Postgres connection string.
`.trim();

export interface RepublishSelector {
  readonly kind: "ids" | "event-type";
  readonly ids?: ReadonlyArray<string>;
  readonly eventType?: string;
  readonly organizationId?: string;
}

/**
 * Build the Prisma `where` for a re-publish selection. Always pins
 * `status: "DEAD"` — this tool NEVER touches PENDING/FAILED rows
 * (those are the drainer's), and re-running the same selector after
 * a successful re-publish matches nothing (idempotent CLI).
 * Exported for tests.
 */
export function buildRepublishWhere(selector: RepublishSelector): Record<string, unknown> {
  if (selector.kind === "ids") {
    return { status: "DEAD", id: { in: [...(selector.ids ?? [])] } };
  }
  return {
    status: "DEAD",
    eventType: selector.eventType,
    ...(selector.organizationId !== undefined ? { organizationId: selector.organizationId } : {}),
  };
}

interface ParsedCli {
  readonly mode: "list" | "republish";
  readonly selector?: RepublishSelector;
  readonly confirmed: boolean;
}

export function parseCli(argv: ReadonlyArray<string>): ParsedCli | { readonly error: string } {
  const { values } = parseArgs({
    // `pnpm outbox:republish -- --list` forwards the `--` separator
    // itself; strip it so parseArgs doesn't treat what follows as
    // positionals.
    args: argv.filter((a) => a !== "--"),
    options: {
      list: { type: "boolean" },
      ids: { type: "string" },
      "event-type": { type: "string" },
      org: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    return { mode: "list", confirmed: false };
  }

  const ids =
    typeof values.ids === "string"
      ? values.ids
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  const eventType = typeof values["event-type"] === "string" ? values["event-type"] : undefined;

  if (ids.length > 0 && eventType !== undefined) {
    return { error: "Pass EITHER --ids OR --event-type, not both." };
  }
  if (ids.length === 0 && eventType === undefined) {
    return { mode: "list", confirmed: false };
  }

  const selector: RepublishSelector =
    ids.length > 0
      ? { kind: "ids", ids }
      : {
          kind: "event-type",
          eventType: eventType as string,
          ...(typeof values.org === "string" ? { organizationId: values.org } : {}),
        };

  return { mode: "republish", selector, confirmed: values.yes === true };
}

async function listDeadRows(): Promise<void> {
  await withSystemContext("scripts:republish-dead-outbox:list", async () => {
    const groups = await prisma.eventOutbox.groupBy({
      by: ["eventType", "organizationId"],
      where: { status: "DEAD" },
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });

    if (groups.length === 0) {
      console.log("No DEAD outbox rows. Nothing to re-publish.");
      return;
    }

    console.log(`DEAD outbox rows (${groups.length} group(s)):\n`);
    for (const g of groups) {
      console.log(
        `  ${g.eventType}  org=${g.organizationId}  count=${g._count._all}` +
          `  oldest=${g._min.createdAt?.toISOString() ?? "?"}  newest=${g._max.createdAt?.toISOString() ?? "?"}`
      );
    }

    // Newest few rows with their parked error for triage.
    const recent = await prisma.eventOutbox.findMany({
      where: { status: "DEAD" },
      select: { id: true, eventType: true, organizationId: true, attempts: true, lastError: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    console.log(`\nNewest ${recent.length} row(s):\n`);
    for (const row of recent) {
      console.log(`  ${row.id}  ${row.eventType}  attempts=${row.attempts}`);
      console.log(`    lastError: ${row.lastError ?? "(none)"}`);
    }
    console.log(
      "\nRe-publish with:\n  pnpm outbox:republish -- --ids=<uuid>,... --yes\n" +
        "  pnpm outbox:republish -- --event-type=<name.vN> [--org=<uuid>] --yes"
    );
  });
}

async function republish(selector: RepublishSelector): Promise<number> {
  return withSystemContext("scripts:republish-dead-outbox:republish", async () => {
    const where = buildRepublishWhere(selector);
    const result = await prisma.eventOutbox.updateMany({
      where,
      data: {
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: null,
        dispatchedAt: null,
      },
    });
    return result.count;
  });
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.mode === "list") {
    await listDeadRows();
    return;
  }

  if (!parsed.confirmed) {
    console.error(
      "Re-publishing mutates outbox state and re-runs side effects (idempotency keys dedupe " +
        "completed work). Re-run with --yes to confirm.\n\n" +
        USAGE
    );
    process.exitCode = 1;
    return;
  }

  const count = await republish(parsed.selector!);
  if (count === 0) {
    console.error("No DEAD rows matched the selector. Nothing re-published.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Re-published ${count} row(s) → PENDING with a fresh retry budget. ` +
      "The worker's outbox drainer will pick them up on its next tick."
  );
}

// Only execute when run as a CLI (tests import the pure helpers).
const isDirectRun = process.argv[1]?.includes("republish-dead-outbox") ?? false;
if (isDirectRun) {
  main()
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
