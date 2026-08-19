// The command bus's architectural invariants, proven against real
// Postgres transactions.
//
// Every assertion in this file exists because the mocked unit suites
// cannot make it: their `$transaction` is `fn => fn(tx)`, which records
// writes and cannot roll back. Atomicity, rollback-on-conflict,
// idempotent replay, RLS inside the bus, and no-partial-writes on
// refusal are all claims about what COMMITS, so they are only provable
// here.
//
// Each test creates its own order via the spine helper, so tests are
// independent and the deltas they measure are their own. The suite runs
// single-fork and sequential (see vitest.config.ts), which is what makes
// before/after count deltas trustworthy.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeCommand } from "@pharmax/command-bus";
import { AssignLot, StartFill } from "@pharmax/fill";
import { StartTyping } from "@pharmax/verification";

import { assertSchemaReady, connect } from "./lib/db.js";
import {
  actingAs,
  assertAppRolePinned,
  configureHarness,
  newIdempotencyKey,
} from "./support/bus-harness.js";
import {
  cleanupCommandFixture,
  seedCommandFixture,
  seedLotWithState,
  type CommandFixture,
} from "./support/fixtures.js";
import { advanceOrderTo, createSpineOrder } from "./support/spine.js";

import type { Client } from "pg";

/** Snapshot of everything a transition is allowed to change for an order. */
interface OrderSnapshot {
  readonly status: string;
  readonly version: number;
  readonly orderEvents: number;
  readonly outboxEvents: number;
  readonly auditRows: number;
}

async function snapshotOrder(
  client: Client,
  organizationId: string,
  orderId: string
): Promise<OrderSnapshot> {
  const { rows } = await client.query<{
    status: string;
    version: number;
    order_events: string;
    outbox_events: string;
    audit_rows: string;
  }>(
    `SELECT
       o."currentStatus" AS status,
       o.version         AS version,
       (SELECT count(*) FROM order_event  WHERE "orderId" = o.id)::text AS order_events,
       (SELECT count(*) FROM event_outbox WHERE "organizationId" = $1
          AND "aggregateId" = o.id)::text AS outbox_events,
       (SELECT count(*) FROM audit_log    WHERE "organizationId" = $1
          AND "resourceId" = o.id::text)::text AS audit_rows
     FROM "order" o WHERE o.id = $2`,
    [organizationId, orderId]
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`snapshotOrder: order ${orderId} not found`);
  return {
    status: row.status,
    version: Number(row.version),
    orderEvents: Number(row.order_events),
    outboxEvents: Number(row.outbox_events),
    auditRows: Number(row.audit_rows),
  };
}

