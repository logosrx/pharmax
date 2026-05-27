import { describe, expect, it, vi } from "vitest";

import { OrderStageIntervalKind, Prisma } from "@pharmax/database";

import {
  applyCommandStageIntervalTransition,
  closeOpenStageInterval,
  isActiveIntervalKind,
  KNOWN_NON_SLA_COMMANDS,
  openInitialWaitBeforeTyping,
  openStageInterval,
  SLA_INTERVAL_ALREADY_OPEN,
  SLA_INTERVAL_COMMAND_UNMAPPED,
  SLA_INTERVAL_KIND_MISMATCH,
  SLA_INTERVAL_NEGATIVE_DURATION,
  SLA_INTERVAL_NONE_OPEN,
  SLA_INTERVAL_RACE_LOST,
  transitionStageIntervals,
} from "./interval-recorder.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const CMD_ID = "00000000-0000-4000-8000-0000000000bb";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const AT = new Date("2026-05-23T12:00:00.000Z");
const DEFAULT_OPEN_STARTED_AT = new Date("2026-05-23T11:00:00.000Z");

interface OpenRow {
  readonly id: string;
  readonly kind: OrderStageIntervalKind;
  readonly startedAt?: Date;
}

function buildTx(
  openRow: OpenRow | null = null,
  options: { updateManyCount?: number; createThrows?: unknown } = {}
) {
  let currentOpen: { id: string; kind: OrderStageIntervalKind; startedAt: Date } | null =
    openRow === null
      ? null
      : {
          id: openRow.id,
          kind: openRow.kind,
          startedAt: openRow.startedAt ?? DEFAULT_OPEN_STARTED_AT,
        };
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (options.createThrows !== undefined) {
      throw options.createThrows;
    }
    const startedAt = (args.data["startedAt"] as Date) ?? DEFAULT_OPEN_STARTED_AT;
    currentOpen = {
      id: "interval-1",
      kind: args.data["kind"] as OrderStageIntervalKind,
      startedAt,
    };
    return { id: "interval-1" };
  });
  const findFirst = vi.fn(async () => currentOpen);
  const updateMany = vi.fn(async () => {
    const count = options.updateManyCount ?? 1;
    if (count > 0) currentOpen = null;
    return { count };
  });
  return {
    tx: { orderStageInterval: { create, findFirst, updateMany } },
    create,
    findFirst,
    updateMany,
    getOpen: () => currentOpen,
  };
}

describe("openStageInterval", () => {
  it("creates an open interval row", async () => {
    const fake = buildTx(null);
    const out = await openStageInterval({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
      startedAt: AT,
      commandLogId: CMD_ID,
    });
    expect(out.intervalId).toBe("interval-1");
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          orderId: ORDER_ID,
          kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
          openCommandLogId: CMD_ID,
        }),
      })
    );
  });

  it("rejects when an interval is already open", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.TYPING_ACTIVE });
    await expect(
      openStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        kind: OrderStageIntervalKind.WAIT_BEFORE_PV1,
        startedAt: AT,
        commandLogId: CMD_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_ALREADY_OPEN });
  });

  // Defense-in-depth path: the application-layer findFirst guard sees
  // no open row, but a concurrent writer that bypassed the bus row
  // lock inserts one before our create lands. The DB partial unique
  // index `order_stage_interval_one_open_per_order` catches it and
  // Prisma surfaces P2002, which the primitive must translate back
  // into the typed SLA_INTERVAL_ALREADY_OPEN.
  it("maps Prisma P2002 from the partial unique index to SLA_INTERVAL_ALREADY_OPEN", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`orderId`)",
      {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["orderId"] },
      }
    );
    const fake = buildTx(null, { createThrows: p2002 });
    await expect(
      openStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        kind: OrderStageIntervalKind.TYPING_ACTIVE,
        startedAt: AT,
        commandLogId: CMD_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_ALREADY_OPEN });
  });

  it("rethrows non-P2002 Prisma errors unchanged", async () => {
    const otherError = new Prisma.PrismaClientKnownRequestError("Foreign key violation", {
      code: "P2003",
      clientVersion: "test",
    });
    const fake = buildTx(null, { createThrows: otherError });
    await expect(
      openStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        kind: OrderStageIntervalKind.TYPING_ACTIVE,
        startedAt: AT,
        commandLogId: CMD_ID,
      })
    ).rejects.toBe(otherError);
  });
});

