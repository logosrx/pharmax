// UpdateBucket contract tests.
//
// The load-bearing assertions here are the system-bucket ones. The
// seeded seven are dereferenced by VALUE by two subsystems — the
// workflow engine by `code`, the emergency SLA report by `kind` — so
// the test suite pins exactly which fields an admin may move:
//
//   system  →  name, sortOrder            (display plane)
//   custom  →  name, sortOrder, kind      (minus reserved kinds)
//
// `code` is absent from the strict input schema entirely, so its
// immutability is asserted at the boundary rather than in the handler.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { BucketKind, RoleScope } from "@pharmax/database";
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
  UpdateBucket,
  UPDATE_BUCKET_KIND_RESERVED,
  UPDATE_BUCKET_NOT_FOUND,
  UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE,
} from "./update-bucket.js";

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
  sortOrder: number;
  isSystem: boolean;
}

const CUSTOM_BUCKET: ExistingBucket = {
  id: BUCKET_ID,
  code: "PRIOR_AUTH",
  name: "Prior Authorization",
  kind: BucketKind.HOLD,
  sortOrder: 100,
  isSystem: false,
};

const SYSTEM_BUCKET: ExistingBucket = {
  id: BUCKET_ID,
  code: "EMERGENCY",
  name: "Emergency",
  kind: BucketKind.EMERGENCY,
  sortOrder: 70,
  isSystem: true,
};

function buildPrismaFake(input: { existing?: ExistingBucket | null }) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  const tx = {
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return input.existing === undefined ? CUSTOM_BUCKET : input.existing;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "update", args });
        return { id: BUCKET_ID };
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

describe("UpdateBucket — custom buckets", () => {
  it("renames and reorders a custom bucket", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        { bucketId: BUCKET_ID, name: "PA Review", sortOrder: 15 },
        { idempotencyKey: "ub-1" }
      )
    );

    expect(out.fieldsChanged).toEqual(["name", "sortOrder"]);
    expect(out.isSystem).toBe(false);

    const update = fake.calls.find((c) => c.table === "bucket" && c.op === "update");
    const data = (update!.args as { data: Record<string, unknown> }).data;
    expect(data["name"]).toBe("PA Review");
    expect(data["sortOrder"]).toBe(15);
    // Kind was not supplied, so it must be carried through unchanged.
    expect(data["kind"]).toBe(BucketKind.HOLD);
  });

  it("changes the kind of a custom bucket to another assignable kind", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        {
          bucketId: BUCKET_ID,
          name: CUSTOM_BUCKET.name,
          sortOrder: CUSTOM_BUCKET.sortOrder,
          kind: BucketKind.EXCEPTION,
        },
        { idempotencyKey: "ub-2" }
      )
    );

    expect(out.fieldsChanged).toEqual(["kind"]);
    const update = fake.calls.find((c) => c.table === "bucket" && c.op === "update");
    expect((update!.args as { data: Record<string, unknown> }).data["kind"]).toBe(
      BucketKind.EXCEPTION
    );
  });

  it("refuses to move a custom bucket onto a reserved kind", async () => {
    for (const kind of [BucketKind.EMERGENCY, BucketKind.WORKFLOW]) {
      const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
      configureBus(fake.client);

      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(
            UpdateBucket,
            {
              bucketId: BUCKET_ID,
              name: CUSTOM_BUCKET.name,
              sortOrder: CUSTOM_BUCKET.sortOrder,
              kind,
            },
            { idempotencyKey: `ub-reserved-${kind}` }
          )
        )
      ).rejects.toMatchObject({ code: UPDATE_BUCKET_KIND_RESERVED });
      expect(fake.tx.bucket.update).not.toHaveBeenCalled();
      resetCommandBusConfigurationForTests();
    }
  });

  it("reports an empty diff when nothing actually changed", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        {
          bucketId: BUCKET_ID,
          name: CUSTOM_BUCKET.name,
          sortOrder: CUSTOM_BUCKET.sortOrder,
          kind: CUSTOM_BUCKET.kind,
        },
        { idempotencyKey: "ub-3" }
      )
    );

    expect(out.fieldsChanged).toEqual([]);
  });
});

