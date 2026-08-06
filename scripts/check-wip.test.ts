// Unit tests for the working-tree accumulation check.
//
// The cases mirror the 2026-08-02 incident that motivated it: 211
// uncommitted files across ~20 features on `main`, which had to be
// reverse-engineered into PRs and lost fixtures on the way.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AREA_COUNT_THRESHOLD,
  FILE_COUNT_THRESHOLD,
  areaOf,
  evaluateWorkingTree,
  parseStatusPorcelain,
  type StatusEntry,
} from "./check-wip.js";

const modified = (path: string): StatusEntry => ({ code: " M", path });
const untracked = (path: string): StatusEntry => ({ code: "??", path });

const signalsOf = (findings: ReadonlyArray<{ signal: string }>): string[] =>
  findings.map((f) => f.signal);

describe("areaOf", () => {
  it("attributes a path to the app or package that owns it", () => {
    expect(areaOf("apps/web/src/components/x.tsx")).toBe("apps/web");
    expect(areaOf("packages/billing/src/commands/y.ts")).toBe("packages/billing");
  });

  it("groups non-workspace trees by their top directory", () => {
    expect(areaOf("prisma/seed.ts")).toBe("prisma");
    expect(areaOf("docs/adr/0033-x.md")).toBe("docs");
  });

  it("treats repository-root files as one area", () => {
    expect(areaOf("package.json")).toBe("(root)");
  });
});

describe("evaluateWorkingTree", () => {
  it("says nothing about a clean tree, even on the trunk", () => {
    expect(evaluateWorkingTree({ branch: "main", entries: [] })).toEqual([]);
  });

  it("stays quiet for a small focused change on a feature branch", () => {
    const findings = evaluateWorkingTree({
      branch: "fix/vial-label",
      entries: [modified("packages/fill/src/commands/complete-fill.ts")],
    });
    expect(findings).toEqual([]);
  });

  it("flags any uncommitted work sitting on the trunk", () => {
    const findings = evaluateWorkingTree({
      branch: "main",
      entries: [modified("packages/fill/src/commands/complete-fill.ts")],
    });
    expect(signalsOf(findings)).toEqual(["on-trunk"]);
    expect(findings[0]?.remedy).toContain("git switch -c");
  });

  it("flags fan-out across areas even when few files changed", () => {
    // Five areas, one file each: well under the file-count threshold but
    // already impossible to land as a single reviewable PR.
    const findings = evaluateWorkingTree({
      branch: "feature/wide",
      entries: [
        modified("apps/web/app/page.tsx"),
        modified("apps/worker/src/main.ts"),
        modified("packages/billing/src/index.ts"),
        modified("packages/events/src/index.ts"),
        modified("prisma/schema.prisma"),
      ],
    });
    expect(signalsOf(findings)).toEqual(["fan-out"]);
  });

  it("reports volume alone when the change is large but contained", () => {
    const entries = Array.from({ length: FILE_COUNT_THRESHOLD + 1 }, (_, i) =>
      modified(`packages/billing/src/file-${i}.ts`)
    );
    const findings = evaluateWorkingTree({ branch: "feature/billing", entries });
    expect(signalsOf(findings)).toEqual(["volume"]);
  });

  it("does not double-report a wide pile as both fan-out and volume", () => {
    const entries = Array.from({ length: FILE_COUNT_THRESHOLD + 1 }, (_, i) =>
      modified(`packages/pkg-${i}/src/index.ts`)
    );
    const findings = evaluateWorkingTree({ branch: "feature/wide", entries });
    expect(signalsOf(findings)).toEqual(["fan-out"]);
  });

  it("singles out untracked source files as the ones a split loses entirely", () => {
    const findings = evaluateWorkingTree({
      branch: "feature/portal",
      entries: [
        untracked("apps/web/app/portal/page.tsx"),
        untracked("docs/adr/0033-provider-portal.md"),
      ],
    });
    // The ADR is untracked too, but only the source file is called out.
    expect(signalsOf(findings)).toEqual(["untracked-source"]);
    expect(findings[0]?.message).toMatch(/^1 new source file/);
  });

  it("counts a new shell script as source", () => {
    const findings = evaluateWorkingTree({
      branch: "chore/tooling",
      entries: [untracked("scripts/session-new.sh")],
    });
    expect(signalsOf(findings)).toEqual(["untracked-source"]);
  });

  it("reproduces the 2026-08-02 pile: trunk, fan-out and lost new files", () => {
    const entries = [
      modified("apps/web/app/ops/page.tsx"),
      untracked("apps/web/app/portal/page.tsx"),
      untracked("packages/compounding/src/index.ts"),
      modified("packages/events/src/index.ts"),
      untracked("prisma/seed.ts"),
      modified("docs/RUNBOOK.md"),
    ];
    const findings = evaluateWorkingTree({ branch: "main", entries });
    expect(signalsOf(findings).sort()).toEqual(["fan-out", "on-trunk", "untracked-source"]);
  });
});

describe("parseStatusPorcelain", () => {
  it("parses codes and paths, and follows renames to their destination", () => {
    const raw = [
      " M packages/fill/src/index.ts",
      "?? scripts/new.ts",
      "R  old/a.ts -> new/a.ts",
    ].join("\n");
    expect(parseStatusPorcelain(raw)).toEqual([
      { code: " M", path: "packages/fill/src/index.ts" },
      { code: "??", path: "scripts/new.ts" },
      { code: "R ", path: "new/a.ts" },
    ]);
  });

  it("ignores blank trailing output", () => {
    expect(parseStatusPorcelain(" M a.ts\n\n")).toHaveLength(1);
  });
});

describe("the shell fast path", () => {
  // wip-report.sh reimplements this check in pure git so it needs no
  // Node on PATH, which means the thresholds live in two places. Assert
  // they agree rather than trusting that both get updated — silent
  // divergence between a checker and its copy is the exact failure mode
  // this whole check exists to catch.
  const hook = readFileSync("scripts/wip-report.sh", "utf8");

  const literalOf = (name: string): number => {
    const match = hook.match(new RegExp(`^${name}=(\\d+)$`, "m"));
    if (match === null) {
      throw new Error(`${name} not found in wip-report.sh`);
    }
    return Number(match[1]);
  };

  it("uses the same file-count threshold as the checker", () => {
    expect(literalOf("FILE_COUNT_THRESHOLD")).toBe(FILE_COUNT_THRESHOLD);
  });

  it("uses the same area-count threshold as the checker", () => {
    expect(literalOf("AREA_COUNT_THRESHOLD")).toBe(AREA_COUNT_THRESHOLD);
  });
});

describe("the Cursor hook wiring", () => {
  // A reporter nobody runs is worse than no reporter, because the
  // silence reads as "nothing to report". Assert the events stay wired.
  const hooks = JSON.parse(readFileSync(".cursor/hooks.json", "utf8")) as {
    hooks: Record<string, ReadonlyArray<{ command: string }>>;
  };

  it.each(["sessionStart", "stop"])("runs the reporter on %s", (event) => {
    const commands = (hooks.hooks[event] ?? []).map((h) => h.command);
    expect(commands).toContain("sh scripts/wip-report.sh");
  });
});
