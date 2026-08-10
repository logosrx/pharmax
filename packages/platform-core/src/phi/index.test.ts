// Detector-level tests for the shared PHI tripwire. Consumer-facing
// behaviour (refusal wording, error codes) is tested at each
// consuming boundary — compliance-ai's prompt guard and security's
// break-glass gate.
//
// The two halves matter equally. The "fires" block proves the
// tripwire catches the realistic accident — someone widening a
// guarded surface to include operational context. The "stays quiet"
// block proves it does not fire on ordinary operational prose,
// because a tripwire that blocks legitimate writing gets deleted by
// the next person who hits it, and then nothing is guarding the
// boundary at all.

import { describe, expect, it } from "vitest";

import { scanForPhi } from "./index.js";

describe("scanForPhi — fires", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["an SSN", "Reviewer notes: subject 123-45-6789 flagged.", "ssn"],
    ["a date-of-birth label", "Patient context — DOB: 1984-02-11", "date_of_birth_label"],
    ["a patient label", "Failing order for patient: 4a91c2", "patient_label"],
    ["an MRN label", "Record MRN# 88213 was not encrypted.", "patient_label"],
    [
      "a patient name field",
      "The patient_last_name column lacked encryption.",
      "patient_name_field",
    ],
    ["a phone number", "Contact on file is (415) 555-0132.", "us_phone"],
    ["an email address", "Escalated to nurse@example-clinic.com for review.", "email_address"],
    ["an Rx number", "See prescription number: 9931204.", "rx_number"],
    [
      "an unlabelled 20th-century date",
      "Subject born 1962-07-04 per intake.",
      "twentieth_century_iso_date",
    ],
  ];

  for (const [label, text, expectedRule] of cases) {
    it(`fires on ${label}`, () => {
      const hits = scanForPhi(text);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.map((h) => h.rule)).toContain(expectedRule);
    });
  }

  it("reports every rule that fires, not just the first", () => {
    const hits = scanForPhi("patient: J.D., DOB: 1962-07-04, call (415) 555-0132");
    expect(hits.map((h) => h.rule)).toEqual(
      expect.arrayContaining(["patient_label", "date_of_birth_label", "us_phone"])
    );
  });

  it("never includes the matched text in a hit", () => {
    const secret = "123-45-6789";
    for (const hit of scanForPhi(`Subject ${secret} flagged.`)) {
      expect(hit.rule).not.toContain(secret);
      expect(hit.explanation).not.toContain(secret);
    }
  });
});

describe("scanForPhi — stays quiet on ordinary operational prose", () => {
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
    ["operational timestamps", "Last signed off 2026-08-02T12:00:00.000Z by the Security Officer."],
    ["a task description", "Remediate failing check: identity.mfa.elevated_role_enrollment."],
    [
      "a break-glass style summary",
      "Order stuck in FILL_IN_PROGRESS after worker crash; replaying outbox row per INC-2214.",
    ],
  ];

  for (const [label, text] of allowed) {
    it(`allows ${label}`, () => {
      expect(scanForPhi(text)).toEqual([]);
    });
  }
});
