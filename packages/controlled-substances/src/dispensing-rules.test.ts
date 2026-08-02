import { ControlledSubstanceSchedule } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import {
  addUtcCalendarMonths,
  addUtcDays,
  evaluateDispensing,
  startOfUtcDay,
  validateControlledPrescriptionAuthorization,
  type ControlledPrescriptionSnapshot,
  type DispensingEvaluation,
  type DispensingRequest,
  type DispensingViolationCode,
  type PartialFillBasis,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WRITTEN = new Date("2026-01-15T00:00:00.000Z");

function rx(
  overrides: Partial<ControlledPrescriptionSnapshot> = {}
): ControlledPrescriptionSnapshot {
  return {
    schedule: ControlledSubstanceSchedule.CII,
    originalDateWritten: WRITTEN,
    refillsAuthorized: 0,
    quantityAuthorized: 60,
    earliestFillDate: null,
    ...overrides,
  };
}

function request(overrides: Partial<DispensingRequest> = {}): DispensingRequest {
  return {
    prescription: rx(),
    fillNumber: 1,
    quantityDispensedInFill: 0,
    quantityToFill: 60,
    firstPartialFillAt: null,
    partialFillBasis: null,
    asOf: new Date("2026-01-16T12:00:00.000Z"),
    ...overrides,
  };
}

function codes(result: DispensingEvaluation): ReadonlyArray<DispensingViolationCode> {
  return result.ok ? [] : result.violations.map((v) => v.code);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

describe("UTC date helpers", () => {
  it("startOfUtcDay truncates to midnight UTC", () => {
    expect(startOfUtcDay(new Date("2026-03-09T23:59:59.999Z")).toISOString()).toBe(
      "2026-03-09T00:00:00.000Z"
    );
  });

  it("addUtcDays crosses month and year boundaries", () => {
    expect(addUtcDays(new Date("2026-12-20T00:00:00Z"), 30).toISOString()).toBe(
      "2027-01-19T00:00:00.000Z"
    );
  });

  it("addUtcCalendarMonths clamps to the last day of a shorter target month", () => {
    // 31 Aug + 6 months has no 31 Feb. Naive rollover would yield
    // 3 March and silently extend the lawful window by two days.
    expect(addUtcCalendarMonths(new Date("2026-08-31T00:00:00Z"), 6).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z"
    );
  });

  it("addUtcCalendarMonths respects a leap year when clamping", () => {
    expect(addUtcCalendarMonths(new Date("2027-08-31T00:00:00Z"), 6).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
  });
});

// ---------------------------------------------------------------------------
// Authorization-time validation
// ---------------------------------------------------------------------------

describe("validateControlledPrescriptionAuthorization", () => {
  it("rejects any refill authorized on a Schedule II prescription (1306.12(a))", () => {
    const result = validateControlledPrescriptionAuthorization({
      schedule: ControlledSubstanceSchedule.CII,
      refillsAuthorized: 1,
    });
    expect(codes(result)).toEqual(["CS_SCHEDULE_II_REFILL_PROHIBITED"]);
  });

  it("accepts zero refills on a Schedule II prescription", () => {
    expect(
      validateControlledPrescriptionAuthorization({
        schedule: ControlledSubstanceSchedule.CII,
        refillsAuthorized: 0,
      }).ok
    ).toBe(true);
  });

  it.each([ControlledSubstanceSchedule.CIII, ControlledSubstanceSchedule.CIV])(
    "allows exactly five refills but not six on %s (1306.22(a))",
    (schedule) => {
      expect(
        validateControlledPrescriptionAuthorization({ schedule, refillsAuthorized: 5 }).ok
      ).toBe(true);
      expect(
        codes(validateControlledPrescriptionAuthorization({ schedule, refillsAuthorized: 6 }))
      ).toEqual(["CS_REFILL_LIMIT_EXCEEDED"]);
    }
  );

  it("applies NO federal refill cap to Schedule V", () => {
    // 1306.22(a) names Schedules III and IV only. Capping CV at five
    // here would be inventing federal law that does not exist; state
    // overlays are a separate layer.
    expect(
      validateControlledPrescriptionAuthorization({
        schedule: ControlledSubstanceSchedule.CV,
        refillsAuthorized: 11,
      }).ok
    ).toBe(true);
  });

  it("ignores non-controlled prescriptions", () => {
    expect(
      validateControlledPrescriptionAuthorization({
        schedule: ControlledSubstanceSchedule.NON_CONTROLLED,
        refillsAuthorized: 99,
      }).ok
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-controlled passthrough
// ---------------------------------------------------------------------------

describe("evaluateDispensing — non-controlled", () => {
  it("never blocks a non-controlled prescription, even on facts that would fail a CS", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.NON_CONTROLLED,
          originalDateWritten: new Date("2020-01-01T00:00:00Z"),
        }),
        fillNumber: 42,
        quantityDispensedInFill: 1000,
        quantityToFill: 1000,
      })
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1306.14(e) — earliest fill date
// ---------------------------------------------------------------------------

describe("evaluateDispensing — earliest fill date (1306.14(e))", () => {
  it("blocks a fill before the prescriber's do-not-fill-before date", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({ earliestFillDate: new Date("2026-02-15T00:00:00Z") }),
        asOf: new Date("2026-02-14T23:00:00Z"),
      })
    );
    expect(codes(result)).toContain("CS_EARLIEST_FILL_DATE_NOT_REACHED");
  });

  it("permits a fill ON the earliest fill date, at any time of day", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({ earliestFillDate: new Date("2026-02-15T00:00:00Z") }),
        asOf: new Date("2026-02-15T00:00:01Z"),
      })
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1306.12(a) — Schedule II refill prohibition
// ---------------------------------------------------------------------------

describe("evaluateDispensing — Schedule II refills (1306.12(a))", () => {
  it("permits the first fill", () => {
    expect(evaluateDispensing(request({ fillNumber: 1 })).ok).toBe(true);
  });

  it("blocks a second fill", () => {
    const result = evaluateDispensing(
      request({ fillNumber: 2, quantityDispensedInFill: 0, quantityToFill: 60 })
    );
    expect(codes(result)).toContain("CS_SCHEDULE_II_REFILL_PROHIBITED");
  });

  it("permits a partial-fill continuation that stays within the authorized quantity", () => {
    // Not a refill — still fill 1, completing the authorized 60.
    const result = evaluateDispensing(
      request({
        fillNumber: 1,
        quantityDispensedInFill: 20,
        quantityToFill: 40,
        partialFillBasis: "PHARMACIST_SUPPLY_SHORTFALL",
        firstPartialFillAt: new Date("2026-01-16T09:00:00Z"),
        asOf: new Date("2026-01-17T09:00:00Z"),
      })
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a partial-fill continuation once the authorized quantity is exhausted", () => {
    // Still fill 1, so this is NOT reported as a refill — the quantity
    // bar is what stops it. Reporting a refill violation here would
    // misdescribe the defect to the pharmacist.
    const result = evaluateDispensing(
      request({
        fillNumber: 1,
        quantityDispensedInFill: 60,
        quantityToFill: 10,
        partialFillBasis: "PHARMACIST_SUPPLY_SHORTFALL",
        firstPartialFillAt: new Date("2026-01-16T09:00:00Z"),
        asOf: new Date("2026-01-17T09:00:00Z"),
      })
    );
    expect(codes(result)).toEqual(["CS_QUANTITY_EXCEEDS_AUTHORIZED"]);
  });
});

// ---------------------------------------------------------------------------
// 1306.13 — Schedule II partial-fill windows
// ---------------------------------------------------------------------------

describe("evaluateDispensing — Schedule II partial-fill windows (1306.13)", () => {
  const first = new Date("2026-01-16T09:00:00Z");

  function partial(basis: PartialFillBasis, asOf: Date): DispensingEvaluation {
    return evaluateDispensing(
      request({
        fillNumber: 1,
        quantityDispensedInFill: 20,
        quantityToFill: 40,
        partialFillBasis: basis,
        firstPartialFillAt: first,
        asOf,
      })
    );
  }

  it("permits completion exactly at 72 hours after the first partial fill", () => {
    expect(
      partial("PHARMACIST_SUPPLY_SHORTFALL", new Date(first.getTime() + 72 * 3600_000)).ok
    ).toBe(true);
  });

  it("blocks completion one second past 72 hours (1306.13(a))", () => {
    const result = partial(
      "PHARMACIST_SUPPLY_SHORTFALL",
      new Date(first.getTime() + 72 * 3600_000 + 1000)
    );
    expect(codes(result)).toContain("CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED");
  });

  it("gives a patient/prescriber-requested partial fill 30 days from the date written", () => {
    expect(partial("PATIENT_OR_PRESCRIBER_REQUEST", addUtcDays(WRITTEN, 30)).ok).toBe(true);
    expect(codes(partial("PATIENT_OR_PRESCRIBER_REQUEST", addUtcDays(WRITTEN, 31)))).toContain(
      "CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED"
    );
  });

  it("gives an LTCF / terminally ill partial fill 60 days from the date written", () => {
    expect(partial("LTCF_OR_TERMINALLY_ILL", addUtcDays(WRITTEN, 60)).ok).toBe(true);
    expect(codes(partial("LTCF_OR_TERMINALLY_ILL", addUtcDays(WRITTEN, 61)))).toContain(
      "CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED"
    );
  });

  it("rejects a Schedule III–V basis used on a Schedule II prescription", () => {
    const result = partial("SCHEDULE_III_TO_V", new Date("2026-01-17T09:00:00Z"));
    expect(codes(result)).toContain("CS_PARTIAL_FILL_BASIS_INVALID_FOR_SCHEDULE");
  });

  it("rejects a Schedule II basis used on a Schedule IV prescription", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({ schedule: ControlledSubstanceSchedule.CIV, refillsAuthorized: 5 }),
        fillNumber: 1,
        quantityDispensedInFill: 20,
        quantityToFill: 40,
        partialFillBasis: "PHARMACIST_SUPPLY_SHORTFALL",
        firstPartialFillAt: first,
        asOf: new Date("2026-01-17T09:00:00Z"),
      })
    );
    expect(codes(result)).toContain("CS_PARTIAL_FILL_BASIS_INVALID_FOR_SCHEDULE");
  });
});

// ---------------------------------------------------------------------------
// 1306.22(a) — Schedule III/IV refill count and six-month horizon
// ---------------------------------------------------------------------------

describe("evaluateDispensing — Schedule III/IV refills (1306.22(a))", () => {
  function ciii(fillNumber: number, asOf = new Date("2026-02-01T00:00:00Z")) {
    return evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.CIII,
          refillsAuthorized: 5,
          quantityAuthorized: 1000,
        }),
        fillNumber,
        quantityDispensedInFill: 0,
        quantityToFill: 30,
        asOf,
      })
    );
  }

  it("permits the original fill plus five refills", () => {
    for (let fillNumber = 1; fillNumber <= 6; fillNumber += 1) {
      expect(ciii(fillNumber).ok).toBe(true);
    }
  });

  it("blocks a sixth refill", () => {
    expect(codes(ciii(7))).toContain("CS_REFILL_LIMIT_EXCEEDED");
  });

  it("does not charge a refill's full quantity against earlier refills", () => {
    // Regression guard. `quantityAuthorized` is PER FILL: a CIII for 30
    // tablets with 5 refills authorizes 30 each time, not 30 in total.
    // Summing quantity across the prescription's lifetime instead of
    // within the fill would flag every refill as exceeding the
    // authorized quantity.
    const result = evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.CIII,
          refillsAuthorized: 5,
          quantityAuthorized: 30,
        }),
        fillNumber: 4,
        quantityDispensedInFill: 0,
        quantityToFill: 30,
        asOf: new Date("2026-02-01T00:00:00Z"),
      })
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a refill beyond what the prescription authorized, even under the federal cap", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.CIV,
          refillsAuthorized: 2,
          quantityAuthorized: 1000,
        }),
        fillNumber: 4,
        quantityToFill: 30,
        asOf: new Date("2026-02-01T00:00:00Z"),
      })
    );
    expect(codes(result)).toContain("CS_REFILL_LIMIT_EXCEEDED");
  });

  it("permits a fill on the six-month anniversary but not the day after", () => {
    const deadline = addUtcCalendarMonths(WRITTEN, 6);
    expect(ciii(2, deadline).ok).toBe(true);
    expect(codes(ciii(2, addUtcDays(deadline, 1)))).toContain("CS_SIX_MONTH_HORIZON_ELAPSED");
  });
});