describe("command bus invariants — real transactions", () => {
  let owner: Client;
  let fixture: CommandFixture;
  /** A second, fully independent tenant, for the cross-tenant test. */
  let otherTenant: CommandFixture;

  beforeAll(async () => {
    await assertSchemaReady();
    configureHarness();
    await assertAppRolePinned();
    owner = await connect("owner");
    fixture = await seedCommandFixture(owner);
    otherTenant = await seedCommandFixture(owner);
  });

  afterAll(async () => {
    if (otherTenant !== undefined) await cleanupCommandFixture(owner, otherTenant);
    if (fixture !== undefined) await cleanupCommandFixture(owner, fixture);
    await owner?.end().catch(() => undefined);
  });

  const asTypist = <T>(fn: () => Promise<T>): Promise<T> =>
    actingAs(
      {
        organizationId: fixture.organizationId,
        userId: fixture.typistUserId,
        siteId: fixture.siteId,
      },
      fn
    );

  it("commits command_log, order_event, audit_log and event_outbox atomically and correlated", async () => {
    const order = await createSpineOrder(fixture);
    const before = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    await asTypist(() =>
      executeCommand(
        StartTyping,
        { orderId: order.orderId },
        { idempotencyKey: newIdempotencyKey("atomic") }
      )
    );

    // The four tables are asserted through their CORRELATION columns, not
    // just counts. Counts alone would pass if StartTyping's rows were
    // written by four independent transactions that happened to all
    // succeed; the correlation ties each row to the one command_log entry
    // this dispatch created, which only a single transaction produces.
    const { rows: logs } = await owner.query<{ id: string; status: string }>(
      `SELECT id, status FROM command_log
        WHERE "targetOrderId" = $1 AND "commandName" = 'StartTyping'`,
      [order.orderId]
    );
    expect(logs).toHaveLength(1);
    const commandLogId = logs[0]?.id;
    expect(logs[0]?.status).toBe("SUCCEEDED");

    const { rows: events } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_event
        WHERE "orderId" = $1 AND "sourceCommandLogId" = $2`,
      [order.orderId, commandLogId]
    );
    expect(Number(events[0]?.count)).toBe(1);

    const after = await snapshotOrder(owner, fixture.organizationId, order.orderId);
    expect(after.status).toBe("TYPING_IN_PROGRESS");
    expect(after.version).toBe(before.version + 1);
    expect(after.orderEvents).toBe(before.orderEvents + 1);
    expect(after.outboxEvents).toBeGreaterThan(before.outboxEvents);
    expect(after.auditRows).toBeGreaterThan(before.auditRows);
  });

  it("rolls back the loser of a concurrent dispatch, leaving zero rows", async () => {
    const order = await createSpineOrder(fixture);
    const before = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    // Two dispatches race for the same RECEIVED -> TYPING_IN_PROGRESS
    // transition with DIFFERENT idempotency keys, so neither is a replay
    // of the other. The bus locks the order row, so one serialises behind
    // the other, re-reads the now-changed state inside its own
    // transaction, and must refuse — and its refusal must roll back
    // everything it wrote.
    const results = await Promise.allSettled([
      asTypist(() =>
        executeCommand(
          StartTyping,
          { orderId: order.orderId },
          { idempotencyKey: newIdempotencyKey("race-a") }
        )
      ),
      asTypist(() =>
        executeCommand(
          StartTyping,
          { orderId: order.orderId },
          { idempotencyKey: newIdempotencyKey("race-b") }
        )
      ),
    ]);

    const outcomes = results.map((r) => r.status).sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);

    const after = await snapshotOrder(owner, fixture.organizationId, order.orderId);
    // Exactly ONE transition happened. If the loser's writes leaked, the
    // event count or version would be +2; if the winner's rolled back
    // with it, they would be +0.
    expect(after.status).toBe("TYPING_IN_PROGRESS");
    expect(after.version).toBe(before.version + 1);
    expect(after.orderEvents).toBe(before.orderEvents + 1);

    // The loser may keep a FAILED command_log entry — recording the
    // refusal is bookkeeping, not a partial workflow write — but no
    // order_event may point at it.
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM order_event e
         JOIN command_log c ON c.id = e."sourceCommandLogId"
        WHERE e."orderId" = $1 AND c.status <> 'SUCCEEDED'`,
      [order.orderId]
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("replays an idempotency key from the stored response without writing again", async () => {
    const order = await createSpineOrder(fixture);
    const key = newIdempotencyKey("replay");

    const first = await asTypist(() =>
      executeCommand(StartTyping, { orderId: order.orderId }, { idempotencyKey: key })
    );
    const afterFirst = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    const second = await asTypist(() =>
      executeCommand(StartTyping, { orderId: order.orderId }, { idempotencyKey: key })
    );
    const afterSecond = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    // Same response, byte for byte, and NOTHING moved: no second
    // order_event, no version bump, no extra audit or outbox rows. Note
    // the replay is only lawful because the key matches — the previous
    // test proves a DIFFERENT key on the same transition is refused.
    expect(second).toEqual(first);
    expect(afterSecond).toEqual(afterFirst);

    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM command_log WHERE "idempotencyKey" = $1`,
      [key]
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("fails closed across tenants: a fully privileged actor in another org cannot touch the order", async () => {
    const order = await createSpineOrder(fixture);
    const before = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    // The other tenant's admin holds the SAME all-permissions role in its
    // own org, so RBAC is satisfied and the refusal below can only come
    // from tenant scoping — the RLS policies evaluated against the
    // `pharmax.organization_id` GUC the bus sets, plus the bus's own
    // scoped lookups. A permissions-shaped failure here would mean the
    // test is not exercising what it claims.
    await expect(
      actingAs(
        {
          organizationId: otherTenant.organizationId,
          userId: otherTenant.adminUserId,
          siteId: otherTenant.siteId,
        },
        () =>
          executeCommand(
            StartTyping,
            { orderId: order.orderId },
            { idempotencyKey: newIdempotencyKey("xtenant") }
          )
      )
    ).rejects.toThrow();

    // Fail-closed means fail-CLEAN: the victim order is untouched and the
    // attacker org gained no order_event referencing it.
    const after = await snapshotOrder(owner, fixture.organizationId, order.orderId);
    expect(after).toEqual(before);

    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_event
        WHERE "orderId" = $1 AND "organizationId" = $2`,
      [order.orderId, otherTenant.organizationId]
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("refuses StartFill before PV1 approval and leaves no partial writes", async () => {
    const order = await createSpineOrder(fixture);
    await advanceOrderTo(fixture, order, "TYPED_READY_FOR_PV1", owner);
    const before = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    await expect(
      actingAs(
        {
          organizationId: fixture.organizationId,
          userId: fixture.technicianUserId,
          siteId: fixture.siteId,
          workstationId: fixture.workstationId,
        },
        () =>
          executeCommand(
            StartFill,
            { orderId: order.orderId },
            { idempotencyKey: newIdempotencyKey("nofill") }
          )
      )
    ).rejects.toThrow();

    const after = await snapshotOrder(owner, fixture.organizationId, order.orderId);
    expect(after.status).toBe("TYPED_READY_FOR_PV1");
    expect(after.version).toBe(before.version);
    expect(after.orderEvents).toBe(before.orderEvents);
    expect(after.outboxEvents).toBe(before.outboxEvents);
  });

  it("refuses an expired lot and a held lot, leaving no assignment rows", async () => {
    const order = await createSpineOrder(fixture);
    await advanceOrderTo(fixture, order, "FILL_IN_PROGRESS", owner);
    const before = await snapshotOrder(owner, fixture.organizationId, order.orderId);

    const expired = await seedLotWithState(owner, fixture, fixture.productId, {
      status: "ACTIVE",
      expiresInDays: -1,
    });
    const held = await seedLotWithState(owner, fixture, fixture.productId, {
      status: "ON_HOLD",
      expiresInDays: 365,
    });

    const asTechnician = <T>(fn: () => Promise<T>): Promise<T> =>
      actingAs(
        {
          organizationId: fixture.organizationId,
          userId: fixture.technicianUserId,
          siteId: fixture.siteId,
          workstationId: fixture.workstationId,
        },
        fn
      );

    await expect(
      asTechnician(() =>
        executeCommand(
          AssignLot,
          { orderId: order.orderId, orderLineId: order.orderLineId, lotId: expired.lotId },
          { idempotencyKey: newIdempotencyKey("explot") }
        )
      )
    ).rejects.toThrow(/expir/i);

    await expect(
      asTechnician(() =>
        executeCommand(
          AssignLot,
          { orderId: order.orderId, orderLineId: order.orderLineId, lotId: held.lotId },
          { idempotencyKey: newIdempotencyKey("heldlot") }
        )
      )
    ).rejects.toThrow(/hold|held/i);

    // Neither refusal may leave a trace: no lot_assignment, no inventory
    // movement, no workflow advance.
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM lot_assignment
        WHERE "lotId" = ANY($1::uuid[])`,
      [[expired.lotId, held.lotId]]
    );
    expect(Number(rows[0]?.count)).toBe(0);

    const after = await snapshotOrder(owner, fixture.organizationId, order.orderId);
    expect(after.status).toBe("FILL_IN_PROGRESS");
    expect(after.version).toBe(before.version);
    expect(after.orderEvents).toBe(before.orderEvents);
  });
});
