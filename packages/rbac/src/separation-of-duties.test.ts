// Separation of Duties tests.
//
// These are the rules that prevent a single actor from acting on
// both sides of a two-person check on the same order. Every cell
// in the SoD truth table is exercised:
//
//   - violation: SAME actor + a forbidden prior act → SoDViolation
//   - allowed:   DIFFERENT actor + same prior act → null
//   - allowed:   SAME actor + an UNRELATED prior act → null
//   - allowed:   no rule for the attempted permission → null
//   - throwing helper wraps the pure check correctly

import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "./permissions.js";
import {
  SOD_RULES,
  SOD_VIOLATION,
  checkSoD,
  requireNoSoDViolation,
  type ResourceAct,
} from "./separation-of-duties.js";

describe("SOD_RULES registry", () => {
  it("is non-empty and frozen", () => {
    expect(SOD_RULES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(SOD_RULES)).toBe(true);
  });

  it("every rule has unique id", () => {
    const ids = new Set<string>();
    for (const r of SOD_RULES) ids.add(r.id);
    expect(ids.size).toBe(SOD_RULES.length);
  });

  it("attempted permissions are all in the PERMISSIONS registry", () => {
    const valid = new Set<string>(Object.values(PERMISSIONS));
    for (const r of SOD_RULES) {
      expect(valid.has(r.attempted)).toBe(true);
      for (const f of r.forbiddenPriorActs) expect(valid.has(f)).toBe(true);
    }
  });

  it("no rule forbids itself (would always deny)", () => {
    for (const r of SOD_RULES) {
      expect(r.forbiddenPriorActs).not.toContain(r.attempted);
    }
  });
});

describe("checkSoD — violations", () => {
  it("same actor approved PV1, attempts FINAL → violation", () => {
    const history: ResourceAct[] = [
      { permission: PERMISSIONS.PV1_APPROVE, actorUserId: "user-1", atSequence: "01J0000001" },
    ];
    const v = checkSoD({
      attempted: PERMISSIONS.FINAL_APPROVE,
      actorUserId: "user-1",
      resourceHistory: history,
    });
    expect(v).not.toBeNull();
    expect(v!.ruleId).toBe("sod.pv1-final-same-actor");
    expect(v!.collidingPriorAct).toBe(PERMISSIONS.PV1_APPROVE);
    expect(v!.priorActSequence).toBe("01J0000001");
  });

  it("same actor completed typing, attempts PV1 → violation", () => {
    const history: ResourceAct[] = [
      { permission: PERMISSIONS.TYPING_COMPLETE, actorUserId: "user-2" },
    ];
    const v = checkSoD({
      attempted: PERMISSIONS.PV1_APPROVE,
      actorUserId: "user-2",
      resourceHistory: history,
    });
    expect(v).not.toBeNull();
    expect(v!.ruleId).toBe("sod.typing-pv1-same-actor");
  });

  it("same actor completed fill, attempts FINAL → violation", () => {
    const history: ResourceAct[] = [
      { permission: PERMISSIONS.FILL_COMPLETE, actorUserId: "user-3" },
    ];
    const v = checkSoD({
      attempted: PERMISSIONS.FINAL_APPROVE,
      actorUserId: "user-3",
      resourceHistory: history,
    });
    expect(v).not.toBeNull();
    expect(v!.ruleId).toBe("sod.fill-final-same-actor");
  });

  it("multiple forbidden priors → first match short-circuits deterministically", () => {
    const history: ResourceAct[] = [
      { permission: PERMISSIONS.FILL_COMPLETE, actorUserId: "user-1", atSequence: "01J0000001" },
      { permission: PERMISSIONS.PV1_APPROVE, actorUserId: "user-1", atSequence: "01J0000002" },
    ];
    const v = checkSoD({
      attempted: PERMISSIONS.FINAL_APPROVE,
      actorUserId: "user-1",
      resourceHistory: history,
    });
    expect(v).not.toBeNull();
    // The rule order in SOD_RULES puts pv1-final BEFORE fill-final.
    expect(v!.ruleId).toBe("sod.pv1-final-same-actor");
  });
});

