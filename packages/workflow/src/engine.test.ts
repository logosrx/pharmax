// applyTransition contract — every transition the policy declares
// fires correctly, every disallowed transition is rejected with
// the right error code, and parameterized transitions enforce
// their parameter contracts.

import { describe, expect, it } from "vitest";

import { ORDER_WORKFLOW_COMMANDS, type OrderWorkflowCommand } from "./commands.js";
import {
  applyTransition,
  canTransition,
  getReachableCommands,
  type ApplyTransitionResult,
} from "./engine.js";
import {
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_PARAM_INVALID,
  WORKFLOW_PARAM_REQUIRED,
  WORKFLOW_STATE_TERMINAL,
} from "./errors.js";
import {
  CANCEL_FROM_STATES,
  HOLD_FROM_STATES,
  ORDER_STANDARD_V1,
  ORDER_STANDARD_V1_TRANSITIONS,
  REOPEN_TARGETS_BY_SOURCE,
} from "./policy-v1.js";
import { ALL_ORDER_STATES, ORDER_TERMINAL_STATES, type OrderState } from "./states.js";

const POLICY = ORDER_STANDARD_V1;

function apply(args: {
  currentState: OrderState;
  command: OrderWorkflowCommand;
  releaseToState?: OrderState;
  reopenToState?: OrderState;
}): ApplyTransitionResult {
  return applyTransition({ policy: POLICY, ...args });
}

// ---------------------------------------------------------------
// Primary forward path
// ---------------------------------------------------------------
const FORWARD_HAPPY_PATH: ReadonlyArray<{
  from: OrderState;
  command: OrderWorkflowCommand;
  to: OrderState;
}> = [
  { from: "RECEIVED", command: "START_TYPING", to: "TYPING_IN_PROGRESS" },
  {
    from: "TYPING_IN_PROGRESS",
    command: "COMPLETE_TYPING_REVIEW",
    to: "TYPED_READY_FOR_PV1",
  },
  { from: "TYPED_READY_FOR_PV1", command: "START_PV1", to: "PV1_IN_PROGRESS" },
  {
    from: "PV1_IN_PROGRESS",
    command: "APPROVE_PV1",
    to: "PV1_APPROVED_READY_FOR_FILL",
  },
  {
    from: "PV1_APPROVED_READY_FOR_FILL",
    command: "START_FILL",
    to: "FILL_IN_PROGRESS",
  },
  {
    from: "FILL_IN_PROGRESS",
    command: "COMPLETE_FILL",
    to: "FILL_COMPLETED_READY_FOR_FINAL",
  },
  {
    from: "FILL_COMPLETED_READY_FOR_FINAL",
    command: "START_FINAL_VERIFICATION",
    to: "FINAL_VERIFICATION_IN_PROGRESS",
  },
  {
    from: "FINAL_VERIFICATION_IN_PROGRESS",
    command: "APPROVE_FINAL_VERIFICATION",
    to: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
  },
  {
    from: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
    command: "RELEASE_TO_SHIP",
    to: "READY_TO_SHIP",
  },
  { from: "READY_TO_SHIP", command: "CONFIRM_SHIPMENT", to: "SHIPPED" },
];

describe("applyTransition — primary forward path", () => {
  for (const step of FORWARD_HAPPY_PATH) {
    it(`${step.command} from ${step.from} → ${step.to}`, () => {
      const result = apply({ currentState: step.from, command: step.command });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.fromState).toBe(step.from);
        expect(result.toState).toBe(step.to);
        expect(result.transitionId).toMatch(/^wf\.v1\./);
        expect(result.emits).toMatch(/^order\./);
      }
    });
  }
});

