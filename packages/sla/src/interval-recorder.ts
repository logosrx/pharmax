import type { PrismaTxClient } from "@pharmax/command-bus";
import { OrderStageIntervalKind, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

export const SLA_INTERVAL_ALREADY_OPEN = "SLA_INTERVAL_ALREADY_OPEN";
export const SLA_INTERVAL_NONE_OPEN = "SLA_INTERVAL_NONE_OPEN";
export const SLA_INTERVAL_KIND_MISMATCH = "SLA_INTERVAL_KIND_MISMATCH";
export const SLA_INTERVAL_COMMAND_UNMAPPED = "SLA_INTERVAL_COMMAND_UNMAPPED";
export const SLA_INTERVAL_NEGATIVE_DURATION = "SLA_INTERVAL_NEGATIVE_DURATION";
export const SLA_INTERVAL_RACE_LOST = "SLA_INTERVAL_RACE_LOST";

/** Postgres unique-violation code surfaced by Prisma. */
const PRISMA_UNIQUE_VIOLATION = "P2002";

export { OrderStageIntervalKind };

export interface OpenStageIntervalInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly siteId: string;
  readonly kind: OrderStageIntervalKind;
  readonly startedAt: Date;
  readonly commandLogId: string;
  readonly actorUserId?: string | null;
}

export interface CloseOpenStageIntervalInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly endedAt: Date;
  readonly commandLogId: string;
  readonly expectedKind?: OrderStageIntervalKind;
}

export interface TransitionStageIntervalsInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly siteId: string;
  readonly closeKind: OrderStageIntervalKind;
  readonly openKind: OrderStageIntervalKind;
  readonly at: Date;
  readonly commandLogId: string;
  readonly actorUserId?: string | null;
}

/**
 * Opens the first wait interval when an order is received.
 */
export async function openInitialWaitBeforeTyping(
  input: Omit<OpenStageIntervalInput, "kind">
): Promise<{ readonly intervalId: string }> {
  return openStageInterval({
    ...input,
    kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
  });
}

export async function openStageInterval(
  input: OpenStageIntervalInput
): Promise<{ readonly intervalId: string }> {
  const existingOpen = await input.tx.orderStageInterval.findFirst({
    where: {
      organizationId: input.organizationId,
      orderId: input.orderId,
      endedAt: null,
    },
    select: { id: true, kind: true },
  });
  if (existingOpen !== null) {
    throw new errors.ConflictError({
      code: SLA_INTERVAL_ALREADY_OPEN,
      message: "Order already has an open stage interval.",
      metadata: {
        orderId: input.orderId,
        openIntervalId: existingOpen.id,
        openKind: existingOpen.kind,
        attemptedKind: input.kind,
      },
    });
  }

  // Schema invariant (prisma/schema.prisma OrderStageInterval): actorUserId
  // is only populated for ACTIVE intervals. WAIT_* rows always store NULL,
  // regardless of what the caller passes — enforced here so every code
  // path that creates an interval row (direct, transitionStageIntervals,
  // applyCommandStageIntervalTransition) honors the constraint.
  const actorUserId = isActiveIntervalKind(input.kind) ? (input.actorUserId ?? null) : null;

  try {
    const row = await input.tx.orderStageInterval.create({
      data: {
        organizationId: input.organizationId,
        orderId: input.orderId,
        siteId: input.siteId,
        kind: input.kind,
        startedAt: input.startedAt,
        actorUserId,
        openCommandLogId: input.commandLogId,
      },
      select: { id: true },
    });
    return { intervalId: row.id };
  } catch (cause) {
    // Defense in depth: the partial unique index
    // `order_stage_interval_one_open_per_order` (see migration
    // 20260528100000_phase3_order_stage_interval) enforces "at most
    // one open row per order" at the DB layer. The `findFirst` guard
    // above is the cheap first-pass check, but a concurrent writer
    // that bypasses the bus row lock can still race past it; the DB
    // catches the race and we translate P2002 back into our typed
    // `SLA_INTERVAL_ALREADY_OPEN` so callers see one error code for
    // both paths.
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === PRISMA_UNIQUE_VIOLATION
    ) {
      throw new errors.ConflictError({
        code: SLA_INTERVAL_ALREADY_OPEN,
        message: "Order already has an open stage interval (DB-detected race).",
        metadata: {
          orderId: input.orderId,
          attemptedKind: input.kind,
        },
        cause,
      });
    }
    throw cause;
  }
}