describe("checkSoD — allowed paths", () => {
  it("different actor approved PV1 → final by user-2 is allowed", () => {
    const history: ResourceAct[] = [{ permission: PERMISSIONS.PV1_APPROVE, actorUserId: "user-1" }];
    const v = checkSoD({
      attempted: PERMISSIONS.FINAL_APPROVE,
      actorUserId: "user-2",
      resourceHistory: history,
    });
    expect(v).toBeNull();
  });

  it("same actor performed an unrelated prior act → allowed", () => {
    const history: ResourceAct[] = [
      { permission: PERMISSIONS.ORDERS_READ, actorUserId: "user-1" },
      { permission: PERMISSIONS.PV1_START, actorUserId: "user-1" },
    ];
    const v = checkSoD({
      attempted: PERMISSIONS.FINAL_APPROVE,
      actorUserId: "user-1",
      resourceHistory: history,
    });
    expect(v).toBeNull();
  });

  it("no rule for the attempted permission → allowed regardless of history", () => {
    const history: ResourceAct[] = [{ permission: PERMISSIONS.ORDERS_READ, actorUserId: "user-1" }];
    const v = checkSoD({
      attempted: PERMISSIONS.BILLING_READ,
      actorUserId: "user-1",
      resourceHistory: history,
    });
    expect(v).toBeNull();
  });

  it("empty history → allowed", () => {
    const v = checkSoD({
      attempted: PERMISSIONS.FINAL_APPROVE,
      actorUserId: "user-1",
      resourceHistory: [],
    });
    expect(v).toBeNull();
  });
});

describe("requireNoSoDViolation — throwing wrapper", () => {
  it("returns silently when the pure check passes", () => {
    expect(() =>
      requireNoSoDViolation({
        attempted: PERMISSIONS.FINAL_APPROVE,
        actorUserId: "user-1",
        resourceHistory: [],
        resourceRef: "order:01J0000ORDER",
        correlationId: "01ULID000000000000000000000",
        organizationId: "org-1",
      })
    ).not.toThrow();
  });

  it("throws AuthorizationError(SOD_VIOLATION) with PHI-free metadata", () => {
    try {
      requireNoSoDViolation({
        attempted: PERMISSIONS.FINAL_APPROVE,
        actorUserId: "user-1",
        resourceHistory: [
          { permission: PERMISSIONS.PV1_APPROVE, actorUserId: "user-1", atSequence: "01J0000001" },
        ],
        resourceRef: "order:01J0000ORDER",
        correlationId: "01ULID000000000000000000000",
        organizationId: "org-1",
      });
      throw new Error("expected throw");
    } catch (e: unknown) {
      expect(e).toMatchObject({
        code: SOD_VIOLATION,
        httpStatus: 403,
        metadata: {
          ruleId: "sod.pv1-final-same-actor",
          attemptedPermission: PERMISSIONS.FINAL_APPROVE,
          collidingPriorAct: PERMISSIONS.PV1_APPROVE,
          priorActSequence: "01J0000001",
          resourceRef: "order:01J0000ORDER",
          actorUserId: "user-1",
          organizationId: "org-1",
          correlationId: "01ULID000000000000000000000",
        },
      });
    }
  });

  it("metadata contains NO patient identifiers", () => {
    try {
      requireNoSoDViolation({
        attempted: PERMISSIONS.FINAL_APPROVE,
        actorUserId: "user-1",
        resourceHistory: [{ permission: PERMISSIONS.PV1_APPROVE, actorUserId: "user-1" }],
        resourceRef: "order:01J0000ORDER",
        correlationId: "01ULID000000000000000000000",
        organizationId: "org-1",
      });
      throw new Error("expected throw");
    } catch (e: unknown) {
      const err = e as { metadata: Readonly<Record<string, unknown>> };
      // PHI invariant: nothing here should ever leak a name, DOB, NDC, or PHI field name.
      const serialized = JSON.stringify(err.metadata);
      expect(serialized).not.toMatch(/firstName|lastName|dob|ssn|phone|email|address/i);
    }
  });
});
