// DeleteBucket contract tests.
//
// Two refusals carry the whole design, because deletion here is HARD
// (the bucket model has no archive column and the schema is frozen):
//
//   1. System buckets are never deletable. The workflow engine resolves
//      them by code on every stage transition, so removing one halts
//      intake for the org rather than degrading it.
//   2. A bucket holding orders is never deletable. `Order.currentBucketId`
//      is non-nullable with `onDelete: Restrict`, so the database would
//      refuse anyway — this check exists so the operator gets an
//      actionable count instead of a raw foreign-key violation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { BucketKind, RoleScope, WorkflowPolicyOverlayStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  DeleteBucket,
  DELETE_BUCKET_HAS_ORDERS,
  DELETE_BUCKET_HAS_ROUTING_OVERRIDE,
  DELETE_BUCKET_IS_SYSTEM,
  DELETE_BUCKET_NOT_FOUND,
} from "./delete-bucket.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const BUCKET_ID = "00000000-0000-4000-8000-0000000000b1";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORG_MANAGE_BUCKETS]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface ExistingBucket {
  id: string;
  code: string;
  name: string;
  kind: BucketKind;
  isSystem: boolean;
}

const CUSTOM_BUCKET: ExistingBucket = {
  id: BUCKET_ID,
  code: "PRIOR_AUTH",
  name: "Prior Authorization",
  kind: BucketKind.HOLD,
  isSystem: false,
};

/**
 * A `workflow_policy_overlay` row as the route-reference guard reads
 * it. `overlayJson` is deliberately typed `unknown`: it is a `Json`
 * column and the guard has to tolerate whatever is in it.
 */
interface OverlayRow {
  id: string;
  clinicId: string | null;
  status: WorkflowPolicyOverlayStatus;
  overlayJson: unknown;
}

function buildPrismaFake(input: {
  existing?: ExistingBucket | null;
  orderCount?: number;
  /** Overlay rows in this org, of any status. */
  overlays?: ReadonlyArray<OverlayRow>;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  const tx = {
    workflowPolicyOverlay: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicyOverlay", op: "findMany", args });
        const where = (args as { where: Record<string, unknown> }).where;
        return (input.overlays ?? []).filter(
          (overlay) => where["organizationId"] === ORG_ID && overlay.status === where["status"]
        );
      }),
    },
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return input.existing === undefined ? CUSTOM_BUCKET : input.existing;
      }),
      delete: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "delete", args });
        return { id: BUCKET_ID };
      }),
    },
    order: {
      count: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "count", args });
        return input.orderCount ?? 0;
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        auditRows.push((args as { data: Record<string, unknown> }).data);
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        const data = (args as { data: Array<Record<string, unknown>> }).data;
        outboxRows.push(...data);
        return { count: data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls, tx, outboxRows, auditRows };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-15T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_USER_ID, grants },
    ]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("DeleteBucket — happy path", () => {
  it("deletes an empty custom bucket", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 0 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-1" })
    );

    expect(out.bucketId).toBe(BUCKET_ID);
    expect(out.code).toBe("PRIOR_AUTH");
    expect(fake.tx.bucket.delete).toHaveBeenCalled();
  });

  it("writes the audit row and outbox event with a full attribute snapshot", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-2" })
    );

    // The row is gone, so the audit + event ARE the surviving record.
    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.bucket.deleted");
    expect(audit?.["resourceId"]).toBe(BUCKET_ID);

    const event = fake.outboxRows.find((r) => r["eventType"] === "org.bucket.deleted.v1");
    expect(event).toBeDefined();
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["code"]).toBe("PRIOR_AUTH");
    expect(payload["name"]).toBe("Prior Authorization");
    expect(payload["kind"]).toBe(BucketKind.HOLD);
  });
});

