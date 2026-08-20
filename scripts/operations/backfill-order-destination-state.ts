#!/usr/bin/env tsx
// scripts/operations/backfill-order-destination-state.ts
//
// Populate `order.destinationState` on orders created before that
// column existed.
//
// WHY A SCRIPT AND NOT A MIGRATION. The value is derived from
// `patient.stateEnc`, an envelope-encrypted column, so producing it
// needs a KMS decrypt per patient. SQL cannot do that, which is why
// `20260822000000_tenant_and_prescriber_credentials` adds the column
// nullable and leaves it empty.
//
// WHY IT MATTERS. Ship-to-state licensure (G-2) refuses an order with
// no recorded destination once a site declares its authorized states.
// That is the correct direction — "we do not know which state this is
// going to" is not a reason to ship it — but it means every in-flight
// order predating the column becomes unshippable at the moment a tenant
// switches enforcement on. Run this before that happens.
//
// ORDER OF OPERATIONS for onboarding a tenant onto G-2:
//   1. Record the site's pharmacy licences (RecordSiteCredential).
//   2. Run this backfill.
//   3. Declare the authorized states (SetSiteAuthorizedShipStates),
//      which is what switches enforcement on.
//
// Usage:
//   # Report how many orders are missing a destination, change nothing:
//   pnpm tsx scripts/operations/backfill-order-destination-state.ts --check
//
//   # Backfill one organization:
//   pnpm tsx scripts/operations/backfill-order-destination-state.ts \
//     --organization=<uuid>
//
//   # Every organization:
//   pnpm tsx scripts/operations/backfill-order-destination-state.ts --all
//
// Required env:
//   DATABASE_URL   Postgres connection string.
//   Plus whatever the configured KMS adapter needs — this decrypts.
//
// Exits:
//   0  backfilled, or --check printed.
//   1  failed.
//   2  bad arguments.
//
// Idempotent: only rows with a NULL `destinationState` are considered,
// so a re-run after a partial pass resumes rather than redoing. Safe to
// run against a live system — it writes one column on orders that have
// no value for it, touches no workflow state, and holds no long
// transaction.
//
// NOT EVERY ORDER CAN BE RESOLVED. A patient with no recorded state, or
// one whose record has been crypto-shredded, yields nothing. Those
// orders are reported and left NULL: inventing a state would be worse
// than refusing to ship, which is what the guard then does. The report
// is the list an operator has to work through by hand.

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { systemPrisma } from "@pharmax/database";
import { resolveDestinationState } from "@pharmax/orders";
import { applySystemSessionGuc, withSystemContext } from "@pharmax/tenancy";
import type { SessionGucExecutor } from "@pharmax/tenancy";

const REASON = "operations:backfill-order-destination-state";
/** Bounded so a large tenant does not load every order into memory. */
const BATCH_SIZE = 500;

interface Args {
  readonly mode: "check" | "backfill";
  readonly organizationId: string | null;
  readonly all: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args | null {
  let organizationId: string | null = null;
  let all = false;
  let check = false;

  for (const arg of argv) {
    if (arg === "--check") check = true;
    else if (arg === "--all") all = true;
    else if (arg.startsWith("--organization=")) organizationId = arg.slice(15);
    else return null;
  }

  if (!check && !all && organizationId === null) return null;
  if (all && organizationId !== null) return null;
  return { mode: check ? "check" : "backfill", organizationId, all };
}

interface Outcome {
  readonly considered: number;
  readonly resolved: number;
  readonly unresolvable: ReadonlyArray<string>;
}

async function run(args: Args): Promise<Outcome> {
  const where = {
    destinationState: null,
    ...(args.organizationId === null ? {} : { organizationId: args.organizationId }),
  } as const;

  let considered = 0;
  let resolved = 0;
  const unresolvable: string[] = [];

  // Keyset pagination on id: the set shrinks as we write, so an
  // offset would skip rows.
  let cursor: string | null = null;
  for (;;) {
    const batch = await withSystemContext(REASON, async () => {
      const rows = await systemPrisma.$transaction(async (tx) => {
        await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);
        return tx.order.findMany({
          where: { ...where, ...(cursor === null ? {} : { id: { gt: cursor } }) },
          select: {
            id: true,
            organizationId: true,
            patient: { select: { id: true, stateEnc: true } },
          },
          orderBy: { id: "asc" },
          take: BATCH_SIZE,
        });
      });
      return rows;
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const order of batch) {
      considered += 1;
      // Decrypt OUTSIDE a transaction: a KMS round-trip per order
      // inside one would hold a connection for the whole batch.
      const state = await resolveDestinationState({
        stateEnc: order.patient.stateEnc,
        organizationId: order.organizationId,
        patientId: order.patient.id,
      });

      if (state === null) {
        unresolvable.push(order.id);
        continue;
      }
      resolved += 1;

      if (args.mode === "backfill") {
        await withSystemContext(REASON, () =>
          systemPrisma.$transaction(async (tx) => {
            await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);
            // Re-check the null so a concurrent CreateOrder or a second
            // copy of this script cannot overwrite a fresh value.
            await tx.order.updateMany({
              where: { id: order.id, destinationState: null },
              data: { destinationState: state },
            });
          })
        );
      }
    }
  }

  return { considered, resolved, unresolvable };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "usage: backfill-order-destination-state.ts (--check | --all | --organization=<uuid>)\n"
    );
    process.exit(2);
  }

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  // Same boot as the other operational scripts that touch envelope
  // columns. Against a production KMS, swap this for the AWS adapter —
  // the seed guard below is what stops a run silently producing
  // undecryptable output because nobody set it.
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  const outcome = await run(args);
  const verb = args.mode === "check" ? "would resolve" : "resolved";

  process.stdout.write(
    `[backfill-destination-state] ${outcome.considered} order(s) without a destination; ` +
      `${verb} ${outcome.resolved}.\n`
  );

  if (outcome.unresolvable.length > 0) {
    process.stdout.write(
      `[backfill-destination-state] ${outcome.unresolvable.length} order(s) could NOT be ` +
        `resolved — the patient has no recorded state, or the record is crypto-shredded. ` +
        `These stay NULL and will be refused by ship-to-state enforcement; correct the ` +
        `patient address or cancel the order.\n`
    );
    for (const id of outcome.unresolvable.slice(0, 50)) {
      process.stdout.write(`  ${id}\n`);
    }
    if (outcome.unresolvable.length > 50) {
      process.stdout.write(`  ... and ${outcome.unresolvable.length - 50} more\n`);
    }
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`[backfill-destination-state] failed: ${String(cause)}\n`);
  process.exit(1);
});
