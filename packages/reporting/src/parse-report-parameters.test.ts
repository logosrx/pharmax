import { describe, expect, it } from "vitest";

import {
  dateRangeFields,
  resolveDateFieldDefault,
  type ReportParameterField,
} from "./parameter-fields.js";
import { paramSourceFromRecord, parseReportParameters } from "./parse-report-parameters.js";

const FIELDS: ReadonlyArray<ReportParameterField> = [
  ...dateRangeFields(),
  {
    kind: "multi-enum",
    key: "statuses",
    label: "Statuses",
    required: false,
    options: [
      { value: "SHIPPED", label: "Shipped" },
      { value: "ON_HOLD", label: "On hold" },
    ],
  },
];

describe("parseReportParameters — happy path", () => {
  it("coerces dates to UTC-anchored Date objects + collects multi-enum", () => {
    const src = paramSourceFromRecord({
      from: "2026-05-01",
      to: "2026-05-28",
      statuses: ["SHIPPED", "ON_HOLD"],
    });
    const r = parseReportParameters(FIELDS, src);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parameters["from"]).toBeInstanceOf(Date);
      expect((r.parameters["from"] as Date).toISOString()).toBe("2026-05-01T00:00:00.000Z");
      expect((r.parameters["to"] as Date).toISOString()).toBe("2026-05-28T00:00:00.000Z");
      expect(r.parameters["statuses"]).toEqual(["SHIPPED", "ON_HOLD"]);
    }
  });

  it("omits an empty optional multi-enum entirely (schema default applies)", () => {
    const src = paramSourceFromRecord({ from: "2026-05-01", to: "2026-05-28" });
    const r = parseReportParameters(FIELDS, src);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("statuses" in r.parameters).toBe(false);
    }
  });
});

describe("parseReportParameters — errors", () => {
  it("errors on a missing required date", () => {
    const src = paramSourceFromRecord({ to: "2026-05-28" });
    const r = parseReportParameters(FIELDS, src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("From is required");
  });

  it("errors on an unparseable date", () => {
    const src = paramSourceFromRecord({ from: "not-a-date", to: "2026-05-28" });
    const r = parseReportParameters(FIELDS, src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a valid date");
  });

  it("errors on a non-numeric number field", () => {
    const fields: ReadonlyArray<ReportParameterField> = [
      { kind: "number", key: "limit", label: "Limit", required: true },
    ];
    const r = parseReportParameters(fields, paramSourceFromRecord({ limit: "abc" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("must be a number");
  });
});

describe("parseReportParameters — text + enum + number", () => {
  it("trims text, passes enum, coerces number", () => {
    const fields: ReadonlyArray<ReportParameterField> = [
      { kind: "text", key: "label", label: "Label", required: true },
      {
        kind: "enum",
        key: "mode",
        label: "Mode",
        required: true,
        options: [{ value: "a", label: "A" }],
      },
      { kind: "number", key: "limit", label: "Limit", required: false },
    ];
    const r = parseReportParameters(
      fields,
      paramSourceFromRecord({ label: "  hi  ", mode: "a", limit: "42" })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parameters).toEqual({ label: "hi", mode: "a", limit: 42 });
    }
  });
});

describe("resolveDateFieldDefault", () => {
  const NOW = new Date("2026-05-28T12:00:00.000Z");
  it("resolves named defaults to YYYY-MM-DD", () => {
    expect(resolveDateFieldDefault("today", NOW)).toBe("2026-05-28");
    expect(resolveDateFieldDefault("now-7d", NOW)).toBe("2026-05-21");
    expect(resolveDateFieldDefault("now-30d", NOW)).toBe("2026-04-28");
    expect(resolveDateFieldDefault(undefined, NOW)).toBe("");
  });
});