describe("DeleteBucket — system bucket protection", () => {
  // Every seeded bucket, because each one is resolved by code by at
  // least one workflow handler (EMERGENCY additionally by the SLA
  // breach evaluator).
  const systemCodes = ["INBOX", "TYPING", "PV1", "FILL", "FINAL", "SHIPPING", "EMERGENCY"];

  for (const code of systemCodes) {
    it(`refuses to delete the system bucket ${code}`, async () => {
      const fake = buildPrismaFake({
        existing: {
          id: BUCKET_ID,
          code,
          name: code,
          kind: code === "EMERGENCY" ? BucketKind.EMERGENCY : BucketKind.WORKFLOW,
          isSystem: true,
        },
        orderCount: 0,
      });
      configureBus(fake.client);

      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(
            DeleteBucket,
            { bucketId: BUCKET_ID },
            { idempotencyKey: `db-sys-${code}` }
          )
        )
      ).rejects.toMatchObject({ code: DELETE_BUCKET_IS_SYSTEM });
      expect(fake.tx.bucket.delete).not.toHaveBeenCalled();
      resetCommandBusConfigurationForTests();
    });
  }

  it("refuses a system bucket even when it holds zero orders", async () => {
    const fake = buildPrismaFake({
      existing: { ...CUSTOM_BUCKET, isSystem: true },
      orderCount: 0,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-3" })
      )
    ).rejects.toMatchObject({ code: DELETE_BUCKET_IS_SYSTEM });
  });
});

describe("DeleteBucket — referencing orders", () => {
  it("refuses to delete a bucket that still holds orders", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 42 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-4" })
      )
    ).rejects.toMatchObject({ code: DELETE_BUCKET_HAS_ORDERS });
    expect(fake.tx.bucket.delete).not.toHaveBeenCalled();
  });

  it("refuses even for a single referencing order", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 1 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-5" })
      )
    ).rejects.toMatchObject({ code: DELETE_BUCKET_HAS_ORDERS });
    expect(fake.tx.bucket.delete).not.toHaveBeenCalled();
  });

  it("surfaces the order count so the operator knows how much to move", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 7 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-6" })
      )
    ).rejects.toMatchObject({
      code: DELETE_BUCKET_HAS_ORDERS,
      metadata: { orderCount: 7 },
    });
  });

  it("counts orders scoped to the actor's organization and this bucket only", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-7" })
    );

    const count = fake.calls.find((c) => c.table === "order" && c.op === "count");
    const where = (count!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
    expect(where["currentBucketId"]).toBe(BUCKET_ID);
  });
});

