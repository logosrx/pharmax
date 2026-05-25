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
import {
  REOPEN_TARGETS_BY_SOURCE,
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
