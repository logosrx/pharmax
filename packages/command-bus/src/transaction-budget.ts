/**
 * The time budget for a command's database transaction.
 *
 * ## Why this file exists
 *
 * Every critical mutation runs inside one Prisma interactive
 * transaction: set the RLS session GUC, lock the order row, write the
 * domain record, bump the version, then `order_event`, `audit_log`,
 * `event_outbox` and the idempotency row. Until this module, none of the
 * four `$transaction` call sites passed any options, so all four
 * silently inherited Prisma's defaults — `timeout: 5000`,
 * `maxWait: 2000`.
 *
 * Inheriting a default is not the same as choosing a budget, and the
 * difference surfaced in CI on 2026-08-17. A Playwright golden-path run
 * failed with:
 *
 * ```text
 * Transaction API error: A commit cannot be executed on an expired
 * transaction. The timeout for this transaction was 5000 ms, however
 * 10406 ms passed since the start of the transaction.
 * Transaction API error: Unable to start a transaction in the given time.
 * ```
 *
 * That run was against `next dev`, where a lazy webpack compile can land
 * inside the transaction window and hold it open for seconds, so the
 * absolute number does not transfer to production. What does transfer is
 * the shape of the failure: nobody had decided what a command is allowed
 * to cost, so nothing could be tuned, alarmed, or argued about.
 *
 * ## Why the default is not simply raised
 *
 * The transaction holds `SELECT … FOR UPDATE` on the order row for its
 * whole duration, so the timeout is also the **upper bound on lock-hold
 * time** under contention. A generous timeout converts a fast failure
 * into a slow queue: raising it would trade a visible error for
 * invisible latency on every other operator touching that order.
 *
 * So `DEFAULT_TRANSACTION_BUDGET` deliberately reproduces Prisma's
 * defaults exactly. This module changes what is *knowable* and
 * *overridable*, not what production currently does — a behaviour change
 * belongs in a commit that can point at a measurement, which is
 * Workstream D2 in `docs/GO_LIVE_PROGRAM.md` and has not been run yet.
 *
 * ## Choosing a real budget later
 *
 * When D2 produces numbers, set `timeoutMs` from the measured p99 of the
 * transaction span with headroom, not from the worst case observed. A
 * command that legitimately needs more than a couple of seconds is
 * telling you it is doing too much inside the lock — the fix is to move
 * work after the commit and let a worker pick it up from
 * `event_outbox`, which is what that table is for.
 */

/**
 * Bounds on one command transaction. Both values are milliseconds and
 * map directly onto Prisma's `$transaction` options.
 */
export interface TransactionBudget {
  /**
   * Maximum wall-clock time the transaction may remain open before
   * Prisma aborts it. Also the ceiling on how long the command holds
   * its row lock, which is why it is not generous.
   */
  readonly timeoutMs: number;

  /**
   * Maximum time to wait for a connection from the pool before giving
   * up. Exceeding this is a saturation signal — the pool is too small
   * or transactions are holding connections too long — and it is worth
   * distinguishing from `timeoutMs` when reading an incident, because
   * the remedies are different.
   */
  readonly maxWaitMs: number;
}

/**
 * Prisma's own defaults, restated explicitly.
 *
 * Keeping these identical to the framework defaults means adopting this
 * module is a no-op for production timing. See the module docblock for
 * why that is deliberate.
 */
export const DEFAULT_TRANSACTION_BUDGET: TransactionBudget = Object.freeze({
  timeoutMs: 5_000,
  maxWaitMs: 2_000,
});

/**
 * Translate an optional budget into the option bag Prisma expects,
 * substituting `DEFAULT_TRANSACTION_BUDGET` for a missing one.
 *
 * Takes the budget rather than the whole `CommandBusConfiguration` so
 * this module needs no import from `configure.ts` — the dependency runs
 * one way only, which keeps a type-level cycle from forming between the
 * two files that every command path touches.
 *
 * Kept as a function rather than inlined at the four `$transaction` call
 * sites so that all four provably agree. A budget honoured by the tenant
 * executor but not the system executor would be worse than no budget at
 * all: it would read as configured while leaving half the surface on
 * framework defaults.
 */
export function transactionOptionsFor(budget: TransactionBudget | undefined): {
  timeout: number;
  maxWait: number;
} {
  const resolved = budget ?? DEFAULT_TRANSACTION_BUDGET;
  return { timeout: resolved.timeoutMs, maxWait: resolved.maxWaitMs };
}

/**
 * Read a budget from environment variables, falling back to
 * `DEFAULT_TRANSACTION_BUDGET` per field.
 *
 * Intended for composition roots. Two properties matter:
 *
 * - **Not keyed on `NODE_ENV`.** Behaviour that changes with
 *   `NODE_ENV` is how `packages/database` ended up unable to run the
 *   E2E suite against a production build; an explicit variable is
 *   inspectable and does not couple timing to bundling.
 * - **Invalid input is ignored, not fatal.** A malformed budget is a
 *   configuration typo, and refusing to boot the whole application over
 *   one would be a worse outcome than running with a documented
 *   default. Callers that want strictness should validate before
 *   calling.
 */
export function transactionBudgetFromEnv(
  env: Record<string, string | undefined>
): TransactionBudget {
  return {
    timeoutMs: positiveIntOr(env["COMMAND_TX_TIMEOUT_MS"], DEFAULT_TRANSACTION_BUDGET.timeoutMs),
    maxWaitMs: positiveIntOr(env["COMMAND_TX_MAX_WAIT_MS"], DEFAULT_TRANSACTION_BUDGET.maxWaitMs),
  };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