describe("DeleteBucket — tenancy and RBAC", () => {
  it("treats a bucket outside the actor's organization as not found", async () => {
    const fake = buildPrismaFake({ existing: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-8" })
      )
    ).rejects.toMatchObject({ code: DELETE_BUCKET_NOT_FOUND });
    expect(fake.tx.order.count).not.toHaveBeenCalled();
  });

  it("scopes the bucket lookup by organizationId", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-9" })
    );

    const find = fake.calls.find((c) => c.table === "bucket" && c.op === "findFirst");
    const where = (find!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
  });

  it("denies actors without org.manage_buckets", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.ORG_MANAGE_SITES]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 0 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-10" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.bucket.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Guard 3: routing overrides
// ---------------------------------------------------------------------
//
// The interaction this closes: `Order.currentBucketId` is an FK, so
// guard 2 is backed by the database. A routing override is a bucket
// CODE inside `workflow_policy_overlay.overlayJson`, a `Json` column
// with no FK — so an EMPTY custom bucket (guard 2 silent) could be
// deleted out from under a live route, and PV1 rejections would quietly
// stop arriving in the rework queue.

const OVERLAY_ID = "00000000-0000-4000-8000-0000000000e1";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c1";

function overlayRouting(
  routes: Record<string, unknown>,
  overrides: Partial<OverlayRow> = {}
): OverlayRow {
  return {
    id: OVERLAY_ID,
    clinicId: null,
    status: WorkflowPolicyOverlayStatus.ACTIVE,
    overlayJson: { routeStatesToBucketCodes: routes },
    ...overrides,
  };
}

describe("DeleteBucket — routing overrides", () => {
  it("refuses to delete an EMPTY bucket that an ACTIVE overlay routes a stage to", async () => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [overlayRouting({ PV1_REJECTED: "PRIOR_AUTH" })],
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r1" })
      )
    ).rejects.toMatchObject({
      code: DELETE_BUCKET_HAS_ROUTING_OVERRIDE,
      metadata: { routedStates: ["PV1_REJECTED"], overlayIds: [OVERLAY_ID] },
    });
    expect(fake.tx.bucket.delete).not.toHaveBeenCalled();
  });

  it("names every routed stage so the operator knows what to re-point", async () => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [
        overlayRouting({ PV1_REJECTED: "PRIOR_AUTH", FINAL_VERIFICATION_REJECTED: "PRIOR_AUTH" }),
      ],
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r2" })
      )
    ).rejects.toMatchObject({
      code: DELETE_BUCKET_HAS_ROUTING_OVERRIDE,
      metadata: { routedStates: ["PV1_REJECTED", "FINAL_VERIFICATION_REJECTED"] },
    });
  });

  it("refuses when the route lives on a CLINIC-scoped overlay, not just an org-wide one", async () => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [overlayRouting({ RECEIVED: "PRIOR_AUTH" }, { clinicId: CLINIC_ID })],
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r3" })
      )
    ).rejects.toMatchObject({ code: DELETE_BUCKET_HAS_ROUTING_OVERRIDE });
  });

  it("allows the delete when only a SUPERSEDED overlay routed to the bucket", async () => {
    // Superseded rows are history — they are what makes a historical
    // replay resolvable. Were they counted, the first routing override
    // an org ever authored would pin its target bucket forever.
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [
        overlayRouting(
          { PV1_REJECTED: "PRIOR_AUTH" },
          { status: WorkflowPolicyOverlayStatus.SUPERSEDED }
        ),
      ],
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r4" })
    );

    expect(fake.tx.bucket.delete).toHaveBeenCalled();
  });

  it("allows the delete when the ACTIVE overlay routes a stage somewhere else", async () => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [overlayRouting({ PV1_REJECTED: "SOME_OTHER_QUEUE" })],
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r5" })
    );

    expect(fake.tx.bucket.delete).toHaveBeenCalled();
  });

  it("allows the delete when the ACTIVE overlay declares no routing at all", async () => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [
        {
          id: OVERLAY_ID,
          clinicId: null,
          status: WorkflowPolicyOverlayStatus.ACTIVE,
          overlayJson: { forbidTransitionsFromStates: { CANCEL: ["RECEIVED"] } },
        },
      ],
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r6" })
    );

    expect(fake.tx.bucket.delete).toHaveBeenCalled();
  });

  // The read side must tolerate history. A row written by an older
  // build, or hand-patched during an incident, must not be able to
  // break the bucket admin screen.
  it.each([
    ["null overlayJson", null],
    ["a scalar overlayJson", 7],
    ["an array overlayJson", []],
    ["a non-object routing map", { routeStatesToBucketCodes: "PRIOR_AUTH" }],
    ["an array routing map", { routeStatesToBucketCodes: [] }],
    ["a routing map of junk values", { routeStatesToBucketCodes: { PV1_REJECTED: 7 } }],
  ])("tolerates %s and allows the delete", async (_label, overlayJson) => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 0,
      overlays: [
        {
          id: OVERLAY_ID,
          clinicId: null,
          status: WorkflowPolicyOverlayStatus.ACTIVE,
          overlayJson,
        },
      ],
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: `db-r7-${_label}` })
    );

    expect(fake.tx.bucket.delete).toHaveBeenCalled();
    resetCommandBusConfigurationForTests();
  });

  it("scopes the overlay scan to the actor's organization and ACTIVE rows", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET, orderCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r8" })
    );

    const scan = fake.calls.find((c) => c.table === "workflowPolicyOverlay" && c.op === "findMany");
    const where = (scan!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
    expect(where["status"]).toBe(WorkflowPolicyOverlayStatus.ACTIVE);
  });

  it("checks orders BEFORE routes, so a full bucket reports the actionable step first", async () => {
    const fake = buildPrismaFake({
      existing: CUSTOM_BUCKET,
      orderCount: 3,
      overlays: [overlayRouting({ PV1_REJECTED: "PRIOR_AUTH" })],
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(DeleteBucket, { bucketId: BUCKET_ID }, { idempotencyKey: "db-r9" })
      )
    ).rejects.toMatchObject({ code: DELETE_BUCKET_HAS_ORDERS });
  });
});
