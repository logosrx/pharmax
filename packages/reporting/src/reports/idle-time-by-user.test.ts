import { PRESENCE_SLOT_MS } from "@pharmax/presence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { idleTimeByUserReport } from "./idle-time-by-user.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";

const MIN = 60_000;
const T0 = new Date("2026-05-10T09:00:00.000Z").getTime();

const window = {
  from: new Date("2026-05-10T00:00:00.000Z"),
  to: new Date("2026-05-10T23:59:59.999Z"),
  idleThresholdMinutes: 5,
};

function at(minutes: number): Date {
  return new Date(T0 + minutes * MIN);
}

interface FakeSlot {
  userId: string;
  slotStartedAt: Date;
  firstHeartbeatAt: Date;
  lastHeartbeatAt: Date;
  user: { displayName: string };
}

/** A slot covering [index*5, index*5+5) minutes from T0. */
function slot(userId: string, index: number, displayName: string): FakeSlot {
  const start = T0 + index * PRESENCE_SLOT_MS;
  return {
    userId,
    slotStartedAt: new Date(start),
    firstHeartbeatAt: new Date(start),
    lastHeartbeatAt: new Date(start + 4 * MIN),
    user: { displayName },
  };
}

function fakeClient(input: {
  slots: ReadonlyArray<FakeSlot>;
  activity?: ReadonlyArray<{ userId: string; occurredAt: Date }>;
  commands?: ReadonlyArray<{ actorUserId: string | null; startedAt: Date }>;
}) {
  const queries: Record<string, unknown[]> = { slots: [], activity: [], commands: [] };
  const client = {
    operatorPresenceSlot: {
      findMany: vi.fn(async (args: unknown) => {
        queries.slots!.push(args);
        return input.slots;
      }),
    },
    operatorActivityEvent: {
      findMany: vi.fn(async (args: unknown) => {
        queries.activity!.push(args);
        return input.activity ?? [];
      }),
    },
    commandLog: {
      findMany: vi.fn(async (args: unknown) => {
        queries.commands!.push(args);
        return input.commands ?? [];
      }),
    },
  };
  return { client, queries };
}

afterEach(() => vi.restoreAllMocks());

describe("idleTimeByUserReport — tenancy", () => {
  it("scopes every query by organizationId", async () => {
    const { client, queries } = fakeClient({ slots: [slot(USER_A, 0, "Sam Tech")] });
    await idleTimeByUserReport.run({ client: client as never, organizationId: ORG_ID }, window);

    for (const key of ["slots", "activity", "commands"]) {
      const args = queries[key]![0] as { where: { organizationId?: string } };
      expect(args.where.organizationId, `${key} query is not org-scoped`).toBe(ORG_ID);
    }
  });

  it("returns an empty result when the org has no presence in the window", async () => {
    const { client } = fakeClient({ slots: [] });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toEqual([]);
    expect(result.aggregates).toMatchObject({ operatorCount: 0, totalIdleSeconds: 0 });
  });
});

