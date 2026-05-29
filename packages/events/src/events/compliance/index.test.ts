// Domain-level test for compliance.* event definitions.
//
// These rules are load-bearing for SOC 2 evidence:
//
//   - owner = "security" — on-call rotation routes compliance events
//     to the security team (vs. application teams).
//   - retention = "7y" — matches the HIPAA documentation-retention
//     floor (45 CFR 164.316); compliance events are evidence and MUST
//     survive the audit period in hot or archival storage.
//   - phiSafe = true — compliance evidence is operator/role/permission
//     metadata, never patient data.
//
// If any compliance event violates these invariants, the failure here
// stops merge and points the author at the relevant policy doc.

import { describe, expect, it } from "vitest";

import * as ComplianceEvents from "./index.js";

const ALL = Object.values(ComplianceEvents);

describe("compliance domain barrel", () => {
  it("1 compliance.* event is registered", () => {
    expect(ALL.length).toBe(1);
  });

  it("every compliance.* event is owned by `security`", () => {
    for (const def of ALL) {
      expect(def.owner, `${def.fullName} owner`).toBe("security");
    }
  });

  it("every compliance.* event is PHI-free", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(true);
    }
  });

  it("every compliance.* event has 7y retention", () => {
    for (const def of ALL) {
      expect(def.retention, `${def.fullName} retention`).toBe("7y");
    }
  });
});