// ---------------------------------------------------------------------------
// Schedule V asymmetry — the rule most often implemented incorrectly
// ---------------------------------------------------------------------------

describe("evaluateDispensing — Schedule V horizons", () => {
  const longAgo = new Date("2025-01-01T00:00:00Z");
  const now = new Date("2026-06-01T00:00:00Z");

  it("applies NO six-month horizon to an ordinary Schedule V fill", () => {
    // 1306.22(a) covers Schedules III and IV only.
    const result = evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.CV,
          originalDateWritten: longAgo,
          refillsAuthorized: 3,
          quantityAuthorized: 1000,
        }),
        fillNumber: 3,
        quantityToFill: 30,
        asOf: now,
      })
    );
    expect(result.ok).toBe(true);
  });

  it("DOES apply the six-month horizon to a Schedule V partial fill (1306.23(c))", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.CV,
          originalDateWritten: longAgo,
          refillsAuthorized: 3,
          quantityAuthorized: 1000,
        }),
        fillNumber: 1,
        quantityDispensedInFill: 30,
        quantityToFill: 30,
        partialFillBasis: "SCHEDULE_III_TO_V",
        asOf: now,
      })
    );
    expect(codes(result)).toContain("CS_SIX_MONTH_HORIZON_ELAPSED");
    expect(result.ok ? [] : result.violations.map((v) => v.citation)).toContain(
      "21 CFR 1306.23(c)"
    );
  });
});