describe("idleTimeByUserReport — derivation", () => {
  it("scores a present operator who did nothing as fully idle", async () => {
    const { client } = fakeClient({
      slots: [
        slot(USER_A, 0, "Sam Tech"),
        slot(USER_A, 1, "Sam Tech"),
        slot(USER_A, 2, "Sam Tech"),
      ],
    });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      userId: USER_A,
      userDisplayName: "Sam Tech",
      presentSeconds: 14 * 60,
      idleSeconds: 14 * 60,
      activeSeconds: 0,
      idleRateBps: 10_000,
    });
  });

  /**
   * The correctness point that matters most for this report's
   * credibility. A tech spends most of a shift inside commands; if
   * `command_log` were not counted as activity, the report would
   * score the busiest operators as the most idle.
   */
  it("counts command_log activity, not just operator_activity_event", async () => {
    const slots = [
      slot(USER_A, 0, "Sam Tech"),
      slot(USER_A, 1, "Sam Tech"),
      slot(USER_A, 2, "Sam Tech"),
    ];

    const withoutCommands = fakeClient({ slots });
    const idleWithout = (
      await idleTimeByUserReport.run(
        { client: withoutCommands.client as never, organizationId: ORG_ID },
        window
      )
    ).rows[0]!.idleSeconds;

    const withCommands = fakeClient({
      slots,
      commands: [
        { actorUserId: USER_A, startedAt: at(3) },
        { actorUserId: USER_A, startedAt: at(7) },
        { actorUserId: USER_A, startedAt: at(11) },
        { actorUserId: USER_A, startedAt: at(13) },
      ],
    });
    const idleWith = (
      await idleTimeByUserReport.run(
        { client: withCommands.client as never, organizationId: ORG_ID },
        window
      )
    ).rows[0]!.idleSeconds;

    expect(idleWithout).toBe(14 * 60);
    expect(idleWith).toBe(0);
  });

  it("blends activity events and commands into one timeline", async () => {
    const { client } = fakeClient({
      slots: [
        slot(USER_A, 0, "Sam Tech"),
        slot(USER_A, 1, "Sam Tech"),
        slot(USER_A, 2, "Sam Tech"),
      ],
      activity: [{ userId: USER_A, occurredAt: at(3) }],
      commands: [
        { actorUserId: USER_A, startedAt: at(7) },
        { actorUserId: USER_A, startedAt: at(12) },
      ],
    });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    // Marks at 0 (span start), 3, 7, 12, 14 (span end) — every gap
    // is <= 5 minutes, so nothing is idle.
    expect(result.rows[0]!.idleSeconds).toBe(0);
  });

  /**
   * Absence must not read as idle. A missing slot means no heartbeat
   * at all — the operator went home. Counting that as idle would
   * make every overnight a sixteen-hour idle window.
   */
  it("treats a heartbeat gap as absence, not idle", async () => {
    const { client } = fakeClient({
      // Slots 0,1 then a hole, then 6,7 — two separate sittings.
      slots: [
        slot(USER_A, 0, "Sam Tech"),
        slot(USER_A, 1, "Sam Tech"),
        slot(USER_A, 6, "Sam Tech"),
        slot(USER_A, 7, "Sam Tech"),
      ],
      commands: [
        { actorUserId: USER_A, startedAt: at(2) },
        { actorUserId: USER_A, startedAt: at(6) },
        { actorUserId: USER_A, startedAt: at(32) },
        { actorUserId: USER_A, startedAt: at(36) },
      ],
    });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.presenceSpanCount).toBe(2);
    // Two sittings of 9 minutes each — the 20-minute absence between
    // them is neither present nor idle.
    expect(row.presentSeconds).toBe(18 * 60);
    expect(row.idleSeconds).toBe(0);
  });

  it("honours a custom idle threshold", async () => {
    const slots = [
      slot(USER_A, 0, "Sam Tech"),
      slot(USER_A, 1, "Sam Tech"),
      slot(USER_A, 2, "Sam Tech"),
    ];
    const commands = [
      { actorUserId: USER_A, startedAt: at(0) },
      { actorUserId: USER_A, startedAt: at(8) },
      { actorUserId: USER_A, startedAt: at(14) },
    ];

    const lenient = fakeClient({ slots, commands });
    const lenientRow = (
      await idleTimeByUserReport.run(
        { client: lenient.client as never, organizationId: ORG_ID },
        { ...window, idleThresholdMinutes: 10 }
      )
    ).rows[0]!;
    expect(lenientRow.idleSeconds).toBe(0);

    const strict = fakeClient({ slots, commands });
    const strictRow = (
      await idleTimeByUserReport.run(
        { client: strict.client as never, organizationId: ORG_ID },
        { ...window, idleThresholdMinutes: 5 }
      )
    ).rows[0]!;
    // The 8-minute and 6-minute gaps both exceed 5 minutes.
    expect(strictRow.idleSeconds).toBe(14 * 60);
    expect(strictRow.idleWindowCount).toBe(2);
    expect(strictRow.longestIdleSeconds).toBe(8 * 60);
  });

  it("ignores a command with no actor", async () => {
    const { client } = fakeClient({
      slots: [slot(USER_A, 0, "Sam Tech"), slot(USER_A, 1, "Sam Tech")],
      commands: [{ actorUserId: null, startedAt: at(3) }],
    });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows[0]!.idleSeconds).toBe(9 * 60);
  });
});

describe("idleTimeByUserReport — shaping", () => {
  it("ranks the most idle operator first", async () => {
    const { client } = fakeClient({
      slots: [
        slot(USER_A, 0, "Sam Tech"),
        slot(USER_A, 1, "Sam Tech"),
        slot(USER_A, 2, "Sam Tech"),
        slot(USER_B, 0, "Robin Pharm"),
        slot(USER_B, 1, "Robin Pharm"),
      ],
      commands: [
        { actorUserId: USER_B, startedAt: at(2) },
        { actorUserId: USER_B, startedAt: at(6) },
        { actorUserId: USER_B, startedAt: at(9) },
      ],
    });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.userId)).toEqual([USER_A, USER_B]);
    expect(result.rows[0]!.idleSeconds).toBeGreaterThan(result.rows[1]!.idleSeconds);
  });

  it("aggregates across operators", async () => {
    const { client } = fakeClient({
      slots: [
        slot(USER_A, 0, "Sam Tech"),
        slot(USER_A, 1, "Sam Tech"),
        slot(USER_B, 0, "Robin Pharm"),
        slot(USER_B, 1, "Robin Pharm"),
      ],
    });
    const result = await idleTimeByUserReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.aggregates).toMatchObject({
      operatorCount: 2,
      totalPresentSeconds: 18 * 60,
      totalIdleSeconds: 18 * 60,
      totalActiveSeconds: 0,
      overallIdleRateBps: 10_000,
    });
  });

  it("is registered with a stable id and a described threshold parameter", () => {
    expect(idleTimeByUserReport.id).toBe("idle-time-by-user");
    const field = idleTimeByUserReport.parameterFields?.find(
      (f) => f.key === "idleThresholdMinutes"
    );
    expect(field?.kind).toBe("number");
    expect(field?.required).toBe(false);
  });
});
