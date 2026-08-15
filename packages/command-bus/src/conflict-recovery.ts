// Shared interpretation of a `command_log` unique violation.
//
// Both executors serialize same-key attempts on the
// `@@unique([organizationId, commandName, idempotencyKey])` index on
// `command_log`. A P2002 there is not a bug: it means another attempt
// with this exact key already reached the table, and the bus has to
// decide whether this attempt replays that one's recorded outcome,
// re-executes, or refuses. That decision lives HERE so the tenant and
// system executors cannot drift — a forked copy of it is how a replay
// silently becomes a second money mutation.
//
// This module CLASSIFIES; it does not act. The action differs between
// the two executors, and the reason is not stylistic: WHERE each one
// writes `command_log` changes what a FAILED row proves.
//
//   - `executeCommand` writes `command_log` PRE-transaction, so a
//     FAILED row provably belongs to an attempt whose mutation rolled
//     back. Reusing that row and re-executing is the standard
//     idempotency-key retry.
//   - `executeSystemCommand` writes `command_log` INSIDE the handler
//     transaction (the target org id isn't known until the handler
//     resolves it), so a failed attempt leaves NO row at all. A FAILED
//     row there does not prove the mutation was undone, and reusing it
//     would re-execute while bypassing the one unique index that is
//     preventing the double apply.
//
// RLS invariant: `command_log` is ENABLE + FORCE row-level security.
// The `tx` passed in MUST already have applied its session GUC (tenant
// or system), and it MUST be a FRESH transaction — Postgres aborts the
// transaction that hit the violation and refuses further statements
// in it.

import { CommandStatus, Prisma } from "@pharmax/database";

import { commandInFlightError } from "./errors.js";
import type { PrismaTxClient } from "./types.js";

/** The conflicting `command_log` row, as the bus needs to see it. */
export interface PriorCommandAttempt {
  readonly id: string;
  readonly status: CommandStatus;
  /** Redacted output of the prior attempt; null until it SUCCEEDED. */
  readonly responsePayload: Prisma.JsonValue | null;
}

export type CommandLogConflict =
  /** Prior attempt committed and completed — the caller replays it. */
  | { readonly kind: "prior-succeeded"; readonly prior: PriorCommandAttempt }
  /** Prior attempt is recorded FAILED — see the header on who may retry. */
  | { readonly kind: "prior-failed"; readonly prior: PriorCommandAttempt };

export interface ClassifyCommandLogConflictInput {
  readonly organizationId: string;
  readonly commandName: string;
  readonly idempotencyKey: string;
}

/**
 * Read the conflicting `command_log` row and classify it.
 *
 * Throws `ConflictError(COMMAND_IN_FLIGHT)` — a stable 409 the caller
 * should retry with the SAME key — when a concurrent attempt is still
 * RUNNING/PENDING, and when the conflicting row is no longer there
 * (the concurrent attempt rolled back between the violation and this
 * read, so an immediate retry will succeed).
 */
export async function classifyCommandLogConflict(
  tx: PrismaTxClient,
  input: ClassifyCommandLogConflictInput
): Promise<CommandLogConflict> {
  const prior = await tx.commandLog.findUnique({
    where: {
      organizationId_commandName_idempotencyKey: {
        organizationId: input.organizationId,
        commandName: input.commandName,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true, status: true, responsePayload: true },
  });
  if (prior === null) {
    throw commandInFlightError({ commandName: input.commandName });
  }

  switch (prior.status) {
    case CommandStatus.SUCCEEDED:
      return { kind: "prior-succeeded", prior };
    case CommandStatus.FAILED:
      return { kind: "prior-failed", prior };
    case CommandStatus.RUNNING:
    case CommandStatus.PENDING:
      throw commandInFlightError({ commandName: input.commandName });
    default: {
      const _never: never = prior.status;
      throw new Error(`unhandled CommandStatus: ${String(_never)}`);
    }
  }
}

/**
 * Detect a Prisma P2002 unique-constraint violation on one of the
 * bus's bookkeeping tables. Prisma 7 sets `meta.modelName`;
 * older/adapter paths set only `meta.target` (the constrained
 * columns), so we match either.
 */
export function isUniqueViolation(err: unknown, model: "CommandLog" | "IdempotencyKey"): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const meta = (err.meta ?? {}) as { modelName?: unknown; target?: unknown };
  if (typeof meta.modelName === "string") {
    return meta.modelName === model;
  }
  if (Array.isArray(meta.target)) {
    const target = meta.target.map(String);
    // command_log:     (organizationId, commandName, idempotencyKey)
    // idempotency_key: (organizationId, commandName, key)
    return model === "CommandLog" ? target.includes("idempotencyKey") : target.includes("key");
  }
  return false;
}
