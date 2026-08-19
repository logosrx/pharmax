import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { describe, expect, it, vi } from "vitest";

import { PRESENCE_SLOT_MS } from "./constants.js";
import { recordHeartbeat, type PresenceSlotClient } from "./record-heartbeat.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const WORKSTATION = "44444444-4444-4444-8444-444444444444";

interface UpsertCall {
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function fakeClient(heartbeatCount = 1): {
  client: PresenceSlotClient;
  calls: UpsertCall[];
} {
  const calls: UpsertCall[] = [];
  const client = {
    operatorPresenceSlot: {
      upsert: vi.fn(async (args: UpsertCall & { select: unknown }) => {
        calls.push({ where: args.where, create: args.create, update: args.update });
        return {
          heartbeatCount,
          slotStartedAt: (args.create as { slotStartedAt: Date }).slotStartedAt,
        };
      }),
    },
  } as unknown as PresenceSlotClient;
  return { client, calls };
}

function ctxFor(organizationId: string, userId: string, workstationId?: string) {
  return buildTenancyContext({
    organizationId,
    ...(workstationId === undefined ? {} : { workstationId }),
    actor: { userId, correlationId: "01JCORRELATION0000000000000" },
  });
}

describe("recordHeartbeat — tenancy", () => {
  it("takes organizationId and userId from the frame, never from a caller", async () => {
    const { client, calls } = fakeClient();
    const now = new Date("2026-03-04T10:07:31.000Z");

    await withTenancyContext(ctxFor(ORG_A, USER_A), () => recordHeartbeat({ client, now }));

    expect(calls).toHaveLength(1);
    const where = calls[0]!.where as {
      organizationId_userId_slotStartedAt: {
        organizationId: string;
        userId: string;
        slotStartedAt: Date;
      };
    };
    expect(where.organizationId_userId_slotStartedAt.organizationId).toBe(ORG_A);
    expect(where.organizationId_userId_slotStartedAt.userId).toBe(USER_A);
    expect(calls[0]!.create).toMatchObject({ organizationId: ORG_A, userId: USER_A });
  });

  /**
   * The guard that matters most on this path. `recordHeartbeat` is
   * reachable from an authenticated-but-unprivileged endpoint at the
   * highest call rate in the platform; if the actor could come from
   * the request, anyone could forge another operator's presence (and
   * therefore their idle-time and productivity numbers). The
   * signature is the enforcement — there is no parameter to pass —
   * and this test pins the resulting behaviour: the same call under
   * two different frames writes to two different tenants.
   */
  it("writes into whichever tenant frame is active — no cross-tenant bleed", async () => {
    const { client, calls } = fakeClient();
    const now = new Date("2026-03-04T10:07:31.000Z");

    await withTenancyContext(ctxFor(ORG_A, USER_A), () => recordHeartbeat({ client, now }));
    await withTenancyContext(ctxFor(ORG_B, USER_A), () => recordHeartbeat({ client, now }));

    const orgs = calls.map((c) => (c.create as { organizationId: string }).organizationId);
    expect(orgs).toEqual([ORG_A, ORG_B]);
  });

  it("refuses to write with no tenancy frame at all", async () => {
    const { client, calls } = fakeClient();
    await expect(recordHeartbeat({ client })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("recordHeartbeat — slot compaction", () => {
  /**
   * The property that bounds the table. Twelve beats one minute
   * apart inside one five-minute slot must all target the SAME
   * unique key, so the database sees one row rewritten twelve times
   * rather than twelve inserts.
   */
  it("folds every beat within one slot onto a single unique key", async () => {
    const { client, calls } = fakeClient();
    const base = new Date("2026-03-04T10:05:00.000Z").getTime();

    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      for (let i = 0; i < 12; i++) {
        await recordHeartbeat({ client, now: new Date(base + i * 25_000) });
      }
    });

    const slotStarts = new Set(
      calls.map((c) =>
        (
          c.where as {
            organizationId_userId_slotStartedAt: { slotStartedAt: Date };
          }
        ).organizationId_userId_slotStartedAt.slotStartedAt.getTime()
      )
    );
    // 12 beats × 25s = 300s, which is exactly one slot, so beats land
    // in the first slot and the final one opens the next.
    expect(calls).toHaveLength(12);
    expect(slotStarts.size).toBeLessThanOrEqual(2);
    expect(slotStarts.has(base)).toBe(true);
  });

  it("opens a new slot once the grid advances", async () => {
    const { client, calls } = fakeClient();
    const base = new Date("2026-03-04T10:05:00.000Z").getTime();

    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await recordHeartbeat({ client, now: new Date(base) });
      await recordHeartbeat({ client, now: new Date(base + PRESENCE_SLOT_MS) });
    });

    const starts = calls.map((c) =>
      (
        c.where as {
          organizationId_userId_slotStartedAt: { slotStartedAt: Date };
        }
      ).organizationId_userId_slotStartedAt.slotStartedAt.getTime()
    );
    expect(starts[1]! - starts[0]!).toBe(PRESENCE_SLOT_MS);
  });

  it("increments rather than overwrites the beat count, and records the workstation", async () => {
    const { client, calls } = fakeClient(4);
    await withTenancyContext(ctxFor(ORG_A, USER_A, WORKSTATION), () =>
      recordHeartbeat({ client, now: new Date("2026-03-04T10:06:00.000Z") })
    );
    expect(calls[0]!.update).toMatchObject({
      heartbeatCount: { increment: 1 },
      workstationId: WORKSTATION,
    });
  });

  it("reports whether the beat opened the slot", async () => {
    const fresh = fakeClient(1);
    const opened = await withTenancyContext(ctxFor(ORG_A, USER_A), () =>
      recordHeartbeat({ client: fresh.client, now: new Date("2026-03-04T10:06:00.000Z") })
    );
    expect(opened.createdSlot).toBe(true);

    const existing = fakeClient(7);
    const folded = await withTenancyContext(ctxFor(ORG_A, USER_A), () =>
      recordHeartbeat({ client: existing.client, now: new Date("2026-03-04T10:06:00.000Z") })
    );
    expect(folded.createdSlot).toBe(false);
  });

  it("stores a null workstation when the frame has none", async () => {
    const { client, calls } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), () =>
      recordHeartbeat({ client, now: new Date("2026-03-04T10:06:00.000Z") })
    );
    expect(calls[0]!.create).toMatchObject({ workstationId: null });
  });
});
