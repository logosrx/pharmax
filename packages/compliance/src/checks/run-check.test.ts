import { clock as clockNs } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import { defineCheck } from "./define-check.js";
import { computeComplianceDigest, runComplianceCheck } from "./run-check.js";
import type { ComplianceCheckContext, ComplianceVerdict } from "../types.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function buildContext(): ComplianceCheckContext {
  return {
    // No probe in these tests touches the database; the runner never
    // does. Casting keeps the test honest about that.
    prisma: {} as ComplianceCheckContext["prisma"],
    clock: clockNs.createFrozenClock(NOW),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ComplianceCheckContext["logger"],
  };
}

function passingVerdict(overrides: Partial<ComplianceVerdict> = {}): ComplianceVerdict {
  return {
    outcome: "PASS",
    summary: "all good",
    findings: [],
    details: { checked: 3 },
    subjectOrganizationId: null,
    ...overrides,
  };
}

function buildCheck(
  evaluate: (ctx: ComplianceCheckContext) => Promise<readonly ComplianceVerdict[]>
) {
  return defineCheck({
    code: "test.probe.example",
    title: "Example",
    description: "Example probe used by the runner tests.",
    severity: "HIGH",
    cadence: "DAILY",
    intervalMinutes: 1440,
    controlCodes: ["CC1.1-1"],
    evaluate,
  });
}

describe("runComplianceCheck — normal verdicts", () => {
  it("maps one verdict to one run record and freezes the check identity onto it", async () => {
    const check = buildCheck(async () => [passingVerdict()]);

    const records = await runComplianceCheck(check, buildContext());

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.checkCode).toBe("test.probe.example");
    // Severity is frozen from the definition at run time, so
    // re-grading the check later cannot rewrite historical evidence.
    expect(record.severityAtRun).toBe("HIGH");
    expect(record.outcome).toBe("PASS");
    expect(record.errorCode).toBeNull();
    expect(record.errorMessage).toBeNull();
    expect(record.findingCount).toBe(0);
    expect(record.observedAt).toEqual(NOW);
    expect(record.durationMs).toBe(0);
  });

  it("returns one record per verdict for a per-tenant probe", async () => {
    const check = buildCheck(async () => [
      passingVerdict({ subjectOrganizationId: "org-a", summary: "a ok" }),
      passingVerdict({
        outcome: "FAIL",
        subjectOrganizationId: "org-b",
        summary: "b bad",
        findings: [{ subject: "user:1", detail: "no mfa" }],
      }),
    ]);

    const records = await runComplianceCheck(check, buildContext());

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.subjectOrganizationId)).toEqual(["org-a", "org-b"]);
    expect(records.map((r) => r.outcome)).toEqual(["PASS", "FAIL"]);
    expect(records[1]!.findingCount).toBe(1);
  });

  it("folds findings into the digested details so altering them changes the digest", async () => {
    const finding = { subject: "user:1", detail: "no mfa" };
    const check = buildCheck(async () => [
      passingVerdict({ outcome: "FAIL", findings: [finding] }),
    ]);

    const records = await runComplianceCheck(check, buildContext());
    const record = records[0]!;

    expect(record.details["findings"]).toEqual([finding]);
    expect(record.digestSha256).toBe(computeComplianceDigest(record.details));

    // A different finding list must produce a different digest —
    // otherwise the integrity check would not cover the part of the
    // evidence a reader actually acts on.
    const mutated = { ...record.details, findings: [{ ...finding, detail: "changed" }] };
    expect(computeComplianceDigest(mutated)).not.toBe(record.digestSha256);
  });

  it("computes a digest that is recomputable from the stored details alone", async () => {
    const check = buildCheck(async () => [passingVerdict()]);
    const records = await runComplianceCheck(check, buildContext());

    // Round-trip through JSON the way an exported evidence file would.
    const exported: unknown = JSON.parse(JSON.stringify(records[0]!.details));
    expect(computeComplianceDigest(exported)).toBe(records[0]!.digestSha256);
  });
});

describe("runComplianceCheck — the runner-owned ERROR states", () => {
  it("records ERROR (never PASS or FAIL) when the probe throws", async () => {
    const check = buildCheck(async () => {
      throw new TypeError("credentials expired");
    });

    const records = await runComplianceCheck(check, buildContext());

    expect(records).toHaveLength(1);
    const record = records[0]!;
    // The critical assertion of this whole module: a probe that could
    // not reach a verdict must never manufacture evidence of
    // compliance.
    expect(record.outcome).toBe("ERROR");
    expect(record.errorCode).toBe("COMPLIANCE_PROBE_THREW");
    expect(record.errorMessage).toBe("TypeError: credentials expired");
    expect(record.summary).toContain("UNKNOWN, not satisfied");
    expect(record.findingCount).toBe(0);
  });

  it("does not persist a stack trace, which can carry paths and query fragments", async () => {
    const check = buildCheck(async () => {
      throw new Error("boom");
    });

    const record = (await runComplianceCheck(check, buildContext()))[0]!;

    expect(record.errorMessage).toBe("Error: boom");
    expect(JSON.stringify(record.details)).not.toContain("at ");
  });

  it("records ERROR for a non-Error throw without leaking the thrown value", async () => {
    const check = buildCheck(async () => {
      throw "a bare string";
    });

    const record = (await runComplianceCheck(check, buildContext()))[0]!;

    expect(record.outcome).toBe("ERROR");
    expect(record.errorMessage).toBe("Unknown non-Error thrown by probe.");
    expect(JSON.stringify(record)).not.toContain("a bare string");
  });

  it("records ERROR when the probe returns no verdicts, since silence reads as a pass", async () => {
    const check = buildCheck(async () => []);

    const records = await runComplianceCheck(check, buildContext());

    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("ERROR");
    expect(records[0]!.errorCode).toBe("COMPLIANCE_PROBE_RETURNED_NO_VERDICTS");
  });

  it("logs the failure so a broken probe is visible before the next audit", async () => {
    const ctx = buildContext();
    const check = buildCheck(async () => {
      throw new Error("boom");
    });

    await runComplianceCheck(check, ctx);

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "compliance.check.threw",
      expect.objectContaining({ checkCode: "test.probe.example" })
    );
  });
});

describe("computeComplianceDigest", () => {
  it("is stable under key reordering, so an export cannot fail verification on field order", () => {
    expect(computeComplianceDigest({ a: 1, b: 2 })).toBe(computeComplianceDigest({ b: 2, a: 1 }));
  });

  it("changes when a value changes", () => {
    expect(computeComplianceDigest({ a: 1 })).not.toBe(computeComplianceDigest({ a: 2 }));
  });
});
