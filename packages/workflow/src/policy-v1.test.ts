// Policy structural invariants.
//
// These tests are the "schema" for ORDER_STANDARD_V1. If a future
// edit accidentally drops a transition, duplicates one, or
// introduces a transition into a terminal state, the failure
// surfaces here rather than as a hard-to-debug runtime mismatch
// in a phase-2 command handler.

import { describe, expect, it } from "vitest";

import { ORDER_STANDARD_V1, ORDER_STANDARD_V1_TRANSITIONS } from "./policy-v1.js";
import {
  ALL_ORDER_STATES,
  ORDER_PRIMARY_STATES,
  ORDER_TERMINAL_STATES,
  isTerminalState,
} from "./states.js";

describe("ORDER_STANDARD_V1 — structural invariants", () => {
  it("declares code=order.standard version=1", () => {
    expect(ORDER_STANDARD_V1.code).toBe("order.standard");
    expect(ORDER_STANDARD_V1.version).toBe(1);
  });

  it("states equals the canonical ALL_ORDER_STATES set", () => {
    expect(new Set(ORDER_STANDARD_V1.states)).toEqual(new Set(ALL_ORDER_STATES));
  });

  it("terminalStates equals ORDER_TERMINAL_STATES", () => {
    expect(new Set(ORDER_STANDARD_V1.terminalStates)).toEqual(new Set(ORDER_TERMINAL_STATES));
  });

  it("every transition fromState is a declared state", () => {
    for (const t of ORDER_STANDARD_V1_TRANSITIONS) {
      expect(ALL_ORDER_STATES).toContain(t.fromState);
    }
  });

  it("every transition toState is a declared state", () => {
    for (const t of ORDER_STANDARD_V1_TRANSITIONS) {
      expect(ALL_ORDER_STATES).toContain(t.toState);
    }
  });

  it("no transition originates from a terminal state", () => {
    for (const t of ORDER_STANDARD_V1_TRANSITIONS) {
      expect(isTerminalState(t.fromState)).toBe(false);
    }
  });

  it("transitionId values are unique", () => {
    const ids = ORDER_STANDARD_V1_TRANSITIONS.map((t) => t.transitionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("(command, fromState) pairs are unique (no two transitions for same key)", () => {
    const seen = new Set<string>();
    for (const t of ORDER_STANDARD_V1_TRANSITIONS) {
      const key = `${t.command}|${t.fromState}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("every non-terminal state is reachable as a toState from at least one transition (except RECEIVED)", () => {
    // RECEIVED is the genesis state created by the CreateOrder
    // command (a separate concern from the workflow engine); no
    // transition row produces it.
    const reachableTargets = new Set(ORDER_STANDARD_V1_TRANSITIONS.map((t) => t.toState));
    const expectedReachable = ALL_ORDER_STATES.filter((s) => s !== "RECEIVED");
    // RELEASE_HOLD has a sentinel toState (ON_HOLD) that the engine
    // overrides; the actual reachable targets through RELEASE_HOLD
    // are not in the static `toState` field. So we expect every
    // non-RECEIVED state to be EITHER a static toState OR
    // reachable via RELEASE_HOLD (= "any non-terminal state").
    // The strict check: every primary forward step state is statically
    // reachable, and every exception state is statically reachable.
    for (const s of expectedReachable) {
      if (
        s === "ON_HOLD" ||
        ORDER_PRIMARY_STATES.includes(s as never) ||
        s === "TYPING_PENDING_MISSING_INFO" ||
        s === "PV1_REJECTED" ||
        s === "FINAL_VERIFICATION_REJECTED" ||
        s === "CANCELLED"
      ) {
        expect(reachableTargets).toContain(s);
      }
    }
  });
});
