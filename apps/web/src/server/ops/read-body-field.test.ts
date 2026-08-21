import { describe, expect, it } from "vitest";

import {
  readEnumField,
  readEnumListField,
  readStringField,
  readStringListField,
} from "./read-body-field";

const METHODS = ["ATTESTED", "PORTAL_CHECKED", "REGISTRY_FILE"] as const;

function form(entries: ReadonlyArray<readonly [string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("readStringField", () => {
  it("trims and returns a present value from both body shapes", () => {
    expect(readStringField(form([["a", "  x  "]]), "a")).toBe("x");
    expect(readStringField({ a: "  x  " }, "a")).toBe("x");
  });

  it("treats an empty or whitespace-only submission as absent", () => {
    // Browsers post "" for untouched optional inputs; commands want the
    // key absent rather than an empty string.
    expect(readStringField(form([["a", ""]]), "a")).toBeNull();
    expect(readStringField(form([["a", "   "]]), "a")).toBeNull();
    expect(readStringField({ a: "" }, "a")).toBeNull();
  });

  it("returns null for a missing key or a non-string value", () => {
    expect(readStringField(form([]), "a")).toBeNull();
    expect(readStringField({ a: 42 }, "a")).toBeNull();
    expect(readStringField({ a: null }, "a")).toBeNull();
  });
});

describe("readEnumField", () => {
  it("narrows a recognised value", () => {
    const got = readEnumField(form([["m", "ATTESTED"]]), "m", METHODS);
    expect(got).toBe("ATTESTED");
  });

  it("rejects an unrecognised value rather than passing it through", () => {
    // The reason this helper exists: a cast would let this reach a
    // command.
    expect(readEnumField(form([["m", "WHATEVER"]]), "m", METHODS)).toBeNull();
    expect(readEnumField({ m: "attested" }, "m", METHODS)).toBeNull();
  });

  it("does not distinguish absent from unrecognised", () => {
    expect(readEnumField(form([]), "m", METHODS)).toBeNull();
    expect(readEnumField(form([["m", "NOPE"]]), "m", METHODS)).toBeNull();
  });
});

describe("readEnumListField", () => {
  it("collects repeated checkbox values in submission order", () => {
    const got = readEnumListField(
      form([
        ["m", "REGISTRY_FILE"],
        ["m", "ATTESTED"],
      ]),
      "m",
      METHODS
    );
    expect(got).toEqual(["REGISTRY_FILE", "ATTESTED"]);
  });

  it("drops unrecognised entries but keeps the valid ones", () => {
    const got = readEnumListField(
      form([
        ["m", "ATTESTED"],
        ["m", "BOGUS"],
      ]),
      "m",
      METHODS
    );
    expect(got).toEqual(["ATTESTED"]);
  });

  it("deduplicates a doubled checkbox", () => {
    const got = readEnumListField(
      form([
        ["m", "ATTESTED"],
        ["m", "ATTESTED"],
      ]),
      "m",
      METHODS
    );
    expect(got).toEqual(["ATTESTED"]);
  });

  it("returns empty for an unchecked group, leaving the policy to the caller", () => {
    expect(readEnumListField(form([]), "m", METHODS)).toEqual([]);
  });

  it("accepts a single JSON string as a one-element list", () => {
    expect(readEnumListField({ m: "ATTESTED" }, "m", METHODS)).toEqual(["ATTESTED"]);
    expect(readEnumListField({ m: ["ATTESTED"] }, "m", METHODS)).toEqual(["ATTESTED"]);
  });
});

describe("readStringListField", () => {
  it("trims, drops blanks, and deduplicates", () => {
    const got = readStringListField(
      form([
        ["s", " CA "],
        ["s", ""],
        ["s", "CA"],
        ["s", "NV"],
      ]),
      "s"
    );
    expect(got).toEqual(["CA", "NV"]);
  });

  it("returns empty rather than throwing when nothing was submitted", () => {
    // An empty set is a legitimate instruction for a declarative write.
    expect(readStringListField(form([]), "s")).toEqual([]);
    expect(readStringListField({}, "s")).toEqual([]);
  });
});
