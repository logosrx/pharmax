// SoD in-tx helper contract.
//
// What this test pins:
//   - The translator-based history projection skips events whose
//     eventType does not map to a permission, and skips events
//     with a null actorUserId. These are NEVER counted as "acts"
//     against SoD.
//   - The bus passes the active actor's userId, organizationId,
//     and correlationId through to the rbac SoD evaluator — the
//     resulting AuthorizationError(SOD_VIOLATION) metadata carries
//     all three so the audit row can correlate without PHI.
//   - The orderEvent read selects ONLY non-PHI columns. We assert
//     this on the args recorded by the fake — `payload` (which may
//     contain PHI snapshots) must NEVER appear in the `select`.
//   - No tenancy context = `requireCurrentContext` throws
//     AuthorizationError(TENANCY_NO_CONTEXT). The helper is unsafe
//     to call outside a withTenancyContext block.

import { describe, expect, it, vi } from "vitest";

import { errors } from "@pharmax/platform-core";
import { PERMISSIONS, SOD_VIOLATION, type PermissionCode } from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  buildEventTypeTranslator,
  loadOrderResourceHistory,
  requireNoSoDViolationForOrder,
  type EventTypeToPermission,
} from "./sod.js";

interface FakeOrderEventRow {
  eventType: string;
  actorUserId: string | null;
  sequenceNumber: number;
}

interface FakeOrderTx {
  readonly findManyArgs: unknown[];
  readonly tx: {
    orderEvent: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };
}

function buildFakeOrderTx(rows: FakeOrderEventRow[]): FakeOrderTx {
  const findManyArgs: unknown[] = [];
  const findMany = vi.fn(async (args: unknown) => {
    findManyArgs.push(args);
    return rows;
  });
  return {
    findManyArgs,
    tx: {
      orderEvent: { findMany },
    },
  };
}

const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACTOR_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function ctxFor(userId: string): TenancyContext {
  return buildTenancyContext({
    organizationId: "org-1",
    actor: { userId, correlationId: "01CORRELATION0000000000000" },
  });
}

const ORDER_EVENT_TO_PERMISSION: Readonly<Record<string, PermissionCode>> = {
  "typing.completed": PERMISSIONS.TYPING_COMPLETE,
  "pv1.approved": PERMISSIONS.PV1_APPROVE,
  "fill.completed": PERMISSIONS.FILL_COMPLETE,
  "final.approved": PERMISSIONS.FINAL_APPROVE,
};

const sampleTranslator: EventTypeToPermission = buildEventTypeTranslator(ORDER_EVENT_TO_PERMISSION);

describe("buildEventTypeTranslator", () => {
  it("returns the mapped permission for known event types", () => {
    expect(sampleTranslator("pv1.approved")).toBe(PERMISSIONS.PV1_APPROVE);
    expect(sampleTranslator("fill.completed")).toBe(PERMISSIONS.FILL_COMPLETE);
  });

  it("returns null for unknown event types", () => {
    expect(sampleTranslator("order.note.added")).toBeNull();
    expect(sampleTranslator("")).toBeNull();
  });
});

describe("loadOrderResourceHistory", () => {
  it("projects events into ResourceActs in sequence order", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "typing.completed", actorUserId: ACTOR_A, sequenceNumber: 1 },
      { eventType: "pv1.approved", actorUserId: ACTOR_B, sequenceNumber: 2 },
    ]);

    const acts = await loadOrderResourceHistory(
      { tx: tx as never, orderId: ORDER_ID },
      sampleTranslator
    );

    expect(acts).toEqual([
      {
        permission: PERMISSIONS.TYPING_COMPLETE,
        actorUserId: ACTOR_A,
        atSequence: "1",
      },
      {
        permission: PERMISSIONS.PV1_APPROVE,
        actorUserId: ACTOR_B,
        atSequence: "2",
      },
    ]);
  });

  it("skips events whose eventType the translator returns null for", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "order.note.added", actorUserId: ACTOR_A, sequenceNumber: 1 },
      { eventType: "pv1.approved", actorUserId: ACTOR_A, sequenceNumber: 2 },
    ]);

    const acts = await loadOrderResourceHistory(
      { tx: tx as never, orderId: ORDER_ID },
      sampleTranslator
    );

    expect(acts).toHaveLength(1);
    expect(acts[0]?.permission).toBe(PERMISSIONS.PV1_APPROVE);
  });

  it("skips events with null actorUserId (system-emitted)", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "pv1.approved", actorUserId: null, sequenceNumber: 1 },
      { eventType: "pv1.approved", actorUserId: ACTOR_A, sequenceNumber: 2 },
    ]);

    const acts = await loadOrderResourceHistory(
      { tx: tx as never, orderId: ORDER_ID },
      sampleTranslator
    );

    expect(acts).toHaveLength(1);
    expect(acts[0]?.actorUserId).toBe(ACTOR_A);
  });

  it("selects only non-PHI columns (never reads payload)", async () => {
    const fake = buildFakeOrderTx([]);
    await loadOrderResourceHistory({ tx: fake.tx as never, orderId: ORDER_ID }, sampleTranslator);

    expect(fake.findManyArgs).toHaveLength(1);
    const args = fake.findManyArgs[0] as {
      where: { orderId: string };
      orderBy: { sequenceNumber: "asc" };
      select: Record<string, boolean>;
    };
    expect(args.where).toEqual({ orderId: ORDER_ID });
    expect(args.orderBy).toEqual({ sequenceNumber: "asc" });
    expect(args.select).toEqual({
      eventType: true,
      actorUserId: true,
      sequenceNumber: true,
    });
    expect(args.select).not.toHaveProperty("payload");
  });

  it("returns an empty array when there is no history", async () => {
    const { tx } = buildFakeOrderTx([]);
    const acts = await loadOrderResourceHistory(
      { tx: tx as never, orderId: ORDER_ID },
      sampleTranslator
    );
    expect(acts).toEqual([]);
  });
});

