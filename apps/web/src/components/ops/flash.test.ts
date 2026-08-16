// parseFlashError — the redirect error payload → toast fields split.
// Synthetic codes/messages only; no PHI.

import { describe, expect, it } from "vitest";

import { parseFlashError } from "./flash.js";

describe("parseFlashError", () => {
  it("splits the dispatchOpsCommand payload shape into code + message", () => {
    expect(parseFlashError("PV1_APPROVE_REFUSED: Screening changed since review.")).toEqual({
      code: "PV1_APPROVE_REFUSED",
      message: "Screening changed since review.",
    });
  });

  it("handles the generic fallback code", () => {
    expect(parseFlashError("OPS_DISPATCH_FAILED: Unable to apply.")).toEqual({
      code: "OPS_DISPATCH_FAILED",
      message: "Unable to apply.",
    });
  });

  it("passes through payloads without a code prefix", () => {
    expect(parseFlashError("Workstation not found at this site.")).toEqual({
      code: null,
      message: "Workstation not found at this site.",
    });
  });

  it("does not treat an arbitrary lowercase prefix as a code", () => {
    expect(parseFlashError("note: check the printer")).toEqual({
      code: null,
      message: "note: check the printer",
    });
  });

  it("keeps multi-line messages intact", () => {
    expect(parseFlashError("LOT_EXPIRED: Lot 42 expired.\nPick another lot.")).toEqual({
      code: "LOT_EXPIRED",
      message: "Lot 42 expired.\nPick another lot.",
    });
  });
});
