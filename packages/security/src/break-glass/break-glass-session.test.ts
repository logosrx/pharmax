import { describe, expect, it } from "vitest";

import { clock as clockNs } from "@pharmax/platform-core";

import {
  BREAK_GLASS_SESSION_ALREADY_CLOSED,
  BREAK_GLASS_SESSION_EXPIRED,
  BREAK_GLASS_SESSION_REASON_REQUIRED,
  BREAK_GLASS_SESSION_TICKET_REQUIRED,
} from "./errors.js";
import {
  closeBreakGlassSession,
  openBreakGlassSession,
  type BreakGlassActionRecord,
  type BreakGlassClient,
  type BreakGlassSessionRecord,
  type PrismaSystemContextTx,
} from "./break-glass-session.js";

interface FakeClient extends BreakGlassClient {
  readonly sessions: BreakGlassSessionRecord[];
  readonly actions: BreakGlassActionRecord[];
  readonly txReasons: string[];
}

function buildFakeClient(): FakeClient {
  const sessions: BreakGlassSessionRecord[] = [];
  const actions: BreakGlassActionRecord[] = [];
  const txReasons: string[] = [];

  return {
    sessions,
    actions,
    txReasons,
    async insertSession(input) {
      const rec: BreakGlassSessionRecord = {
        id: input.id,
        reason: input.reason,
        requestedByUserId: input.requestedByUserId,
        ticketUrl: input.ticketUrl,
        approvedByUserId: input.approvedByUserId,
        maxDurationMinutes: input.maxDurationMinutes,
        openedAt: input.openedAt,
        closedAt: null,
        resolution: null,
      };
      sessions.push(rec);
      return rec;
    },
    async closeSession(input) {
      const rec = sessions.find((s) => s.id === input.id);
      if (rec === undefined) throw new Error(`session ${input.id} not found`);
      rec.closedAt = input.closedAt;
      rec.resolution = input.resolution;
      return rec;
    },
    async recordAction(input) {
      const rec: BreakGlassActionRecord = { ...input };
      actions.push(rec);
      return rec;
    },
    async withSystemContextTx(args, fn) {
      txReasons.push(args.reason);
      const fakeTx: PrismaSystemContextTx = {
        async $executeRaw() {
          return 0;
        },
        async $queryRaw<T>(): Promise<T> {
          return [] as unknown as T;
        },
      };
      return fn(fakeTx);
    },
  };
}

function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const REQUESTER = "11111111-1111-1111-1111-111111111111";
const APPROVER = "22222222-2222-2222-2222-222222222222";

describe("openBreakGlassSession", () => {
  it("validates the reason and ticket URL", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    await expect(
      openBreakGlassSession({
        client,
        idFactory: makeIdFactory("s"),
        actionIdFactory: makeIdFactory("a"),
        clock,
        session: {
          reason: "",
          requestedByUserId: REQUESTER,
          ticketUrl: "https://tickets/INC-1",
        },
      })
    ).rejects.toMatchObject({ code: BREAK_GLASS_SESSION_REASON_REQUIRED });

    await expect(
      openBreakGlassSession({
        client,
        idFactory: makeIdFactory("s"),
        actionIdFactory: makeIdFactory("a"),
        clock,
        session: {
          reason: "investigate stuck order",
          requestedByUserId: REQUESTER,
          ticketUrl: "",
        },
      })
    ).rejects.toMatchObject({ code: BREAK_GLASS_SESSION_TICKET_REQUIRED });
  });

  it("refuses self-approval (four-eyes rule)", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    await expect(
      openBreakGlassSession({
        client,
        idFactory: makeIdFactory("s"),
        actionIdFactory: makeIdFactory("a"),
        clock,
        session: {
          reason: "investigate",
          requestedByUserId: REQUESTER,
          approvedByUserId: REQUESTER,
          ticketUrl: "https://tickets/INC-1",
        },
      })
    ).rejects.toMatchObject({
      code: "BREAK_GLASS_SESSION_SELF_APPROVAL_FORBIDDEN",
    });
  });

  it("writes the session row with the configured duration", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock,
      session: {
        reason: "investigate stuck order ORD-7",
        requestedByUserId: REQUESTER,
        approvedByUserId: APPROVER,
        ticketUrl: "https://tickets/INC-1",
        maxDurationMinutes: 30,
      },
    });
    expect(client.sessions).toHaveLength(1);
    expect(handle.session.id).toBe("s-1");
    expect(handle.session.maxDurationMinutes).toBe(30);
    expect(handle.session.approvedByUserId).toBe(APPROVER);
    expect(handle.session.openedAt.toISOString()).toBe("2026-05-24T12:00:00.000Z");
  });
});

