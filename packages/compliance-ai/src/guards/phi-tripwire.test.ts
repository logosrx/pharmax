// PHI tripwire tests.
//
// The two halves matter equally. The "refuses" block proves the
// tripwire fires on the realistic accident — someone widening a
// prompt to include operational context. The "allows" block proves it
// does not fire on ordinary compliance prose, because a tripwire that
// blocks legitimate drafting gets deleted by the next person who hits
// it, and then nothing is guarding the boundary at all.

import { describe, expect, it } from "vitest";

import { assertNoPhi, COMPLIANCE_AI_PHI_TRIPWIRE, scanForPhi } from "./phi-tripwire.js";

describe("PHI tripwire — refuses", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["an SSN", "Reviewer notes: subject 123-45-6789 flagged."],
    ["a date-of-birth label", "Patient context — DOB: 1984-02-11"],
    ["a patient label", "Failing order for patient: 4a91c2"],
    ["an MRN label", "Record MRN# 88213 was not encrypted."],
    ["a patient name field", "The patient_last_name column lacked encryption."],
    ["a phone number", "Contact on file is (415) 555-0132."],
    ["an email address", "Escalated to nurse@example-clinic.com for review."],
    ["an Rx number", "See prescription number: 9931204."],
    ["an unlabelled 20th-century date", "Subject born 1962-07-04 per intake."],
  ];

  for (const [label, text] of cases) {
    it(`refuses ${label}`, () => {
      expect(scanForPhi(text).length).toBeGreaterThan(0);
      expect(() => assertNoPhi(text, "test prompt")).toThrow(COMPLIANCE_AI_PHI_TRIPWIRE);
    });
  }

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

describe("PHI tripwire — allows ordinary compliance prose", () => {
  const allowed: ReadonlyArray<readonly [string, string]> = [
    ["control codes", "Control CC6.1-2 maps to criterion CC6.1 and PI1.4-2."],
    ["CFR citations", "Required by 45 CFR 164.312(a)(2)(iv) and 164.308(a)(1)(ii)(A)."],
    ["ADR references", "Implemented per ADR-0025 §3 and ADR-0011."],
    ["probe output", "12 of 12 tenant tables have RLS enabled; 0 findings."],
    [
      "a real control description",
      "RBAC and scope enforcement run before any mutation, at command bus step 3. " +
        "The Security Officer reviews this quarterly. Evidence: audit_log rows for " +
        "every grant and revoke, plus the access-review snapshot for 2026-Q3.",
    ],
    ["compliance timestamps", "Last signed off 2026-08-02T12:00:00.000Z by the Security Officer."],
    ["a task description", "Remediate failing check: identity.mfa.elevated_role_enrollment."],
  ];

  for (const [label, text] of allowed) {
    it(`allows ${label}`, () => {
      expect(scanForPhi(text)).toEqual([]);
      expect(() => assertNoPhi(text, "test prompt")).not.toThrow();
    });
  }
});