describe("UpdateBucket — system bucket protection", () => {
  it("ALLOWS renaming and reordering a system bucket (display plane only)", async () => {
    const fake = buildPrismaFake({ existing: SYSTEM_BUCKET });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        { bucketId: BUCKET_ID, name: "Escalations", sortOrder: 5 },
        { idempotencyKey: "ub-4" }
      )
    );

    expect(out.isSystem).toBe(true);
    expect(out.fieldsChanged).toEqual(["name", "sortOrder"]);
    expect(fake.tx.bucket.update).toHaveBeenCalled();
  });

  it("REFUSES a kind change on a system bucket", async () => {
    const fake = buildPrismaFake({ existing: SYSTEM_BUCKET });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateBucket,
          {
            bucketId: BUCKET_ID,
            name: SYSTEM_BUCKET.name,
            sortOrder: SYSTEM_BUCKET.sortOrder,
            kind: BucketKind.CUSTOM,
          },
          { idempotencyKey: "ub-5" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE });
    // The refusal must happen BEFORE any write — a partially applied
    // update that renamed the bucket but rejected the kind would leave
    // the operator staring at a half-saved form.
    expect(fake.tx.bucket.update).not.toHaveBeenCalled();
  });

  it("REFUSES a kind change on a system WORKFLOW bucket too", async () => {
    const fake = buildPrismaFake({
      existing: {
        id: BUCKET_ID,
        code: "TYPING",
        name: "Typing",
        kind: BucketKind.WORKFLOW,
        sortOrder: 20,
        isSystem: true,
      },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateBucket,
          { bucketId: BUCKET_ID, name: "Typing", sortOrder: 20, kind: BucketKind.CUSTOM },
          { idempotencyKey: "ub-6" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE });
  });

  it("accepts a system bucket's CURRENT kind echoed back by the form", async () => {
    const fake = buildPrismaFake({ existing: SYSTEM_BUCKET });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        {
          bucketId: BUCKET_ID,
          name: "Escalations",
          sortOrder: SYSTEM_BUCKET.sortOrder,
          kind: SYSTEM_BUCKET.kind,
        },
        { idempotencyKey: "ub-7" }
      )
    );

    expect(out.fieldsChanged).toEqual(["name"]);
  });
});

describe("UpdateBucket — code immutability", () => {
  it("rejects a request carrying a code, on system and custom buckets alike", async () => {
    for (const existing of [CUSTOM_BUCKET, SYSTEM_BUCKET]) {
      const fake = buildPrismaFake({ existing });
      configureBus(fake.client);

      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(
            UpdateBucket,
            {
              bucketId: BUCKET_ID,
              name: existing.name,
              sortOrder: existing.sortOrder,
              code: "RENAMED",
            } as never,
            { idempotencyKey: `ub-code-${existing.code}` }
          )
        )
      ).rejects.toThrow();
      expect(fake.tx.bucket.update).not.toHaveBeenCalled();
      resetCommandBusConfigurationForTests();
    }
  });
});

describe("UpdateBucket — tenancy and RBAC", () => {
  it("treats a bucket outside the actor's organization as not found", async () => {
    const fake = buildPrismaFake({ existing: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateBucket,
          { bucketId: BUCKET_ID, name: "Whatever", sortOrder: 1 },
          { idempotencyKey: "ub-8" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_BUCKET_NOT_FOUND });
  });

  it("scopes the bucket lookup by organizationId", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        { bucketId: BUCKET_ID, name: "PA Review", sortOrder: 15 },
        { idempotencyKey: "ub-9" }
      )
    );

    const find = fake.calls.find((c) => c.table === "bucket" && c.op === "findFirst");
    const where = (find!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
    expect(where["id"]).toBe(BUCKET_ID);
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
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateBucket,
          { bucketId: BUCKET_ID, name: "PA Review", sortOrder: 15 },
          { idempotencyKey: "ub-10" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.bucket.update).not.toHaveBeenCalled();
  });
});

describe("UpdateBucket — audit and outbox", () => {
  it("writes the audit row and the versioned outbox event with the diff", async () => {
    const fake = buildPrismaFake({ existing: CUSTOM_BUCKET });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateBucket,
        { bucketId: BUCKET_ID, name: "PA Review", sortOrder: 15 },
        { idempotencyKey: "ub-11" }
      )
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.bucket.updated");
    expect(audit?.["resourceType"]).toBe("Bucket");

    const event = fake.outboxRows.find((r) => r["eventType"] === "org.bucket.updated.v1");
    expect(event).toBeDefined();
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["fieldsChanged"]).toEqual(["name", "sortOrder"]);
    expect(payload["code"]).toBe("PRIOR_AUTH");
  });
});
