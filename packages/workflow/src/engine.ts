// Pure workflow engine.
//
// Contract:
//
//   - `applyTransition` is a TOTAL function over (currentState,
//     command). For every pair, it returns either `{ ok: true,
//     ... }` or `{ ok: false, code, reason }`. No exceptions, no
//     I/O, no clock — the engine is unit-testable in isolation
//     and reproducible across processes.
//   - The bus is the only caller in production. It maps the
//     error codes to PharmaxError instances (the engine doesn't
//     import error classes — keeping it dependency-light keeps
//     bundle/test cost down and makes the engine reusable from
//     UI affordance checks).
//   - The engine consumes a `OrderWorkflowPolicy` rather than
//     reaching into `ORDER_STANDARD_V1` directly. This is the
//     seam for future policy versions (`policy-v2.ts`); the bus
//     will look up the policy row by id+version, parse the
//     definition JSON, and hand the resulting object here.
//
// Determinism rule: same input → same output bytes. No use of
// Date, Math.random, ULID, or any other entropy source.

import type { OrderWorkflowCommand } from "./commands.js";
import {
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_PARAM_INVALID,
  WORKFLOW_PARAM_REQUIRED,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  type WorkflowErrorCode,
} from "./errors.js";
import type { MergedWorkflowPolicy } from "./policy-overlay.js";
import {
  REOPEN_TARGETS_BY_SOURCE,
  type AttestationRequirement,
  type OrderTransitionRow,
  type OrderWorkflowPolicy,
} from "./policy-v1.js";
import { isTerminalState, type OrderState } from "./states.js";

export interface ApplyTransitionInput {
  readonly policy: OrderWorkflowPolicy;
  readonly currentState: OrderState;
  readonly command: OrderWorkflowCommand;
  /**
   * Pre-hold state to return to. Required when `command` is
   * `RELEASE_HOLD`. Must be a non-terminal state (the engine
   * does not constrain it further; the bus / hold record
   * supplies a value the bus trusts).
   */
  readonly releaseToState?: OrderState;
  /**
   * Rework target. Required when `command` is
   * `REOPEN_FOR_CORRECTION`. Must be in the
   * `REOPEN_TARGETS_BY_SOURCE[currentState]` allow-list for the
   * source rejection state.
   */
  readonly reopenToState?: OrderState;
}

export type ApplyTransitionResult =
  | {
      readonly ok: true;
      readonly transitionId: string;
      readonly fromState: OrderState;
      readonly toState: OrderState;
      readonly emits: string;
    }
  | {
      readonly ok: false;
      readonly code: WorkflowErrorCode;
      readonly reason: string;
    };