// ---------------------------------------------------------------
// Exception branches
// ---------------------------------------------------------------
describe("applyTransition — exception branches", () => {
  it("MARK_TYPING_MISSING_INFO from TYPING_IN_PROGRESS → TYPING_PENDING_MISSING_INFO", () => {
    const r = apply({
      currentState: "TYPING_IN_PROGRESS",
      command: "MARK_TYPING_MISSING_INFO",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("TYPING_PENDING_MISSING_INFO");
  });

  it("RESUME_TYPING_AFTER_INFO_RECEIVED loops back to TYPING_IN_PROGRESS", () => {
    const r = apply({
      currentState: "TYPING_PENDING_MISSING_INFO",
      command: "RESUME_TYPING_AFTER_INFO_RECEIVED",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("TYPING_IN_PROGRESS");
  });

  it("REJECT_PV1 from PV1_IN_PROGRESS → PV1_REJECTED", () => {
    const r = apply({ currentState: "PV1_IN_PROGRESS", command: "REJECT_PV1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("PV1_REJECTED");
  });

  it("REJECT_FINAL_VERIFICATION → FINAL_VERIFICATION_REJECTED", () => {
    const r = apply({
      currentState: "FINAL_VERIFICATION_IN_PROGRESS",
      command: "REJECT_FINAL_VERIFICATION",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("FINAL_VERIFICATION_REJECTED");
  });
});

// ---------------------------------------------------------------
// PLACE_HOLD coverage — every allow-listed source state.
// ---------------------------------------------------------------
describe("applyTransition — PLACE_HOLD", () => {
  for (const from of HOLD_FROM_STATES) {
    it(`PLACE_HOLD from ${from} → ON_HOLD`, () => {
      const r = apply({ currentState: from, command: "PLACE_HOLD" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.toState).toBe("ON_HOLD");
    });
  }

  it("PLACE_HOLD is rejected from ON_HOLD (cannot double-hold)", () => {
    const r = apply({ currentState: "ON_HOLD", command: "PLACE_HOLD" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_INVALID_TRANSITION);
  });

  it("PLACE_HOLD is rejected from SHIPPED (terminal)", () => {
    const r = apply({ currentState: "SHIPPED", command: "PLACE_HOLD" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_STATE_TERMINAL);
  });
});

// ---------------------------------------------------------------
// RELEASE_HOLD — parameterized
// ---------------------------------------------------------------
describe("applyTransition — RELEASE_HOLD", () => {
  it("returns to the supplied releaseToState", () => {
    const r = apply({
      currentState: "ON_HOLD",
      command: "RELEASE_HOLD",
      releaseToState: "TYPING_IN_PROGRESS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fromState).toBe("ON_HOLD");
      expect(r.toState).toBe("TYPING_IN_PROGRESS");
    }
  });

  it("rejects when releaseToState is missing", () => {
    const r = apply({ currentState: "ON_HOLD", command: "RELEASE_HOLD" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_PARAM_REQUIRED);
  });

  it("rejects when releaseToState is a terminal state", () => {
    const r = apply({
      currentState: "ON_HOLD",
      command: "RELEASE_HOLD",
      releaseToState: "SHIPPED",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_PARAM_INVALID);
  });

  it("rejects when releaseToState is ON_HOLD itself", () => {
    const r = apply({
      currentState: "ON_HOLD",
      command: "RELEASE_HOLD",
      releaseToState: "ON_HOLD",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_PARAM_INVALID);
  });

  it("RELEASE_HOLD is INVALID_TRANSITION from any state other than ON_HOLD", () => {
    const r = apply({
      currentState: "PV1_IN_PROGRESS",
      command: "RELEASE_HOLD",
      releaseToState: "TYPING_IN_PROGRESS",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_INVALID_TRANSITION);
  });
});

// ---------------------------------------------------------------
// REOPEN_FOR_CORRECTION — parameterized
// ---------------------------------------------------------------
describe("applyTransition — REOPEN_FOR_CORRECTION", () => {
  it("PV1_REJECTED → TYPING_IN_PROGRESS is allowed", () => {
    const r = apply({
      currentState: "PV1_REJECTED",
      command: "REOPEN_FOR_CORRECTION",
      reopenToState: "TYPING_IN_PROGRESS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("TYPING_IN_PROGRESS");
  });

  it("PV1_REJECTED → TYPED_READY_FOR_PV1 is allowed", () => {
    const r = apply({
      currentState: "PV1_REJECTED",
      command: "REOPEN_FOR_CORRECTION",
      reopenToState: "TYPED_READY_FOR_PV1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("TYPED_READY_FOR_PV1");
  });

  it("FINAL_VERIFICATION_REJECTED → FILL_IN_PROGRESS is allowed", () => {
    const r = apply({
      currentState: "FINAL_VERIFICATION_REJECTED",
      command: "REOPEN_FOR_CORRECTION",
      reopenToState: "FILL_IN_PROGRESS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toState).toBe("FILL_IN_PROGRESS");
  });

  it("rejects when reopenToState is missing", () => {
    const r = apply({
      currentState: "PV1_REJECTED",
      command: "REOPEN_FOR_CORRECTION",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_PARAM_REQUIRED);
  });

  it("rejects when reopenToState is not in the source's allow-list", () => {
    const r = apply({
      currentState: "PV1_REJECTED",
      command: "REOPEN_FOR_CORRECTION",
      // PV1_REJECTED is only allowed to rework to typing-side
      // states; FILL_IN_PROGRESS is the FINAL_REJECTED domain.
      reopenToState: "FILL_IN_PROGRESS",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_PARAM_INVALID);
  });

  it("REOPEN_FOR_CORRECTION is INVALID_TRANSITION from a non-rejected state", () => {
    const r = apply({
      currentState: "PV1_IN_PROGRESS",
      command: "REOPEN_FOR_CORRECTION",
      reopenToState: "TYPING_IN_PROGRESS",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_INVALID_TRANSITION);
  });

  it("REOPEN_TARGETS_BY_SOURCE — every entry's targets are non-terminal", () => {
    for (const [source, targets] of Object.entries(REOPEN_TARGETS_BY_SOURCE)) {
      for (const t of targets ?? []) {
        expect(ORDER_TERMINAL_STATES).not.toContain(t);
        expect(source).not.toBe(t);
      }
    }
  });
});

// ---------------------------------------------------------------
// CANCEL coverage — every allow-listed source state.
// ---------------------------------------------------------------
describe("applyTransition — CANCEL", () => {
  for (const from of CANCEL_FROM_STATES) {
    it(`CANCEL from ${from} → CANCELLED`, () => {
      const r = apply({ currentState: from, command: "CANCEL" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.toState).toBe("CANCELLED");
    });
  }

  it("CANCEL is rejected from SHIPPED (terminal)", () => {
    const r = apply({ currentState: "SHIPPED", command: "CANCEL" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_STATE_TERMINAL);
  });

  it("CANCEL is rejected from CANCELLED (terminal)", () => {
    const r = apply({ currentState: "CANCELLED", command: "CANCEL" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(WORKFLOW_STATE_TERMINAL);
  });
});

// ---------------------------------------------------------------
// Terminal-state immutability — every command rejected.
// ---------------------------------------------------------------
describe("applyTransition — terminal-state rejection", () => {
  for (const terminal of ORDER_TERMINAL_STATES) {
    for (const command of ORDER_WORKFLOW_COMMANDS) {
      it(`${command} from ${terminal} → WORKFLOW_STATE_TERMINAL`, () => {
        const r = apply({ currentState: terminal, command });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe(WORKFLOW_STATE_TERMINAL);
      });
    }
  }
});

// ---------------------------------------------------------------
// Reverse path — every forward transition has NO matching reverse
// transition. Walking back from SHIPPED toward RECEIVED must fail.
// ---------------------------------------------------------------
describe("applyTransition — reverse path is closed", () => {
  // Pair each forward transition with the "reverse" command we'd
  // expect a misbehaving caller to try. The engine should reject
  // ALL of them with INVALID_TRANSITION (or TERMINAL when source
  // is terminal).
  const REVERSE_PROBES: ReadonlyArray<{
    from: OrderState;
    command: OrderWorkflowCommand;
  }> = [
    { from: "TYPING_IN_PROGRESS", command: "START_TYPING" },
    { from: "TYPED_READY_FOR_PV1", command: "COMPLETE_TYPING_REVIEW" },
    { from: "PV1_IN_PROGRESS", command: "START_PV1" },
    { from: "FILL_IN_PROGRESS", command: "START_FILL" },
    { from: "READY_TO_SHIP", command: "RELEASE_TO_SHIP" },
  ];

  for (const probe of REVERSE_PROBES) {
    it(`${probe.command} from ${probe.from} (already past) → INVALID_TRANSITION`, () => {
      const r = apply({ currentState: probe.from, command: probe.command });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(WORKFLOW_INVALID_TRANSITION);
    });
  }
});

// ---------------------------------------------------------------
// Property-style coverage — every (state, command) pair has an
// outcome. Every pair NOT in the policy transitions array is
// either INVALID_TRANSITION (non-terminal source) or
// STATE_TERMINAL (terminal source).
// ---------------------------------------------------------------
describe("applyTransition — exhaustive (state × command) coverage", () => {
  it("every state × command pair returns a typed outcome", () => {
    const declaredPairs = new Set(
      ORDER_STANDARD_V1_TRANSITIONS.map((t) => `${t.command}|${t.fromState}`)
    );

    for (const state of ALL_ORDER_STATES) {
      for (const command of ORDER_WORKFLOW_COMMANDS) {
        const result = apply({
          currentState: state,
          command,
          // Supply both possible params so the engine never trips
          // on PARAM_REQUIRED in this matrix sweep; we only care
          // that the OUTCOME is correctly classified.
          releaseToState: "TYPING_IN_PROGRESS",
          reopenToState:
            state === "PV1_REJECTED"
              ? "TYPING_IN_PROGRESS"
              : state === "FINAL_VERIFICATION_REJECTED"
                ? "FILL_IN_PROGRESS"
                : "TYPING_IN_PROGRESS",
        });

        if (ORDER_TERMINAL_STATES.includes(state as never)) {
          // Terminal source: every command must be STATE_TERMINAL.
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe(WORKFLOW_STATE_TERMINAL);
        } else if (declaredPairs.has(`${command}|${state}`)) {
          // Declared transition: must succeed.
          expect(result.ok).toBe(true);
        } else {
          // Non-declared from a non-terminal source: INVALID_TRANSITION.
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe(WORKFLOW_INVALID_TRANSITION);
        }
      }
    }
  });
});

// ---------------------------------------------------------------
// Helpers: canTransition + getReachableCommands.
// ---------------------------------------------------------------
describe("canTransition", () => {
  it("agrees with applyTransition.ok for non-parameterized transitions", () => {
    for (const state of ALL_ORDER_STATES) {
      for (const command of ORDER_WORKFLOW_COMMANDS) {
        if (command === "RELEASE_HOLD" || command === "REOPEN_FOR_CORRECTION") continue;
        const engineOk = apply({ currentState: state, command }).ok;
        const helperOk = canTransition({
          policy: POLICY,
          currentState: state,
          command,
        });
        expect(helperOk).toBe(engineOk);
      }
    }
  });
});

describe("getReachableCommands", () => {
  it("returns empty for terminal states", () => {
    for (const terminal of ORDER_TERMINAL_STATES) {
      expect(getReachableCommands({ policy: POLICY, currentState: terminal })).toEqual([]);
    }
  });

  it("from RECEIVED includes START_TYPING and the cross-cutting PLACE_HOLD + CANCEL", () => {
    const r = getReachableCommands({ policy: POLICY, currentState: "RECEIVED" });
    expect(r).toContain("START_TYPING");
    expect(r).toContain("PLACE_HOLD");
    expect(r).toContain("CANCEL");
  });

  it("from ON_HOLD returns RELEASE_HOLD + CANCEL only", () => {
    const r = getReachableCommands({ policy: POLICY, currentState: "ON_HOLD" });
    expect(new Set(r)).toEqual(new Set(["RELEASE_HOLD", "CANCEL"]));
  });

  it("returned commands have NO duplicates", () => {
    for (const state of ALL_ORDER_STATES) {
      const r = getReachableCommands({ policy: POLICY, currentState: state });
      expect(new Set(r).size).toBe(r.length);
    }
  });
});
