import { describe, expect, it } from "vitest";

import { parseCliArgs } from "./ingest-rxnorm-release.js";

describe("ingest-rxnorm-release — argument parsing", () => {
  it("accepts a load invocation with an explicit version", () => {
    expect(parseCliArgs(["--dir=/tmp/release", "--version=07072026"])).toEqual({
      dir: "/tmp/release",
      version: "07072026",
      check: false,
    });
  });

  it("accepts a load invocation without a version (inferred later from the dir name)", () => {
    expect(parseCliArgs(["--dir=/tmp/RxNorm_full_prescribe_07072026"])).toEqual({
      dir: "/tmp/RxNorm_full_prescribe_07072026",
      version: null,
      check: false,
    });
  });

  it("accepts a bare --check", () => {
    expect(parseCliArgs(["--check"])).toEqual({ dir: null, version: null, check: true });
  });

  it("rejects an invocation that neither loads nor checks", () => {
    expect(parseCliArgs([])).toBeNull();
    expect(parseCliArgs(["--version=07072026"])).toBeNull();
  });

  it("rejects unknown flags rather than ignoring an operator's typo", () => {
    expect(parseCliArgs(["--dir=/tmp/x", "--force"])).toBeNull();
  });
});
