// Wrapper-level tests for this boundary's PHI guard. The detector
// patterns themselves (what fires, what stays quiet) are tested where
// they live, in @pharmax/platform-core's phi module — these tests
// prove the model-provider boundary's behaviour: the error code, the
// refusal wording, and that the wording never leaks the matched text.

import { describe, expect, it } from "vitest";

import { assertNoPhi, COMPLIANCE_AI_PHI_TRIPWIRE, scanForPhi } from "./phi-tripwire.js";

describe("assertNoPhi", () => {
  it("refuses PHI-shaped text with the boundary's error code", () => {
    expect(() => assertNoPhi("Patient context — DOB: 1984-02-11", "test prompt")).toThrow(
      COMPLIANCE_AI_PHI_TRIPWIRE
    );
  });

  it("passes ordinary compliance prose through", () => {
    const text = "Control CC6.1-2 maps to criterion CC6.1; see 45 CFR 164.312(a)(2)(iv).";
    expect(scanForPhi(text)).toEqual([]);
    expect(() => assertNoPhi(text, "test prompt")).not.toThrow();
  });

  it("names the rule but never quotes the matched text", () => {
    const secret = "123-45-6789";
    try {
      assertNoPhi(`Subject ${secret} flagged.`, "test prompt");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("ssn");
      // Logging the thing we just refused to send would defeat it.
      expect(message).not.toContain(secret);
    }
  });
});
