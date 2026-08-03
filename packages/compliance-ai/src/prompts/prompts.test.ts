// Prompt builder tests.
//
// The tripwire has its own unit tests, so what matters here is that
// the builders are actually wired to it. A tripwire that every caller
// forgets to invoke is documentation, not a control — so these tests
// assert egress refusal through the real `build` functions rather than
// through `assertNoPhi` directly.

import { describe, expect, it } from "vitest";

import { COMPLIANCE_AI_PHI_TRIPWIRE } from "../guards/phi-tripwire.js";
import { controlDescriptionKind } from "./control-description.js";
import { criterionMappingKind } from "./criterion-mapping.js";
import { canonicalizeInputs, extractJsonObject } from "./shared.js";

const CONTROL_INPUT = {
  controlCode: "CC6.1-2",
  title: "RBAC enforced before every mutation",
  ownerRole: "Security Officer",
  criterionCodes: ["CC6.1"],
  implementationRefs: ["ADR-0025"],
  notes: null,
} as const;

describe("controlDescriptionKind", () => {
  it("builds a prompt from control metadata", () => {
    const prompt = controlDescriptionKind.build(CONTROL_INPUT);

    expect(prompt.promptVersion).toBe(1);
    expect(prompt.request.temperature).toBe(0);
    expect(prompt.request.user).toContain("CC6.1-2");
    expect(prompt.inputSummary).toContain("CC6.1-2");
  });

  it("omits the control's status so the model cannot assert it operates", () => {
    const prompt = controlDescriptionKind.build(CONTROL_INPUT);

    expect(prompt.request.user).not.toContain("IMPLEMENTED");
    expect(prompt.request.user).not.toContain("Implemented");
  });

  it("refuses to build when a note carries patient data", () => {
    expect(() =>
      controlDescriptionKind.build({
        ...CONTROL_INPUT,
        notes: "Raised after the order for patient: 4a91c2 shipped unverified.",
      })
    ).toThrow(COMPLIANCE_AI_PHI_TRIPWIRE);
  });

  it("rejects a description that merely restates the title", () => {
    const parsed = controlDescriptionKind.outputSchema.safeParse({
      description: "RBAC enforced before every mutation.",
      informationGaps: [],
      confidence: "high",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("criterionMappingKind", () => {
  const input = {
    controlCode: "CC6.1-2",
    title: "RBAC enforced before every mutation",
    description: "Authorization runs at command bus step 3 for every mutation.",
    implementationRefs: ["ADR-0025"],
    existingCriterionCodes: ["CC6.1"],
    candidateCriteria: [
      { code: "164.312(a)(1)", framework: "HIPAA_SECURITY", title: "Access control" },
    ],
  } as const;

  it("constrains the model to the supplied candidate codes", () => {
    const prompt = criterionMappingKind.build(input);

    expect(prompt.request.user).toContain("164.312(a)(1)");
    expect(prompt.request.user).toContain("Do not cite any code that does");
  });

  it("tells the model not to repeat existing mappings", () => {
    const prompt = criterionMappingKind.build(input);

    expect(prompt.request.user).toContain("do NOT repeat");
    expect(prompt.request.user).toContain("CC6.1");
  });

  it("requires a rationale long enough to be an argument", () => {
    const parsed = criterionMappingKind.outputSchema.safeParse({
      proposals: [{ criterionCode: "164.312(a)(1)", rationale: "It applies.", confidence: "high" }],
      informationGaps: [],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts an empty proposal list as a valid answer", () => {
    const parsed = criterionMappingKind.outputSchema.safeParse({
      proposals: [],
      informationGaps: ["No HIPAA criteria were supplied as candidates."],
    });

    expect(parsed.success).toBe(true);
  });
});

describe("canonicalizeInputs", () => {
  it("produces the same digest regardless of key order", () => {
    const a = canonicalizeInputs({ controlCode: "CC6.1-2", title: "RBAC" });
    const b = canonicalizeInputs({ title: "RBAC", controlCode: "CC6.1-2" });

    expect(a.digest).toBe(b.digest);
  });

  it("produces different digests for different inputs", () => {
    const a = canonicalizeInputs({ controlCode: "CC6.1-2" });
    const b = canonicalizeInputs({ controlCode: "CC6.1-3" });

    expect(a.digest).not.toBe(b.digest);
  });
});

describe("extractJsonObject", () => {
  it("unwraps a fenced response", () => {
    expect(extractJsonObject('```json\n{"description":"x"}\n```')).toBe('{"description":"x"}');
  });

  it("recovers an object wrapped in prose", () => {
    expect(extractJsonObject('Here you go: {"description":"x"} — hope that helps.')).toBe(
      '{"description":"x"}'
    );
  });

  it("passes a bare object through unchanged", () => {
    expect(extractJsonObject('{"description":"x"}')).toBe('{"description":"x"}');
  });
});
