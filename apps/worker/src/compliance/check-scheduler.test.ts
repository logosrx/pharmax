// Compliance check scheduler tests.
//
// The assertions here are chosen around one question: what would let
// this loop report a healthy control program while not actually
// verifying anything? Every test below pins a behaviour that would
// otherwise fail silently and green.
//
//   - A check code with no registered probe records ERROR, not
//     nothing. A skipped check keeps its last green run on the
//     dashboard forever.
//   - nextRunAt advances on FAIL and on ERROR, not only on PASS,
//     so a broken probe cannot pin the loop to one row.
//   - A failing check opens exactly one task, no matter how many
//     ticks or how many per-tenant verdicts failed.
//   - An accepted exception suppresses the TASK but never the
//     evidence row.
//   - A mixed per-tenant fan-out rolls up to the worst verdict, so
//     one failing tenant is not averaged into a pass.

import type { ComplianceCheckDefinition } from "@pharmax/compliance";
import { clock, logger } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  createComplianceCheckScheduler,
  type ComplianceCheckSchedulerDeps,
} from "./check-scheduler.js";

const FROZEN_NOW = new Date("2026-08-02T12:00:00.000Z");

interface DueCheckRow {
  readonly id: string;
  readonly code: string;
  readonly severity: string;
  readonly intervalMinutes: number | null;
  readonly consecutiveFailureCount: number;
}

interface FakeState {
  readonly createManyCalls: { data: Record<string, unknown>[] }[];
  readonly checkUpdateCalls: { where: { id: string }; data: Record<string, unknown> }[];
  readonly taskCreateCalls: { data: Record<string, unknown> }[];
}

