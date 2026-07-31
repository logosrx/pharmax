import { describe, expect, it } from "vitest";

import { LoginOutcome, type PrismaClient } from "@pharmax/database";

import {
  DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD,
  FAILED_LOGIN_OUTCOMES,
  UNATTRIBUTED_FAILED_LOGIN_ORG,
  createWorkerDigestProbes,
} from "./digest-probes.js";

const WINDOW_START = new Date("2026-07-30T02:30:00.000Z");
const WINDOW_END = new Date("2026-07-31T02:30:00.000Z");

interface FakeSessionRow {
  id: string;
  requestedByUserId: string;
  approvedByUserId: string | null;
  ticketUrl: string;
  openedAt: Date;
  closedAt: Date | null;
  _count: { actions: number };
}

function buildFakePrisma(input: {
  readonly sessions?: ReadonlyArray<FakeSessionRow>;
  readonly failedLoginGroups?: ReadonlyArray<{
    organizationId: string | null;
    _count: { _all: number };
  }>;
}): { prisma: PrismaClient; capturedQueries: Record<string, unknown>[] } {
  const capturedQueries: Record<string, unknown>[] = [];
  const fake = {
    breakGlassSession: {
      async findMany(args: Record<string, unknown>) {
        capturedQueries.push({ model: "breakGlassSession", ...args });
        return [...(input.sessions ?? [])];
      },
    },
    loginAttempt: {
      async groupBy(args: Record<string, unknown>) {
        capturedQueries.push({ model: "loginAttempt", ...args });
        return [...(input.failedLoginGroups ?? [])];
      },
    },
  };
  return { prisma: fake as unknown as PrismaClient, capturedQueries };
}

describe("break-glass digest probe", () => {
  it("maps sessions opened in the window to digest entries", async () => {
    const openedAt = new Date("2026-07-30T14:00:00.000Z");
    const closedAt = new Date("2026-07-30T14:45:00.000Z");
    const { prisma, capturedQueries } = buildFakePrisma({
      sessions: [
        {
          id: "s-1",
          requestedByUserId: "u-eng",
          approvedByUserId: "u-approver",
          ticketUrl: "https://tickets/INC-9",
          openedAt,
          closedAt,
          _count: { actions: 3 },
        },
        {
          id: "s-2",
          requestedByUserId: "u-eng",
          approvedByUserId: null,
          ticketUrl: "https://tickets/INC-10",
          openedAt,
          closedAt: null,
          _count: { actions: 0 },
        },
      ],
    });
    const probes = createWorkerDigestProbes({ prisma });

    const entries = await probes.breakGlass.listOpenedInWindow({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(entries).toEqual([
      {
        sessionId: "s-1",
        requestedByUserId: "u-eng",
        approvedByUserId: "u-approver",
        ticketUrl: "https://tickets/INC-9",
        openedAt: openedAt.toISOString(),
        closedAt: closedAt.toISOString(),
        actionCount: 3,
      },
      {
        sessionId: "s-2",
        requestedByUserId: "u-eng",
        approvedByUserId: null,
        ticketUrl: "https://tickets/INC-10",
        openedAt: openedAt.toISOString(),
        closedAt: null,
        actionCount: 0,
      },
    ]);
    // The query is windowed on openedAt — half-open [start, end).
    expect(capturedQueries[0]).toMatchObject({
      model: "breakGlassSession",
      where: { openedAt: { gte: WINDOW_START, lt: WINDOW_END } },
    });
  });
});

describe("failed-login digest probe", () => {
  it("reports only orgs at/above the threshold, mapping the null org to the unattributed bucket", async () => {
    const { prisma, capturedQueries } = buildFakePrisma({
      failedLoginGroups: [
        { organizationId: "org-quiet", _count: { _all: 2 } },
        { organizationId: "org-loud", _count: { _all: 41 } },
        { organizationId: null, _count: { _all: 150 } },
      ],
    });
    const probes = createWorkerDigestProbes({ prisma });

    const spikes = await probes.failedLogins.listSpikes({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(spikes).toEqual([
      {
        organizationId: UNATTRIBUTED_FAILED_LOGIN_ORG,
        windowHours: 24,
        failedLoginCount: 150,
        threshold: DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD,
      },
      {
        organizationId: "org-loud",
        windowHours: 24,
        failedLoginCount: 41,
        threshold: DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD,
      },
    ]);
    // Every attack-signal outcome is in the filter; SUCCESS and
    // MFA_REQUIRED (normal step-up prompt) are not.
    expect(capturedQueries[0]).toMatchObject({
      model: "loginAttempt",
      where: {
        outcome: { in: [...FAILED_LOGIN_OUTCOMES] },
        createdAt: { gte: WINDOW_START, lt: WINDOW_END },
      },
    });
    expect(FAILED_LOGIN_OUTCOMES).not.toContain(LoginOutcome.SUCCESS);
    expect(FAILED_LOGIN_OUTCOMES).not.toContain(LoginOutcome.MFA_REQUIRED);
  });

  it("honors a threshold override", async () => {
    const { prisma } = buildFakePrisma({
      failedLoginGroups: [{ organizationId: "org-a", _count: { _all: 3 } }],
    });
    const probes = createWorkerDigestProbes({ prisma, failedLoginSpikeThreshold: 3 });

    const spikes = await probes.failedLogins.listSpikes({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(spikes).toEqual([
      { organizationId: "org-a", windowHours: 24, failedLoginCount: 3, threshold: 3 },
    ]);
  });
});