export async function closeOpenStageInterval(input: CloseOpenStageIntervalInput): Promise<void> {
  const open = await input.tx.orderStageInterval.findFirst({
    where: {
      organizationId: input.organizationId,
      orderId: input.orderId,
      endedAt: null,
    },
    select: { id: true, kind: true, startedAt: true },
  });
  if (open === null) {
    throw new errors.ConflictError({
      code: SLA_INTERVAL_NONE_OPEN,
      message: "No open stage interval exists for this order.",
      metadata: { orderId: input.orderId },
    });
  }
  if (input.expectedKind !== undefined && open.kind !== input.expectedKind) {
    throw new errors.ConflictError({
      code: SLA_INTERVAL_KIND_MISMATCH,
      message: "Open stage interval kind does not match the expected kind.",
      metadata: {
        orderId: input.orderId,
        expectedKind: input.expectedKind,
        actualKind: open.kind,
      },
    });
  }

  // Negative duration would silently corrupt SLA reports (the wait /
  // active time computed from these rows would be negative). Caused
  // by clock skew, a replay against an out-of-order command_log, or
  // a caller passing an `endedAt` derived from stale state. Fail
  // loud rather than write the bad row.
  if (input.endedAt.getTime() < open.startedAt.getTime()) {
    throw new errors.ConflictError({
      code: SLA_INTERVAL_NEGATIVE_DURATION,
      message: "endedAt precedes startedAt for the open stage interval.",
      metadata: {
        orderId: input.orderId,
        intervalId: open.id,
        kind: open.kind,
        startedAt: open.startedAt.toISOString(),
        endedAt: input.endedAt.toISOString(),
      },
    });
  }

  // updateMany with the `endedAt: null` predicate turns a concurrent
  // close into a count=0 result instead of a silent overwrite of the
  // prior `endedAt` / `closeCommandLogId`. The bus row lock on the
  // order row makes this race unreachable from within the command
  // bus, but a direct caller bypassing the bus would hit it — the
  // primitive defends its own invariant.
  const result = await input.tx.orderStageInterval.updateMany({
    where: { id: open.id, endedAt: null },
    data: {
      endedAt: input.endedAt,
      closeCommandLogId: input.commandLogId,
    },
  });
  if (result.count === 0) {
    throw new errors.ConflictError({
      code: SLA_INTERVAL_RACE_LOST,
      message: "Open stage interval was closed by a concurrent writer.",
      metadata: {
        orderId: input.orderId,
        intervalId: open.id,
        kind: open.kind,
      },
    });
  }
}

/**
 * Atomically closes the current interval and opens the next within
 * the same command transaction. `actorUserId` is passed through to
 * `openStageInterval`, which is the choke point that enforces the
 * "actor only on ACTIVE intervals" schema invariant — callers may
 * pass an actor unconditionally; it is silently coerced to NULL on
 * the row when `openKind` is a WAIT_* state.
 */
export async function transitionStageIntervals(
  input: TransitionStageIntervalsInput
): Promise<void> {
  await closeOpenStageInterval({
    tx: input.tx,
    organizationId: input.organizationId,
    orderId: input.orderId,
    endedAt: input.at,
    commandLogId: input.commandLogId,
    expectedKind: input.closeKind,
  });
  await openStageInterval({
    tx: input.tx,
    organizationId: input.organizationId,
    orderId: input.orderId,
    siteId: input.siteId,
    kind: input.openKind,
    startedAt: input.at,
    commandLogId: input.commandLogId,
    actorUserId: input.actorUserId ?? null,
  });
}

/**
 * Maps workflow commands to the interval pair they close/open.
 */
export const COMMAND_STAGE_INTERVAL_TRANSITION: Readonly<
  Partial<
    Record<
      string,
      {
        readonly close: OrderStageIntervalKind;
        readonly open: OrderStageIntervalKind;
      }
    >
  >
> = Object.freeze({
  StartTyping: {
    close: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
    open: OrderStageIntervalKind.TYPING_ACTIVE,
  },
  CompleteTypingReview: {
    close: OrderStageIntervalKind.TYPING_ACTIVE,
    open: OrderStageIntervalKind.WAIT_BEFORE_PV1,
  },
  StartPV1: {
    close: OrderStageIntervalKind.WAIT_BEFORE_PV1,
    open: OrderStageIntervalKind.PV1_ACTIVE,
  },
  ApprovePV1: {
    close: OrderStageIntervalKind.PV1_ACTIVE,
    open: OrderStageIntervalKind.WAIT_BEFORE_FILL,
  },
  StartFill: {
    close: OrderStageIntervalKind.WAIT_BEFORE_FILL,
    open: OrderStageIntervalKind.FILL_ACTIVE,
  },
  CompleteFill: {
    close: OrderStageIntervalKind.FILL_ACTIVE,
    open: OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
  },
  StartFinalVerification: {
    close: OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
    open: OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
  },
  ApproveFinalVerification: {
    close: OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
    open: OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
  },
  ReleaseToShip: {
    close: OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
    open: OrderStageIntervalKind.SHIPPING_ACTIVE,
  },
});

/**
 * Bus commands that close an interval without opening a new one
 * (terminal in SLA terms). Symmetric with
 * `COMMAND_STAGE_INTERVAL_TRANSITION` so the close-only pattern is
 * data, not code — extending it (e.g., closing the active interval
 * when `CancelOrder` lands) is a single-row edit.
 */
export const COMMAND_STAGE_INTERVAL_CLOSE_ONLY: Readonly<
  Partial<Record<string, { readonly close: OrderStageIntervalKind }>>
> = Object.freeze({
  ConfirmShipment: { close: OrderStageIntervalKind.SHIPPING_ACTIVE },
});