describe("closeOpenStageInterval", () => {
  it("closes the open interval", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING });
    await closeOpenStageInterval({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      endedAt: AT,
      commandLogId: CMD_ID,
      expectedKind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
    });
    expect(fake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "open-1", endedAt: null }),
        data: expect.objectContaining({
          endedAt: AT,
          closeCommandLogId: CMD_ID,
        }),
      })
    );
    expect(fake.getOpen()).toBeNull();
  });

  it("rejects when no interval is open", async () => {
    const fake = buildTx(null);
    await expect(
      closeOpenStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        endedAt: AT,
        commandLogId: CMD_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_NONE_OPEN });
  });

  it("rejects kind mismatch", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.TYPING_ACTIVE });
    await expect(
      closeOpenStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        endedAt: AT,
        commandLogId: CMD_ID,
        expectedKind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_KIND_MISMATCH });
  });

  // Negative-duration guard: an `endedAt` before the open row's
  // `startedAt` would silently corrupt SLA aggregates. The primitive
  // must reject the write rather than persist the bad row.
  it("rejects negative duration (endedAt before startedAt)", async () => {
    const futureStartedAt = new Date(AT.getTime() + 60_000); // 1 minute after AT
    const fake = buildTx({
      id: "open-1",
      kind: OrderStageIntervalKind.PV1_ACTIVE,
      startedAt: futureStartedAt,
    });
    await expect(
      closeOpenStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        endedAt: AT,
        commandLogId: CMD_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_NEGATIVE_DURATION });
    expect(fake.updateMany).not.toHaveBeenCalled();
  });

  // Race-lost guard: the updateMany predicate `endedAt: null` turns a
  // concurrent close into count=0 rather than a silent overwrite of
  // the prior writer's `endedAt` / `closeCommandLogId`. The bus row
  // lock makes this unreachable from within the command bus, but a
  // direct caller bypassing the bus would hit it.
  it("rejects when updateMany returns count=0 (concurrent writer won)", async () => {
    const fake = buildTx(
      { id: "open-1", kind: OrderStageIntervalKind.PV1_ACTIVE },
      { updateManyCount: 0 }
    );
    await expect(
      closeOpenStageInterval({
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        endedAt: AT,
        commandLogId: CMD_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_RACE_LOST });
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
  });

  it("zero-duration close (endedAt equals startedAt) is allowed", async () => {
    const fake = buildTx({
      id: "open-1",
      kind: OrderStageIntervalKind.WAIT_BEFORE_PV1,
      startedAt: AT,
    });
    await closeOpenStageInterval({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      endedAt: AT,
      commandLogId: CMD_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("transitionStageIntervals", () => {
  it("closes then opens the next interval", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING });
    await transitionStageIntervals({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      closeKind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
      openKind: OrderStageIntervalKind.TYPING_ACTIVE,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.TYPING_ACTIVE,
          actorUserId: USER_ID,
        }),
      })
    );
  });

  // Regression: actorUserId must never leak onto a WAIT_* row, even
  // when a caller invokes transitionStageIntervals directly. The
  // openStageInterval primitive is the choke point that enforces the
  // schema invariant ("actorUserId populated for ACTIVE intervals").
  it("drops actorUserId when opening a WAIT_* interval", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.TYPING_ACTIVE });
    await transitionStageIntervals({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      closeKind: OrderStageIntervalKind.TYPING_ACTIVE,
      openKind: OrderStageIntervalKind.WAIT_BEFORE_PV1,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.WAIT_BEFORE_PV1,
          actorUserId: null,
        }),
      })
    );
  });

  it("drops actorUserId when openStageInterval is called directly with a WAIT_* kind", async () => {
    const fake = buildTx(null);
    await openStageInterval({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      kind: OrderStageIntervalKind.WAIT_BEFORE_FILL,
      startedAt: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.WAIT_BEFORE_FILL,
          actorUserId: null,
        }),
      })
    );
  });
});

// Pins the "_ACTIVE suffix == user-owned" enum convention to the
// Prisma datamodel by exercising the exported predicate against a
// hand-declared canonical set. If a future enum value owns work but
// breaks the suffix (or vice versa) this fails before the production
// write path silently loses an actor id.
describe("isActiveIntervalKind", () => {
  // Every enum member whose name ends in `_ACTIVE` is in scope —
  // the predicate uses the suffix as its single source of truth.
  // HOLD_ACTIVE is included: while a held order is not consuming its
  // stage SLA budget, the PlaceHold command DOES stamp an actor on
  // the row, so the predicate must classify it as user-owned.
  const ACTIVE_KINDS: ReadonlySet<OrderStageIntervalKind> = new Set([
    OrderStageIntervalKind.TYPING_ACTIVE,
    OrderStageIntervalKind.PV1_ACTIVE,
    OrderStageIntervalKind.FILL_ACTIVE,
    OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
    OrderStageIntervalKind.SHIPPING_ACTIVE,
    OrderStageIntervalKind.HOLD_ACTIVE,
  ]);

  it("returns the canonical user-owned membership for every enum member", () => {
    for (const value of Object.values(OrderStageIntervalKind)) {
      expect(isActiveIntervalKind(value), `enum value ${String(value)}`).toBe(
        ACTIVE_KINDS.has(value)
      );
    }
  });
});