export function applyTransition(input: ApplyTransitionInput): ApplyTransitionResult {
  // Terminal states reject ALL commands, including CANCEL. This
  // is the SOC-2 immutability rule — once an order is SHIPPED or
  // CANCELLED, no command may mutate it. Rework requires a new
  // order row, never a revival.
  if (isTerminalState(input.currentState)) {
    return {
      ok: false,
      code: WORKFLOW_STATE_TERMINAL,
      reason: `Order is in terminal state ${input.currentState}; no transitions allowed.`,
    };
  }

  const row = findTransition(input.policy.transitions, input.currentState, input.command);
  if (row === null) {
    // Distinguish "command exists but is not allowed from this
    // state" (INVALID_TRANSITION) from "command is not in the
    // policy at all" (UNKNOWN_COMMAND). The latter is a coding
    // bug — the bus's input schema should have caught it.
    const commandExistsInPolicy = input.policy.transitions.some((t) => t.command === input.command);
    if (!commandExistsInPolicy) {
      return {
        ok: false,
        code: WORKFLOW_UNKNOWN_COMMAND,
        reason: `Command ${input.command} is not defined in policy ${input.policy.code} v${input.policy.version}.`,
      };
    }
    return {
      ok: false,
      code: WORKFLOW_INVALID_TRANSITION,
      reason: `Command ${input.command} is not allowed from state ${input.currentState}.`,
    };
  }

  // Parameterized transitions need extra validation.
  if (row.requiresParam === "releaseToState") {
    if (input.releaseToState === undefined) {
      return {
        ok: false,
        code: WORKFLOW_PARAM_REQUIRED,
        reason: "RELEASE_HOLD requires `releaseToState`.",
      };
    }
    if (isTerminalState(input.releaseToState)) {
      return {
        ok: false,
        code: WORKFLOW_PARAM_INVALID,
        reason: `Cannot release hold into terminal state ${input.releaseToState}.`,
      };
    }
    if (input.releaseToState === "ON_HOLD") {
      return {
        ok: false,
        code: WORKFLOW_PARAM_INVALID,
        reason: "releaseToState cannot be ON_HOLD.",
      };
    }
    return {
      ok: true,
      transitionId: row.transitionId,
      fromState: input.currentState,
      toState: input.releaseToState,
      emits: row.emits,
    };
  }

  if (row.requiresParam === "reopenToState") {
    if (input.reopenToState === undefined) {
      return {
        ok: false,
        code: WORKFLOW_PARAM_REQUIRED,
        reason: "REOPEN_FOR_CORRECTION requires `reopenToState`.",
      };
    }
    const allowed = REOPEN_TARGETS_BY_SOURCE[input.currentState] ?? [];
    if (!allowed.includes(input.reopenToState)) {
      return {
        ok: false,
        code: WORKFLOW_PARAM_INVALID,
        reason: `reopenToState=${input.reopenToState} is not an allowed rework target from ${input.currentState}. Allowed: ${allowed.join(", ") || "(none)"}.`,
      };
    }
    return {
      ok: true,
      transitionId: row.transitionId,
      fromState: input.currentState,
      toState: input.reopenToState,
      emits: row.emits,
    };
  }

  // Static transition.
  return {
    ok: true,
    transitionId: row.transitionId,
    fromState: input.currentState,
    toState: row.toState,
    emits: row.emits,
  };
}

function findTransition(
  transitions: ReadonlyArray<OrderTransitionRow>,
  fromState: OrderState,
  command: OrderWorkflowCommand
): OrderTransitionRow | null {
  for (const row of transitions) {
    if (row.fromState === fromState && row.command === command) return row;
  }
  return null;
}

/**
 * UI/affordance helper. Returns true iff the `(currentState,
 * command)` pair has a transition row AND any required parameters
 * could be supplied (we don't validate the parameter values here
 * — that's the engine's job at apply time). Useful for hiding
 * buttons that would 409 anyway.
 */
export function canTransition(input: {
  readonly policy: OrderWorkflowPolicy;
  readonly currentState: OrderState;
  readonly command: OrderWorkflowCommand;
}): boolean {
  if (isTerminalState(input.currentState)) return false;
  return findTransition(input.policy.transitions, input.currentState, input.command) !== null;
}

/**
 * UI/affordance helper. Returns every command that could legally
 * fire from `currentState` under `policy`. Order matches the
 * transition table's declaration order so the UI gets a stable
 * ordering of action buttons.
 */