function buildFake(input: {
  readonly due: readonly DueCheckRow[];
  readonly activeException?: boolean;
  readonly openTask?: boolean;
}): { prisma: ComplianceCheckSchedulerDeps["prisma"]; state: FakeState } {
  const state: FakeState = {
    createManyCalls: [],
    checkUpdateCalls: [],
    taskCreateCalls: [],
  };

  const tx = {
    $executeRaw: vi.fn(async () => 1),
    complianceCheckRun: {
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        state.createManyCalls.push(args);
        return { count: args.data.length };
      }),
    },
    complianceCheck: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        state.checkUpdateCalls.push(args);
        return {};
      }),
    },
    complianceCheckException: {
      findFirst: vi.fn(async () => (input.activeException === true ? { id: "exc-1" } : null)),
    },
    complianceTask: {
      findFirst: vi.fn(async () => (input.openTask === true ? { id: "task-1" } : null)),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.taskCreateCalls.push(args);
        return { id: "task-new" };
      }),
    },
  };

  const prisma = {
    complianceCheck: {
      findMany: vi.fn(async () => input.due),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as ComplianceCheckSchedulerDeps["prisma"];

  return { prisma, state };
}

function probe(input: {
  readonly code: string;
  readonly verdicts?: readonly {
    outcome: "PASS" | "FAIL" | "NOT_APPLICABLE";
    subjectOrganizationId?: string | null;
  }[];
  readonly throws?: boolean;
}): ComplianceCheckDefinition {
  return {
    code: input.code,
    title: `Probe ${input.code}`,
    description: "Test probe.",
    severity: "HIGH",
    cadence: "DAILY",
    intervalMinutes: 1440,
    controlCodes: ["CC-TEST-1"],
    evaluate: async () => {
      if (input.throws === true) throw new Error("probe exploded");
      return (input.verdicts ?? [{ outcome: "PASS" as const }]).map((v) => ({
        outcome: v.outcome,
        summary: `${input.code} says ${v.outcome}`,
        findings: v.outcome === "FAIL" ? [{ subject: "thing", detail: "is wrong" }] : [],
        details: { checked: 1 },
        subjectOrganizationId: v.subjectOrganizationId ?? null,
      }));
    },
  };
}

function makeScheduler(
  prisma: ComplianceCheckSchedulerDeps["prisma"],
  definitions: readonly ComplianceCheckDefinition[]
): ReturnType<typeof createComplianceCheckScheduler> {
  const byCode = new Map(definitions.map((d) => [d.code, d]));
  return createComplianceCheckScheduler({
    prisma,
    clock: clock.createFrozenClock(FROZEN_NOW),
    logger: logger.noopLogger,
    resolveCheckDefinition: (code) => byCode.get(code),
  });
}

const passingRow: DueCheckRow = {
  id: "chk-1",
  code: "test.passing",
  severity: "HIGH",
  intervalMinutes: 60,
  consecutiveFailureCount: 3,
};

describe("compliance check scheduler — passing check", () => {
  it("records the run, advances nextRunAt, and clears the failure streak", async () => {
    const fake = buildFake({ due: [passingRow] });
    const scheduler = makeScheduler(fake.prisma, [probe({ code: "test.passing" })]);

    const summary = await scheduler.tick();

    expect(summary.ranCount).toBe(1);
    expect(summary.runsRecorded).toBe(1);
    expect(summary.failedRunCount).toBe(0);
    expect(summary.tasksOpened).toBe(0);

    expect(fake.state.createManyCalls).toHaveLength(1);
    const run = fake.state.createManyCalls[0]?.data[0];
    expect(run?.outcome).toBe("PASS");
    expect(run?.checkCode).toBe("test.passing");
    // Digest is present so the row is verifiable after export.
    expect(typeof run?.digestSha256).toBe("string");
    expect((run?.digestSha256 as string).length).toBe(64);

    const update = fake.state.checkUpdateCalls[0];
    expect(update?.data.lastOutcome).toBe("PASS");
    expect(update?.data.consecutiveFailureCount).toBe(0);
    expect(update?.data.nextRunAt).toEqual(new Date("2026-08-02T13:00:00.000Z"));
  });
});

describe("compliance check scheduler — failing check", () => {
  it("opens exactly one remediation task and increments the failure streak", async () => {
    const fake = buildFake({ due: [{ ...passingRow, code: "test.failing" }] });
    const scheduler = makeScheduler(fake.prisma, [
      probe({ code: "test.failing", verdicts: [{ outcome: "FAIL" }] }),
    ]);

    const summary = await scheduler.tick();

    expect(summary.failedRunCount).toBe(1);
    expect(summary.tasksOpened).toBe(1);
    expect(fake.state.checkUpdateCalls[0]?.data.lastOutcome).toBe("FAIL");
    expect(fake.state.checkUpdateCalls[0]?.data.consecutiveFailureCount).toBe(4);

    const task = fake.state.taskCreateCalls[0]?.data;
    expect(task?.checkId).toBe("chk-1");
    expect(task?.severity).toBe("HIGH");
    // HIGH severity ⇒ due in 3 days.
    expect(task?.dueAt).toEqual(new Date("2026-08-05T12:00:00.000Z"));
  });

  it("does not open a second task when one is already open", async () => {
    const fake = buildFake({ due: [{ ...passingRow, code: "test.failing" }], openTask: true });
    const scheduler = makeScheduler(fake.prisma, [
      probe({ code: "test.failing", verdicts: [{ outcome: "FAIL" }] }),
    ]);

    const summary = await scheduler.tick();

    expect(summary.failedRunCount).toBe(1);
    expect(summary.tasksOpened).toBe(0);
    // Evidence is still written — dedupe applies to the response only.
    expect(fake.state.createManyCalls).toHaveLength(1);
  });

  it("still records the failing run when an exception is active, but opens no task", async () => {
    const fake = buildFake({
      due: [{ ...passingRow, code: "test.failing" }],
      activeException: true,
    });
    const scheduler = makeScheduler(fake.prisma, [
      probe({ code: "test.failing", verdicts: [{ outcome: "FAIL" }] }),
    ]);

    const summary = await scheduler.tick();

    expect(summary.tasksOpened).toBe(0);
    expect(fake.state.createManyCalls[0]?.data[0]?.outcome).toBe("FAIL");
    expect(fake.state.taskCreateCalls).toHaveLength(0);
  });
});

describe("compliance check scheduler — a check that is not actually running", () => {
  it("records an ERROR run for an unregistered code rather than skipping it", async () => {
    const fake = buildFake({ due: [{ ...passingRow, code: "test.deleted_probe" }] });
    // Registry deliberately empty for this code.
    const scheduler = makeScheduler(fake.prisma, []);

    const summary = await scheduler.tick();

    expect(summary.unresolvedCount).toBe(1);
    expect(summary.ranCount).toBe(0);
    expect(summary.erroredRunCount).toBe(1);

    const run = fake.state.createManyCalls[0]?.data[0];
    expect(run?.outcome).toBe("ERROR");
    expect(run?.errorCode).toBe("COMPLIANCE_CHECK_NOT_REGISTERED");
    expect(String(run?.summary)).toContain("UNKNOWN, not satisfied");

    // And the schedule still moves, so this row does not monopolise
    // every future tick.
    expect(fake.state.checkUpdateCalls[0]?.data.nextRunAt).toEqual(
      new Date("2026-08-02T13:00:00.000Z")
    );
  });

  it("records ERROR (never PASS) when the probe throws", async () => {
    const fake = buildFake({ due: [{ ...passingRow, code: "test.throwing" }] });
    const scheduler = makeScheduler(fake.prisma, [probe({ code: "test.throwing", throws: true })]);

    const summary = await scheduler.tick();

    expect(summary.erroredRunCount).toBe(1);
    expect(fake.state.createManyCalls[0]?.data[0]?.outcome).toBe("ERROR");
    expect(fake.state.checkUpdateCalls[0]?.data.lastOutcome).toBe("ERROR");
    // A thrown probe is still a failure streak — it must not read as
    // "recovered" just because it did not report FAIL.
    expect(fake.state.checkUpdateCalls[0]?.data.consecutiveFailureCount).toBe(4);
  });
});

describe("compliance check scheduler — per-tenant fan-out", () => {
  it("rolls a mixed result up to the worst verdict", async () => {
    const fake = buildFake({ due: [{ ...passingRow, code: "test.per_org" }] });
    const scheduler = makeScheduler(fake.prisma, [
      probe({
        code: "test.per_org",
        verdicts: [
          { outcome: "PASS", subjectOrganizationId: "org-a" },
          { outcome: "FAIL", subjectOrganizationId: "org-b" },
          { outcome: "PASS", subjectOrganizationId: "org-c" },
        ],
      }),
    ]);

    const summary = await scheduler.tick();

    // One evidence row per tenant.
    expect(summary.runsRecorded).toBe(3);
    expect(fake.state.createManyCalls[0]?.data).toHaveLength(3);
    // But one check-level outcome, and it is the bad one.
    expect(fake.state.checkUpdateCalls[0]?.data.lastOutcome).toBe("FAIL");
    // And one task, not one per failing tenant.
    expect(summary.tasksOpened).toBe(1);
  });
});

describe("compliance check scheduler — isolation", () => {
  it("keeps running the remaining checks when one probe throws", async () => {
    const fake = buildFake({
      due: [
        { ...passingRow, id: "chk-1", code: "test.throwing" },
        { ...passingRow, id: "chk-2", code: "test.passing" },
      ],
    });
    const scheduler = makeScheduler(fake.prisma, [
      probe({ code: "test.throwing", throws: true }),
      probe({ code: "test.passing" }),
    ]);

    const summary = await scheduler.tick();

    expect(summary.dueCount).toBe(2);
    expect(summary.runsRecorded).toBe(2);
    expect(summary.erroredRunCount).toBe(1);
    expect(fake.state.checkUpdateCalls.map((c) => c.where.id)).toEqual(["chk-1", "chk-2"]);
  });

  it("is a no-op when nothing is due", async () => {
    const fake = buildFake({ due: [] });
    const scheduler = makeScheduler(fake.prisma, []);

    const summary = await scheduler.tick();

    expect(summary).toEqual({
      dueCount: 0,
      ranCount: 0,
      unresolvedCount: 0,
      runsRecorded: 0,
      failedRunCount: 0,
      erroredRunCount: 0,
      tasksOpened: 0,
    });
    expect(fake.state.createManyCalls).toHaveLength(0);
  });
});