/**
 * Bus commands that mutate an order but deliberately leave SLA stage
 * intervals untouched today. Listing them explicitly turns the silent
 * no-op into a deliberate, code-reviewed decision: a new bus command
 * that touches an order must EITHER appear in
 * `COMMAND_STAGE_INTERVAL_TRANSITION`, OR in
 * `COMMAND_STAGE_INTERVAL_CLOSE_ONLY`, OR be added here with a comment
 * explaining the rationale — otherwise `applyCommandStageIntervalTransition`
 * throws `SLA_INTERVAL_COMMAND_UNMAPPED`.
 *
 * The six entries below are pending workflow-semantics decisions
 * tracked in `docs/IMPLEMENTATION_PLAN.md` under Phase 3 — look for
 * the bullet titled "SLA semantics for the 6 commands in
 * `KNOWN_NON_SLA_COMMANDS`". Per-command open questions and the
 * recommended (but not yet ratified) policy live there. Once a
 * decision is ratified the entry moves into the transition or
 * close-only tables and is deleted from here.
 */
export const KNOWN_NON_SLA_COMMANDS: ReadonlySet<string> = new Set([
  // Rejection routes the order to an exception state; should the
  // PV1_ACTIVE / FINAL_VERIFICATION_ACTIVE interval close + open a
  // new WAIT_AFTER_PV1_REJECT / WAIT_AFTER_FINAL_REJECT enum value,
  // or stay open through the rework loop? Recommended: close + new
  // WAIT_AFTER_*_REJECT kinds (un-buries rework cost from
  // first-pass pharmacist time).
  "RejectPV1",
  "RejectFinalVerification",
  // Hold / release semantics: doing nothing means held orders
  // accumulate active-stage time and look like SLA breaches the
  // pharmacy cannot fix. Recommended: add a HOLD_ACTIVE enum value;
  // PlaceHold closes current + opens HOLD_ACTIVE; ReleaseHold closes
  // HOLD_ACTIVE + opens whatever stage the release returns to
  // (handler reads it off `order_hold`).
  "PlaceHold",
  "ReleaseHold",
  // Terminal close. Recommended: join COMMAND_STAGE_INTERVAL_CLOSE_ONLY
  // (same shape as ConfirmShipment). The "cancelled while X" report
  // already has its answer in OrderCancellation.cancelledFromStatus
  // — no terminal interval row needed. Low-risk; can ship even while
  // (1)/(2) are debated.
  "CancelOrder",
  // Reopen routes back into a workflow state parameterized by
  // `reopenToState`. The next interval is data-driven so it can't
  // live in the static COMMAND_STAGE_INTERVAL_TRANSITION table.
  // Recommended: command handler calls transitionStageIntervals
  // directly with the resolved kind, keeping the lookup tables a
  // pure command-name → static-pair contract.
  "ReopenForCorrection",
]);

export async function applyCommandStageIntervalTransition(input: {
  readonly commandName: string;
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly siteId: string;
  readonly at: Date;
  readonly commandLogId: string;
  readonly actorUserId?: string | null;
}): Promise<void> {
  const closeOnly = COMMAND_STAGE_INTERVAL_CLOSE_ONLY[input.commandName];
  if (closeOnly !== undefined) {
    await closeOpenStageInterval({
      tx: input.tx,
      organizationId: input.organizationId,
      orderId: input.orderId,
      endedAt: input.at,
      commandLogId: input.commandLogId,
      expectedKind: closeOnly.close,
    });
    return;
  }

  const pair = COMMAND_STAGE_INTERVAL_TRANSITION[input.commandName];
  if (pair !== undefined) {
    await transitionStageIntervals({
      tx: input.tx,
      organizationId: input.organizationId,
      orderId: input.orderId,
      siteId: input.siteId,
      closeKind: pair.close,
      openKind: pair.open,
      at: input.at,
      commandLogId: input.commandLogId,
      actorUserId: input.actorUserId ?? null,
    });
    return;
  }

  if (KNOWN_NON_SLA_COMMANDS.has(input.commandName)) {
    return;
  }

  // Fail loud rather than silently leave the order's open interval
  // unclosed. Catches typos in caller-supplied command names and
  // forces every new bus command that touches an order to make an
  // explicit, code-reviewed SLA decision (transition, close-only,
  // or "deliberately no SLA effect").
  throw new errors.InternalError({
    code: SLA_INTERVAL_COMMAND_UNMAPPED,
    message: "Command name has no SLA stage-interval mapping.",
    metadata: { commandName: input.commandName, orderId: input.orderId },
  });
}

/**
 * True iff the interval kind represents user-owned active work. The
 * schema constraint on `order_stage_interval.actorUserId` ("populated
 * for ACTIVE intervals when a user owns the work") is mirrored here so
 * row writes can enforce it. The ACTIVE enum members all share the
 * `_ACTIVE` suffix; the test suite pins this invariant against the
 * Prisma enum so a future kind that breaks the convention fails CI
 * rather than silently leaking actor ids onto WAIT_* rows.
 */
export function isActiveIntervalKind(kind: OrderStageIntervalKind): boolean {
  return String(kind).endsWith("_ACTIVE");
}