describe("requireNoSoDViolationForOrder", () => {
  it("returns silently when no prior acts collide", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "typing.completed", actorUserId: ACTOR_A, sequenceNumber: 1 },
    ]);

    await withTenancyContext(ctxFor(ACTOR_B), async () => {
      await expect(
        requireNoSoDViolationForOrder({
          tx: tx as never,
          orderId: ORDER_ID,
          attempted: PERMISSIONS.PV1_APPROVE,
          translate: sampleTranslator,
        })
      ).resolves.toBeUndefined();
    });
  });

  it("returns silently when the attempted permission has no SoD rule", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "typing.completed", actorUserId: ACTOR_A, sequenceNumber: 1 },
    ]);

    await withTenancyContext(ctxFor(ACTOR_A), async () => {
      await expect(
        requireNoSoDViolationForOrder({
          tx: tx as never,
          orderId: ORDER_ID,
          attempted: PERMISSIONS.ORDERS_READ,
          translate: sampleTranslator,
        })
      ).resolves.toBeUndefined();
    });
  });

  it("throws SOD_VIOLATION when the same actor attempts a forbidden follow-up", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "pv1.approved", actorUserId: ACTOR_A, sequenceNumber: 1 },
    ]);

    await withTenancyContext(ctxFor(ACTOR_A), async () => {
      const promise = requireNoSoDViolationForOrder({
        tx: tx as never,
        orderId: ORDER_ID,
        attempted: PERMISSIONS.FINAL_APPROVE,
        translate: sampleTranslator,
      });

      await expect(promise).rejects.toBeInstanceOf(errors.AuthorizationError);
      await expect(promise).rejects.toMatchObject({
        code: SOD_VIOLATION,
        httpStatus: 403,
        metadata: {
          attemptedPermission: PERMISSIONS.FINAL_APPROVE,
          collidingPriorAct: PERMISSIONS.PV1_APPROVE,
          resourceRef: `order:${ORDER_ID}`,
          actorUserId: ACTOR_A,
          organizationId: "org-1",
          correlationId: "01CORRELATION0000000000000",
          priorActSequence: "1",
        },
      });
    });
  });

  it("does not violate when the prior act was by a different actor", async () => {
    const { tx } = buildFakeOrderTx([
      { eventType: "pv1.approved", actorUserId: ACTOR_A, sequenceNumber: 1 },
    ]);

    await withTenancyContext(ctxFor(ACTOR_B), async () => {
      await expect(
        requireNoSoDViolationForOrder({
          tx: tx as never,
          orderId: ORDER_ID,
          attempted: PERMISSIONS.FINAL_APPROVE,
          translate: sampleTranslator,
        })
      ).resolves.toBeUndefined();
    });
  });

  it("throws TENANCY_NO_CONTEXT when called outside a tenancy frame", async () => {
    const { tx } = buildFakeOrderTx([]);
    await expect(
      requireNoSoDViolationForOrder({
        tx: tx as never,
        orderId: ORDER_ID,
        attempted: PERMISSIONS.FINAL_APPROVE,
        translate: sampleTranslator,
      })
    ).rejects.toMatchObject({
      code: "TENANCY_NO_CONTEXT",
      httpStatus: 403,
    });
  });
});
