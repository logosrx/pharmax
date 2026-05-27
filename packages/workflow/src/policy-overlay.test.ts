// mergePolicyWithOverlay contract — overlay tightening rules,
// loosening rejection, attestation augmentation, identity case.
//
// These tests pin the security invariant of the entire Tier-2
// extension surface (ADR-0019): the merged policy is at most as
// permissive as the base. If a future change to the merge function
// or overlay shape would let a tenant enable a transition the base
// forbids, one of these tests fails.

import { errors } from "@pharmax/platform-core";
import { describe, expect, it } from "vitest";

import { ORDER_WORKFLOW_COMMANDS } from "./commands.js";
import {
  OVERLAY_LOOSENS_BASE_POLICY,
  mergePolicyWithOverlay,
  type WorkflowPolicyOverlay,
} from "./policy-overlay.js";
import {
  ORDER_STANDARD_V1,
  type AttestationRequirement,
  type OrderWorkflowPolicy,
} from "./policy-v1.js";
import type { OrderState } from "./states.js";

const BASE: OrderWorkflowPolicy = ORDER_STANDARD_V1;

describe("mergePolicyWithOverlay — identity", () => {
  it("returns the base unchanged when overlay is empty", () => {
    const merged = mergePolicyWithOverlay(BASE, {});
    expect(merged).toBe(BASE);
    expect(merged.transitions).toBe(BASE.transitions);
    expect(merged.attestationsByTransitionId).toBeUndefined();
  });

  it("treats explicit-empty fields as no-op (object identity preserved)", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: {},
      addRequiredAttestations: {},
    });
    expect(merged).toBe(BASE);
  });

  it("preserves base policy code and version", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { REOPEN_FOR_CORRECTION: ["PV1_REJECTED"] },
    });
    expect(merged.code).toBe(BASE.code);
    expect(merged.version).toBe(BASE.version);
    expect(merged.states).toBe(BASE.states);
    expect(merged.terminalStates).toBe(BASE.terminalStates);
  });
});

describe("mergePolicyWithOverlay — tightening (forbidTransitionsFromStates)", () => {
  it("removes a single (command, fromState) transition", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { REOPEN_FOR_CORRECTION: ["PV1_REJECTED"] },
    });

    const survives = merged.transitions.some(
      (t) => t.command === "REOPEN_FOR_CORRECTION" && t.fromState === "PV1_REJECTED"
    );
    expect(survives).toBe(false);

    // Other REOPEN_FOR_CORRECTION rows still present.
    const fromFinal = merged.transitions.some(
      (t) => t.command === "REOPEN_FOR_CORRECTION" && t.fromState === "FINAL_VERIFICATION_REJECTED"
    );
    expect(fromFinal).toBe(true);
  });

  it("disables a command entirely when ALL its fromStates are forbidden", () => {
    const reopenFromStates = BASE.transitions
      .filter((t) => t.command === "REOPEN_FOR_CORRECTION")
      .map((t) => t.fromState);
    expect(reopenFromStates.length).toBeGreaterThan(0);

    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { REOPEN_FOR_CORRECTION: reopenFromStates },
    });

    const remaining = merged.transitions.filter((t) => t.command === "REOPEN_FOR_CORRECTION");
    expect(remaining).toEqual([]);
  });

  it("strict subset: merged transition count <= base transition count", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: {
        PLACE_HOLD: ["READY_TO_SHIP"],
        REOPEN_FOR_CORRECTION: ["PV1_REJECTED"],
      },
    });
    expect(merged.transitions.length).toBe(BASE.transitions.length - 2);
  });

  it("merged transitions are a subset of base by reference (no synthesized rows)", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { CANCEL: ["RECEIVED"] },
    });
    const baseSet = new Set(BASE.transitions);
    for (const t of merged.transitions) {
      expect(baseSet.has(t)).toBe(true);
    }
  });

  it("preserves base transition ordering for the surviving rows", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { CANCEL: ["RECEIVED"] },
    });
    const expected = BASE.transitions.filter(
      (t) => !(t.command === "CANCEL" && t.fromState === "RECEIVED")
    );
    expect(merged.transitions).toEqual(expected);
  });
});