export function getReachableCommands(input: {
  readonly policy: OrderWorkflowPolicy;
  readonly currentState: OrderState;
}): ReadonlyArray<OrderWorkflowCommand> {
  if (isTerminalState(input.currentState)) return [];
  const seen = new Set<OrderWorkflowCommand>();
  const result: OrderWorkflowCommand[] = [];
  for (const row of input.policy.transitions) {
    if (row.fromState === input.currentState && !seen.has(row.command)) {
      seen.add(row.command);
      result.push(row.command);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier-2 helpers (overlay-aware command-bus integration).
//
// These thin wrappers exist so the bus, command handlers, and UI
// affordance code all consume the SAME `MergedWorkflowPolicy`
// shape. Without them, callers would have to reach into
// `merged.merged` to get the underlying `OrderWorkflowPolicy` —
// a leaky-abstraction tax that would invite drift across call
// sites. Each wrapper is a one-liner over the existing engine
// API; the value is in the typed surface, not the work.
// ---------------------------------------------------------------------------

/**
 * Resolve the transition row for `(currentState, command)`
 * against a merged policy. Same signature as `applyTransition`
 * but typed to the merged shape and returning the transition
 * row directly when the lookup succeeds.
 *
 * The bus uses this in step 11 (validate current state) and
 * step 12 (validate prerequisites) — it surfaces the typed
 * `transitionId` that handlers need to stamp on verification
 * records and the `transition` row that step 14 (update order
 * status) consults for the target state.
 */
export function validateTransition(input: {
  readonly merged: MergedWorkflowPolicy;
  readonly currentState: OrderState;
  readonly command: OrderWorkflowCommand;
  readonly releaseToState?: OrderState;
  readonly reopenToState?: OrderState;
}): ApplyTransitionResult {
  return applyTransition({
    policy: input.merged.merged,
    currentState: input.currentState,
    command: input.command,
    ...(input.releaseToState === undefined ? {} : { releaseToState: input.releaseToState }),
    ...(input.reopenToState === undefined ? {} : { reopenToState: input.reopenToState }),
  });
}

/**
 * Derive the target state for `(currentState, command)` under
 * the merged policy. Step 14 of the 20-step contract reads this
 * to issue the order status update.
 *
 * Returns `null` when no transition row matches — the bus is
 * expected to have already called `validateTransition` and
 * surfaced the typed error before reaching this helper, so a
 * `null` here is a programming bug (handler asked for a target
 * before validating).
 */
export function nextStatusFor(input: {
  readonly merged: MergedWorkflowPolicy;
  readonly currentState: OrderState;
  readonly command: OrderWorkflowCommand;
  readonly releaseToState?: OrderState;
  readonly reopenToState?: OrderState;
}): OrderState | null {
  const result = validateTransition(input);
  return result.ok ? result.toState : null;
}

/**
 * Descriptor for one declarative "extra write" the merged policy
 * declares for a transition. Today the only kind is
 * "attestation-required" (overlay's `addRequiredAttestations`
 * surface). Future expansion (e.g. extra audit fingerprint,
 * extra structured note) lands as a new kind without breaking
 * existing handlers — they ignore unknown kinds (forward-compat).
 */
export type ExtraWriteDescriptor = {
  readonly kind: "attestation-required";
  readonly transitionId: string;
  readonly requirements: ReadonlyArray<AttestationRequirement>;
};

/**
 * Returns the extra writes the merged policy demands for a given
 * transition. Step 13 of the 20-step contract consults this so
 * verification records can persist the resolved attestation set
 * (the `id` of every requirement that fired).
 *
 * For base v1 with no overlay, this is always an empty array.
 * Tier-2 overlays that add attestation requirements surface them
 * here; the handler's responsibility is to (a) collect the
 * required signatures and (b) record which requirement ids were
 * satisfied on the verification record.
 */
export function extraWritesFor(input: {
  readonly merged: MergedWorkflowPolicy;
  readonly transitionId: string;
}): ReadonlyArray<ExtraWriteDescriptor> {
  const map = input.merged.merged.attestationsByTransitionId;
  if (map === undefined) return [];
  const reqs = map[input.transitionId];
  if (reqs === undefined || reqs.length === 0) return [];
  return [
    {
      kind: "attestation-required",
      transitionId: input.transitionId,
      requirements: reqs,
    },
  ];
}

/**
 * Returns extra outbox events an overlay declares for a
 * transition. v1 overlays have NO event-emit surface (the
 * declarative shape is `forbid` + `addRequiredAttestations`
 * only); this function is the reserved seam for a future v2
 * overlay shape that would add e.g. "after-hours alert" or
 * "extra clinic-side notification" events.
 *
 * Returning `[]` today keeps the bus's step 18 (write
 * event_outbox) deterministic — the handler still controls the
 * canonical event set; overlays only ADD to it. When the v2
 * shape lands, this function adds the overlay-derived events to
 * the handler's emits.
 */
export function extraEventsFor(_input: {
  readonly merged: MergedWorkflowPolicy;
  readonly transitionId: string;
  readonly command: OrderWorkflowCommand;
}): ReadonlyArray<{
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}> {
  return [];
}