describe("applyCommandStageIntervalTransition", () => {
  it("routes ConfirmShipment through the close-only table", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.SHIPPING_ACTIVE });
    await applyCommandStageIntervalTransition({
      commandName: "ConfirmShipment",
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endedAt: AT,
          closeCommandLogId: CMD_ID,
        }),
      })
    );
    expect(fake.create).not.toHaveBeenCalled();
  });

  // CancelOrder is multi-from-state (RECEIVED, TYPING_*, PV1_*,
  // FILL_*, FINAL_*, READY_TO_SHIP, ON_HOLD, …) — the open kind
  // varies per source, so the close-only entry omits `close` and
  // runs without an `expectedKind` assertion. Two regressions to
  // pin: (i) the close fires regardless of what's open, and (ii)
  // a stage-kind that would FAIL ConfirmShipment's strict
  // assertion passes for CancelOrder.
  it.each([
    OrderStageIntervalKind.WAIT_BEFORE_TYPING,
    OrderStageIntervalKind.TYPING_ACTIVE,
    OrderStageIntervalKind.PV1_ACTIVE,
    OrderStageIntervalKind.FILL_ACTIVE,
    OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
    OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
  ])("routes CancelOrder through close-only regardless of open kind (%s)", async (openKind) => {
    const fake = buildTx({ id: "open-1", kind: openKind });
    await applyCommandStageIntervalTransition({
      commandName: "CancelOrder",
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endedAt: AT,
          closeCommandLogId: CMD_ID,
        }),
      })
    );
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("routes StartTyping through the transition table and stamps the actor on the ACTIVE row", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING });
    await applyCommandStageIntervalTransition({
      commandName: "StartTyping",
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.TYPING_ACTIVE,
          actorUserId: USER_ID,
        }),
      })
    );
  });

  // PlaceHold is multi-from-state (reachable from every active,
  // non-hold, non-terminal status) so the transition table entry
  // omits `close`. The mechanics differ from `CancelOrder`'s
  // close-only treatment because PlaceHold ALSO opens a successor
  // (HOLD_ACTIVE), and from `CompleteFill`'s strict close because
  // the source kind varies. Two regressions pinned here: the
  // close runs against any open kind, and the successor opens
  // with the placer as actor on the ACTIVE row.
  it.each([
    OrderStageIntervalKind.WAIT_BEFORE_TYPING,
    OrderStageIntervalKind.TYPING_ACTIVE,
    OrderStageIntervalKind.WAIT_BEFORE_PV1,
    OrderStageIntervalKind.PV1_ACTIVE,
    OrderStageIntervalKind.WAIT_AFTER_PV1_REJECT,
    OrderStageIntervalKind.FILL_ACTIVE,
    OrderStageIntervalKind.WAIT_AFTER_FINAL_REJECT,
    OrderStageIntervalKind.SHIPPING_ACTIVE,
  ])("PlaceHold closes any open kind (%s) and opens HOLD_ACTIVE", async (openKind) => {
    const fake = buildTx({ id: "open-1", kind: openKind });
    await applyCommandStageIntervalTransition({
      commandName: "PlaceHold",
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.HOLD_ACTIVE,
          actorUserId: USER_ID,
        }),
      })
    );
  });

  it("RejectPV1 closes PV1_ACTIVE and opens WAIT_AFTER_PV1_REJECT without actor on the wait row", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.PV1_ACTIVE });
    await applyCommandStageIntervalTransition({
      commandName: "RejectPV1",
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.WAIT_AFTER_PV1_REJECT,
          // WAIT_* invariant: SLA primitive coerces actor to null
          // regardless of what the caller passes.
          actorUserId: null,
        }),
      })
    );
  });

  it("RejectFinalVerification closes FINAL_VERIFICATION_ACTIVE and opens WAIT_AFTER_FINAL_REJECT without actor", async () => {
    const fake = buildTx({
      id: "open-1",
      kind: OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
    });
    await applyCommandStageIntervalTransition({
      commandName: "RejectFinalVerification",
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      at: AT,
      commandLogId: CMD_ID,
      actorUserId: USER_ID,
    });
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: OrderStageIntervalKind.WAIT_AFTER_FINAL_REJECT,
          actorUserId: null,
        }),
      })
    );
  });

  it("RejectPV1 fails loud when the source interval is not PV1_ACTIVE (single-from-state contract)", async () => {
    // The static transition table asserts the close kind. A stale
    // open row with the wrong kind (eg. WAIT_BEFORE_PV1) must
    // surface as SLA_INTERVAL_KIND_MISMATCH so the operator
    // investigates the inconsistency instead of silently writing
    // an unrelated close.
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.WAIT_BEFORE_PV1 });
    await expect(
      applyCommandStageIntervalTransition({
        commandName: "RejectPV1",
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        at: AT,
        commandLogId: CMD_ID,
        actorUserId: USER_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_KIND_MISMATCH });
    expect(fake.create).not.toHaveBeenCalled();
  });

  // v1 contract: every bus command that mutates an order has an
  // explicit SLA decision in one of the two static tables OR
  // makes a handler-direct call (ReleaseHold + ReopenForCorrection
  // — their open kind is parameterized). Nothing routes through
  // the no-op set today. A future command that genuinely has zero
  // SLA effect may be added here, but it MUST land with a comment
  // explaining the rationale.
  it("KNOWN_NON_SLA_COMMANDS is empty (every command has a deliberate SLA decision)", () => {
    expect(Array.from(KNOWN_NON_SLA_COMMANDS)).toEqual([]);
  });

  it("is a deliberate no-op for commands in KNOWN_NON_SLA_COMMANDS", async () => {
    // The set is empty in v1 (asserted above) — this test stays
    // wired so that the moment a future maintainer adds an entry
    // to KNOWN_NON_SLA_COMMANDS, the no-op behavior is regression-
    // covered. If KNOWN_NON_SLA_COMMANDS is empty, the loop is a
    // trivially-passing no-op.
    for (const commandName of KNOWN_NON_SLA_COMMANDS) {
      const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.PV1_ACTIVE });
      await applyCommandStageIntervalTransition({
        commandName,
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        at: AT,
        commandLogId: CMD_ID,
        actorUserId: USER_ID,
      });
      expect(fake.create, `${commandName} must not create`).not.toHaveBeenCalled();
      expect(fake.updateMany, `${commandName} must not updateMany`).not.toHaveBeenCalled();
    }
  });

  // Regression: silent no-op on unknown command names hides typos and
  // hides every new order-mutating command that forgot to declare its
  // SLA semantics. Fail loudly instead.
  it("throws SLA_INTERVAL_COMMAND_UNMAPPED for an unrecognized command name", async () => {
    const fake = buildTx({ id: "open-1", kind: OrderStageIntervalKind.TYPING_ACTIVE });
    await expect(
      applyCommandStageIntervalTransition({
        commandName: "CompletFill", // intentional typo
        tx: fake.tx as never,
        organizationId: ORG_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        at: AT,
        commandLogId: CMD_ID,
        actorUserId: USER_ID,
      })
    ).rejects.toMatchObject({ code: SLA_INTERVAL_COMMAND_UNMAPPED });
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.updateMany).not.toHaveBeenCalled();
  });

  // The three command-name registries must be disjoint so a single
  // command name has exactly one canonical SLA treatment.
  it("transition / close-only / non-SLA registries are disjoint", async () => {
    const { COMMAND_STAGE_INTERVAL_TRANSITION, COMMAND_STAGE_INTERVAL_CLOSE_ONLY } =
      await import("./interval-recorder.js");
    const transition = new Set(Object.keys(COMMAND_STAGE_INTERVAL_TRANSITION));
    const closeOnly = new Set(Object.keys(COMMAND_STAGE_INTERVAL_CLOSE_ONLY));
    const nonSla = KNOWN_NON_SLA_COMMANDS;
    for (const name of transition) {
      expect(closeOnly.has(name), `${name} appears in both transition and close-only`).toBe(false);
      expect(nonSla.has(name), `${name} appears in both transition and non-SLA`).toBe(false);
    }
    for (const name of closeOnly) {
      expect(nonSla.has(name), `${name} appears in both close-only and non-SLA`).toBe(false);
    }
  });
});

describe("openInitialWaitBeforeTyping", () => {
  it("opens WAIT_BEFORE_TYPING", async () => {
    const fake = buildTx(null);
    await openInitialWaitBeforeTyping({
      tx: fake.tx as never,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      startedAt: AT,
      commandLogId: CMD_ID,
    });
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING }),
      })
    );
  });
});