describe("mergePolicyWithOverlay — loosening rejected", () => {
  it("rejects an overlay that forbids a (command, fromState) NOT in the base policy", () => {
    // APPROVE_PV1 is allowed only from PV1_IN_PROGRESS in base.
    // Adding RECEIVED to the forbid list here is the test surface
    // for "overlay claims to constrain a transition base does not
    // declare". Treat as loosening — fail closed.
    const overlay: WorkflowPolicyOverlay = {
      forbidTransitionsFromStates: {
        APPROVE_PV1: ["PV1_IN_PROGRESS", "RECEIVED" as OrderState],
      },
    };
    expect(() => mergePolicyWithOverlay(BASE, overlay)).toThrow(errors.ValidationError);

    try {
      mergePolicyWithOverlay(BASE, overlay);
    } catch (err) {
      expect(errors.isPharmaxError(err)).toBe(true);
      const pe = err as InstanceType<typeof errors.ValidationError>;
      expect(pe.code).toBe(OVERLAY_LOOSENS_BASE_POLICY);
      expect(pe.metadata).toMatchObject({
        command: "APPROVE_PV1",
        fromState: "RECEIVED",
      });
    }
  });

  it("rejects an overlay that adds attestations for an unknown transitionId", () => {
    const overlay: WorkflowPolicyOverlay = {
      addRequiredAttestations: {
        "wf.v1.NOT_A_REAL_TRANSITION": [{ id: "x", minSignatures: 2, permission: "pv1.approve" }],
      },
    };
    expect(() => mergePolicyWithOverlay(BASE, overlay)).toThrow(errors.ValidationError);

    try {
      mergePolicyWithOverlay(BASE, overlay);
    } catch (err) {
      const pe = err as InstanceType<typeof errors.ValidationError>;
      expect(pe.code).toBe(OVERLAY_LOOSENS_BASE_POLICY);
      expect(pe.metadata).toMatchObject({
        transitionId: "wf.v1.NOT_A_REAL_TRANSITION",
      });
    }
  });

  it("rejects an attestation requirement with minSignatures < 1", () => {
    const overlay: WorkflowPolicyOverlay = {
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [{ id: "bad", minSignatures: 0, permission: "pv1.approve" }],
      },
    };
    expect(() => mergePolicyWithOverlay(BASE, overlay)).toThrow(errors.ValidationError);
  });

  it("rejects loudly — never returns a partially-merged policy on a bad overlay", () => {
    // If validation throws, the caller MUST NOT receive any policy
    // object; this regression test guards against future drift.
    let merged: OrderWorkflowPolicy | undefined;
    try {
      merged = mergePolicyWithOverlay(BASE, {
        forbidTransitionsFromStates: { APPROVE_PV1: ["RECEIVED" as OrderState] },
      });
    } catch {
      // expected
    }
    expect(merged).toBeUndefined();
  });
});

describe("mergePolicyWithOverlay — attestation augmentation", () => {
  it("attaches attestations to a base transitionId", () => {
    const requirement: AttestationRequirement = {
      id: "second-pharmacist-controlled",
      minSignatures: 2,
      permission: "pv1.approve",
      description: "Two pharmacists must approve PV1 for controlled substances.",
    };
    const merged = mergePolicyWithOverlay(BASE, {
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [requirement],
      },
    });
    expect(merged.attestationsByTransitionId).toBeDefined();
    expect(merged.attestationsByTransitionId?.["wf.v1.approve_pv1"]).toEqual([requirement]);
  });

  it("preserves the underlying transition row (engine still finds it)", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [{ id: "second", minSignatures: 2, permission: "pv1.approve" }],
      },
    });
    const row = merged.transitions.find((t) => t.transitionId === "wf.v1.approve_pv1");
    expect(row).toBeDefined();
    expect(row?.command).toBe("APPROVE_PV1");
    expect(row?.fromState).toBe("PV1_IN_PROGRESS");
  });

  it("drops attestations whose underlying transition was forbidden", () => {
    // If a tenant forbids the PV1 approval transition AND adds
    // attestations on it, the attestations are dropped — there's
    // no transition for them to apply to.
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { APPROVE_PV1: ["PV1_IN_PROGRESS"] },
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [{ id: "second", minSignatures: 2, permission: "pv1.approve" }],
      },
    });
    expect(merged.attestationsByTransitionId).toBeUndefined();
  });

  it("attestation map is frozen (ops can't mutate the result post-merge)", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [{ id: "second", minSignatures: 2, permission: "pv1.approve" }],
      },
    });
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged.attestationsByTransitionId)).toBe(true);
    expect(Object.isFrozen(merged.attestationsByTransitionId?.["wf.v1.approve_pv1"])).toBe(true);
  });
});

describe("mergePolicyWithOverlay — combined operations", () => {
  it("applies forbid + attestations together", () => {
    const merged = mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { REOPEN_FOR_CORRECTION: ["PV1_REJECTED"] },
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [{ id: "second", minSignatures: 2, permission: "pv1.approve" }],
      },
    });

    const reopenFromPV1 = merged.transitions.some(
      (t) => t.transitionId === "wf.v1.reopen_from_pv1_rejected"
    );
    expect(reopenFromPV1).toBe(false);

    expect(merged.attestationsByTransitionId?.["wf.v1.approve_pv1"]).toBeDefined();
  });

  it("does not mutate the base policy under any overlay", () => {
    const baseTransitionsRef = BASE.transitions;
    const baseTransitionCount = BASE.transitions.length;
    mergePolicyWithOverlay(BASE, {
      forbidTransitionsFromStates: { CANCEL: ["RECEIVED"] },
      addRequiredAttestations: {
        "wf.v1.approve_pv1": [{ id: "x", minSignatures: 2, permission: "pv1.approve" }],
      },
    });
    expect(BASE.transitions).toBe(baseTransitionsRef);
    expect(BASE.transitions.length).toBe(baseTransitionCount);
    expect(BASE.attestationsByTransitionId).toBeUndefined();
  });
});

describe("mergePolicyWithOverlay — exhaustive command coverage", () => {
  // Sanity: for every workflow command, find one (command, fromState)
  // in the base, forbid it, and verify the merge produces a policy
  // strictly smaller than base. This catches the "merge silently
  // drops nothing" regression on every command.
  it.each(ORDER_WORKFLOW_COMMANDS)(
    "tightens base when forbidding the first base transition for %s",
    (command) => {
      const firstRow = BASE.transitions.find((t) => t.command === command);
      if (firstRow === undefined) return;
      const merged = mergePolicyWithOverlay(BASE, {
        forbidTransitionsFromStates: { [command]: [firstRow.fromState] },
      });
      expect(merged.transitions.length).toBe(BASE.transitions.length - 1);
      const stillThere = merged.transitions.some((t) => t === firstRow);
      expect(stillThere).toBe(false);
    }
  );
});
