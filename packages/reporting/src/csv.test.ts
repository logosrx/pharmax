import { describe, expect, it } from "vitest";

import { toCsv } from "./csv.js";

describe("toCsv — basic shape", () => {
  it("returns an empty string for an empty row array", () => {
    expect(toCsv([])).toBe("");
  });

  it("emits header from the first row's keys when columns are omitted", () => {
    const csv = toCsv([
      { id: "a", count: 1 },
      { id: "b", count: 2 },
    ]);
    expect(csv).toBe("id,count\na,1\nb,2");
  });

  it("respects an explicit column ordering + projection", () => {
    const csv = toCsv(
      [
        { id: "a", count: 1, secret: "do-not-export" },
        { id: "b", count: 2, secret: "still-no" },
      ],
      ["count", "id"]
    );
    expect(csv).toBe("count,id\n1,a\n2,b");
    expect(csv).not.toContain("secret");
  });
});

describe("toCsv — field escaping (RFC 4180)", () => {
  it("wraps fields with commas in double quotes", () => {
    const csv = toCsv([{ value: "a,b,c" }]);
    expect(csv).toBe(`value\n"a,b,c"`);
  });

  it("escapes embedded double quotes by doubling them", () => {
    const csv = toCsv([{ value: `she said "hi"` }]);
    expect(csv).toBe(`value\n"she said ""hi"""`);
  });

  it("wraps fields with newlines in double quotes", () => {
    const csv = toCsv([{ value: "line1\nline2" }]);
    expect(csv).toBe(`value\n"line1\nline2"`);
  });

  it("renders Date as ISO-8601 UTC", () => {
    const d = new Date("2026-05-25T16:00:00.000Z");
    expect(toCsv([{ when: d }])).toBe(`when\n2026-05-25T16:00:00.000Z`);
  });

  it("renders null and undefined as empty cells", () => {
    expect(toCsv([{ a: null, b: undefined, c: "x" }])).toBe("a,b,c\n,,x");
  });

  it("renders numbers + booleans as their string form (no quotes)", () => {
    expect(toCsv([{ n: 42, b: true, f: false }])).toBe("n,b,f\n42,true,false");
  });

  it("JSON-stringifies complex values then escapes", () => {
    const csv = toCsv([{ tags: ["a", "b"] }]);
    expect(csv).toBe(`tags\n"[""a"",""b""]"`);
  });
});