describe("BreakGlassSessionHandle.runAs", () => {
  it("records a successful action and runs the callback under system context", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock,
      session: {
        reason: "investigate",
        requestedByUserId: REQUESTER,
        ticketUrl: "https://tickets/INC-1",
      },
    });
    const result = await handle.runAs(
      { actionLabel: "lookup_user_by_email", parameters: { email: "[redacted]" } },
      async () => ({ ok: true })
    );
    expect(result).toEqual({ ok: true });
    expect(client.txReasons[0]).toBe("break-glass:s-1");
    expect(client.actions).toHaveLength(1);
    expect(client.actions[0]?.success).toBe(true);
    expect(client.actions[0]?.actionLabel).toBe("lookup_user_by_email");
    expect(client.actions[0]?.errorMessage).toBeNull();
  });

  it("records a failed action and rethrows the underlying error", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock,
      session: {
        reason: "investigate",
        requestedByUserId: REQUESTER,
        ticketUrl: "https://tickets/INC-1",
      },
    });
    await expect(
      handle.runAs({ actionLabel: "repair_order" }, async () => {
        throw new Error("connection reset");
      })
    ).rejects.toThrow(/connection reset/);
    expect(client.actions).toHaveLength(1);
    expect(client.actions[0]?.success).toBe(false);
    expect(client.actions[0]?.errorMessage).toMatch(/connection reset/);
  });

  it("refuses to execute after the session has expired", async () => {
    const client = buildFakeClient();
    const mutable = clockNs.createAdvancingClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock: mutable,
      session: {
        reason: "investigate",
        requestedByUserId: REQUESTER,
        ticketUrl: "https://tickets/INC-1",
        maxDurationMinutes: 1,
      },
    });
    mutable.advance(2 * 60_000);
    await expect(
      handle.runAs({ actionLabel: "late_action" }, async () => "nope")
    ).rejects.toMatchObject({ code: BREAK_GLASS_SESSION_EXPIRED });
  });

  it("refuses to execute after closeBreakGlassSession", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock,
      session: {
        reason: "investigate",
        requestedByUserId: REQUESTER,
        ticketUrl: "https://tickets/INC-1",
      },
    });
    await closeBreakGlassSession(handle, { client, clock, resolution: "resolved" });
    await expect(
      handle.runAs({ actionLabel: "after_close" }, async () => "x")
    ).rejects.toMatchObject({ code: BREAK_GLASS_SESSION_ALREADY_CLOSED });
  });
});

describe("closeBreakGlassSession", () => {
  it("requires a non-empty resolution", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock,
      session: {
        reason: "investigate",
        requestedByUserId: REQUESTER,
        ticketUrl: "https://tickets/INC-1",
      },
    });
    await expect(
      closeBreakGlassSession(handle, { client, clock, resolution: "   " })
    ).rejects.toMatchObject({ code: "BREAK_GLASS_SESSION_RESOLUTION_REQUIRED" });
  });

  it("marks the session closed and refuses double-close", async () => {
    const client = buildFakeClient();
    const clock = clockNs.createFrozenClock(new Date("2026-05-24T12:00:00.000Z"));
    const handle = await openBreakGlassSession({
      client,
      idFactory: makeIdFactory("s"),
      actionIdFactory: makeIdFactory("a"),
      clock,
      session: {
        reason: "investigate",
        requestedByUserId: REQUESTER,
        ticketUrl: "https://tickets/INC-1",
      },
    });
    const closed = await closeBreakGlassSession(handle, {
      client,
      clock,
      resolution: "resolved",
    });
    expect(closed.closedAt?.toISOString()).toBe("2026-05-24T12:00:00.000Z");
    expect(closed.resolution).toBe("resolved");
    await expect(
      closeBreakGlassSession(handle, { client, clock, resolution: "again" })
    ).rejects.toMatchObject({ code: BREAK_GLASS_SESSION_ALREADY_CLOSED });
  });
});