// ---------------------------------------------------------------------------
// Cumulative quantity
// ---------------------------------------------------------------------------

describe("evaluateDispensing — cumulative quantity", () => {
  it("permits partial fills summing exactly to the authorized quantity", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({ schedule: ControlledSubstanceSchedule.CIII, quantityAuthorized: 90 }),
        fillNumber: 1,
        quantityDispensedInFill: 60,
        quantityToFill: 30,
        partialFillBasis: "SCHEDULE_III_TO_V",
        asOf: new Date("2026-02-01T00:00:00Z"),
      })
    );
    expect(result.ok).toBe(true);
  });

  it("blocks the fill that would exceed the authorized quantity (1306.23(b))", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({ schedule: ControlledSubstanceSchedule.CIII, quantityAuthorized: 90 }),
        fillNumber: 1,
        quantityDispensedInFill: 60,
        quantityToFill: 31,
        partialFillBasis: "SCHEDULE_III_TO_V",
        asOf: new Date("2026-02-01T00:00:00Z"),
      })
    );
    expect(codes(result)).toContain("CS_QUANTITY_EXCEEDS_AUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("evaluateDispensing — reports every violation", () => {
  it("returns all independent failures at once rather than short-circuiting", () => {
    const result = evaluateDispensing(
      request({
        prescription: rx({
          schedule: ControlledSubstanceSchedule.CII,
          quantityAuthorized: 30,
          earliestFillDate: new Date("2099-01-01T00:00:00Z"),
        }),
        fillNumber: 2,
        quantityDispensedInFill: 30,
        quantityToFill: 30,
        asOf: new Date("2026-02-01T00:00:00Z"),
      })
    );
    expect(new Set(codes(result))).toEqual(
      new Set([
        "CS_EARLIEST_FILL_DATE_NOT_REACHED",
        "CS_SCHEDULE_II_REFILL_PROHIBITED",
        "CS_QUANTITY_EXCEEDS_AUTHORIZED",
      ])
    );
  });
});
