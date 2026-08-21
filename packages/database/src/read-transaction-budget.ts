/**
 * The time budget for a tenant-scoped READ transaction.
 *
 * ## Why this file exists
 *
 * `packages/command-bus/src/transaction-budget.ts` made command
 * transactions configurable and explained why inheriting a framework
 * default is not the same as choosing a budget. It fixed the command
 * bus's four `$transaction` call sites. It did not fix the read side,
 * and the read side is where a page render actually spends its
 * transactions: `readInTenantContext`, `readInOrgScope` and
 * `readInSystemContext` all called `$transaction` with no options, so
 * every projection on every page silently ran on Prisma's
 * `timeout: 5000` / `maxWait: 2000`.
 *
 * That gap is what kept failing the Playwright suite after the command
 * budgets were raised. `e2e/env.ts` set `COMMAND_TX_TIMEOUT_MS=60000`
 * and `COMMAND_TX_MAX_WAIT_MS=20000`, and runs still died with:
 *
 * ```text
 * Transaction API error: A commit cannot be executed on an expired
 * transaction. The timeout for this transaction was 5000 ms, however
 * 8277 ms passed since the start of the transaction.
 * Transaction API error: Unable to start a transaction in the given time.
 * ```
 *
 * `5000 ms` is the tell: no command transaction has been bounded at
 * 5000 ms since the command budgets were introduced, so the failing
 * transaction was a read. The raised command budgets were real, and
 * they were being applied to the wrong half of the surface.
 *
 * ## Why a read budget may be more generous than a command budget
 *
 * The command module argues against a generous timeout because a
 * command transaction holds `SELECT … FOR UPDATE` on the order row for
 * its whole duration, making the timeout the ceiling on lock-hold time
 * under contention. **That argument does not apply here.** A read scope
 * takes no row locks; it holds a pooled connection and sets a session
 * GUC. Over-running one delays whoever wants that connection next,
 * which is a throughput cost rather than a correctness or
 * head-of-line-blocking cost.
 *
 * So the two budgets are deliberately separate variables rather than
 * one shared pair. Tying them together would force the read side to
 * inherit a bound that exists to protect row locks it never takes.
 *
 * ## What this changes today
 *
 * Nothing, in production. `DEFAULT_READ_TRANSACTION_BUDGET` reproduces
 * Prisma's defaults exactly, for the same reason the command module
 * does: a timing change belongs in a commit that can point at a
 * measurement (Workstream D2 in `docs/GO_LIVE_PROGRAM.md`), and that
 * measurement has not been taken. This makes the value knowable and
 * overridable — which is what the E2E harness needs, since a lazy
 * webpack compile can land inside a read window and hold it for
 * seconds on a two-vCPU runner.
 */

/**
 * Bounds on one read transaction. Both values are milliseconds and map
 * directly onto Prisma's `$transaction` options.
 */
export interface ReadTransactionBudget {
  /**
   * Maximum wall-clock time the read transaction may remain open. Bounds
   * how long a pooled connection is held, NOT a lock — see the module
   * docblock for why that distinction licenses a different number than
   * the command budget.
   */
  readonly timeoutMs: number;

  /**
   * Maximum time to wait for a connection from the pool before giving
   * up. Exceeding this is the "Unable to start a transaction in the
   * given time" failure, and it means saturation rather than slowness —
   * a different remedy, so it is worth a separate number.
   *
   * Must not exceed `DATABASE_POOL_ACQUIRE_TIMEOUT_MS`: above that the
   * pg pool gives up first and the extra wait is unreachable.
   */
  readonly maxWaitMs: number;
}

/**
 * Prisma's own defaults, restated explicitly so adopting this module is
 * a no-op for production timing.
 */
export const DEFAULT_READ_TRANSACTION_BUDGET: ReadTransactionBudget = Object.freeze({
  timeoutMs: 5_000,
  maxWaitMs: 2_000,
});

/**
 * Translate a budget into the option bag Prisma expects.
 *
 * Kept as a function rather than inlined at the three `scoped-read.ts`
 * call sites so all three provably agree. A budget honoured by
 * `readInOrgScope` but not `readInSystemContext` would read as
 * configured while leaving part of the read surface on framework
 * defaults — which is precisely the bug this module exists to close.
 */
export function readTransactionOptionsFor(budget: ReadTransactionBudget): {
  timeout: number;
  maxWait: number;
} {
  return { timeout: budget.timeoutMs, maxWait: budget.maxWaitMs };
}

/**
 * Read a budget from the environment, falling back per field.
 *
 * Same two properties as the command resolver: not keyed on `NODE_ENV`
 * (that coupling is why `buildPgSslOptions` cannot be exercised by the
 * E2E suite at all), and a malformed value is ignored rather than
 * fatal, because a configuration typo should not stop the application
 * from booting on a documented default.
 */
export function readTransactionBudgetFromEnv(
  env: Record<string, string | undefined> = process.env
): ReadTransactionBudget {
  return {
    timeoutMs: positiveIntOr(env["READ_TX_TIMEOUT_MS"], DEFAULT_READ_TRANSACTION_BUDGET.timeoutMs),
    maxWaitMs: positiveIntOr(env["READ_TX_MAX_WAIT_MS"], DEFAULT_READ_TRANSACTION_BUDGET.maxWaitMs),
  };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
