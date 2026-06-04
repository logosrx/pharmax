// ArchivePackagePhoto contract tests.
//
// Pins the bus contract end-to-end (RBAC gate + tx + audit + outbox)
// against a Prisma fake. Exercises:
//   - permission gate (SHIP_ARCHIVE_PACKAGE_PHOTO)
//   - photo lookup (NotFound vs found-unarchived vs found-already-archived)
//   - happy archive (audit + outbox, wasMatched flag)
//   - idempotent no-op when already archived (no updateMany, no outbox)
//   - race-lost path (updateMany count=0 → alreadyArchived, no outbox)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, errors, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { ArchivePackagePhoto, PACKAGE_PHOTO_ARCHIVE_NOT_FOUND } from "./archive-package-photo.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const PHOTO_ID = "01J9X8QTVKA8WX7Z2KVE5RHK10";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_ARCHIVE_PACKAGE_PHOTO]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    siteId: SITE_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface PhotoRow {
  readonly id: string;
  readonly matched: boolean;
  readonly archivedAt: Date | null;
  readonly archiveReason: string | null;
}

interface FakeOverrides {
  readonly photo?: PhotoRow | null;
  readonly photoAfterUpdate?: PhotoRow | null;
  readonly updateCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const photoRow =
    overrides.photo === undefined
      ? { id: PHOTO_ID, matched: false, archivedAt: null, archiveReason: null }
      : overrides.photo;

  const updateCount = overrides.updateCount ?? 1;
  const photoAfterUpdate = overrides.photoAfterUpdate ?? null;

  let photoFindFirstCallCount = 0;

  const tx = {
    packagePhoto: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "packagePhoto", op: "findFirst", args });
        photoFindFirstCallCount += 1;
        if (photoFindFirstCallCount === 1) return photoRow;
        return photoAfterUpdate;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "packagePhoto", op: "updateMany", args });
        return { count: updateCount };
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
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
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: {
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-06-20T15:30:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ArchivePackagePhoto — happy path", () => {
  it("archives an unmatched photo, stamps the reason, emits audit + outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ArchivePackagePhoto,
        { photoId: PHOTO_ID, reason: "TEST_CAPTURE" },
        { idempotencyKey: `archive:${PHOTO_ID}` }
      )
    );

    expect(out).toEqual({
      photoId: PHOTO_ID,
      archived: true,
      alreadyArchived: false,
      reason: "TEST_CAPTURE",
      wasMatched: false,
    });

    const update = callsOf(fake.calls, "packagePhoto", "updateMany")[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toMatchObject({ id: PHOTO_ID, organizationId: ORG_ID, archivedAt: null });
    expect(update.data).toMatchObject({
      archiveReason: "TEST_CAPTURE",
      archivedByUserId: USER_ID,
    });
    expect(update.data).toHaveProperty("archivedAt");

    const audit = callsOf(fake.calls, "auditLog", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      action: "shipping.package_photo.archived",
      resourceType: "PackagePhoto",
      resourceId: PHOTO_ID,
    });

    const outbox = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outbox[0]).toMatchObject({
      eventType: "shipping.package_photo.archived.v1",
      aggregateType: "PackagePhoto",
      aggregateId: PHOTO_ID,
    });
    expect(outbox[0]!.payload as Record<string, unknown>).toMatchObject({
      organizationId: ORG_ID,
      photoId: PHOTO_ID,
      reason: "TEST_CAPTURE",
      wasMatched: false,
      archivedByUserId: USER_ID,
    });
  });

  it("carries wasMatched=true when archiving a matched photo (fix-wrong-match path)", async () => {
    const fake = buildPrismaFake({
      photo: { id: PHOTO_ID, matched: true, archivedAt: null, archiveReason: null },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ArchivePackagePhoto,
        { photoId: PHOTO_ID, reason: "CAPTURED_IN_ERROR" },
        { idempotencyKey: `archive2:${PHOTO_ID}` }
      )
    );

    expect(out.wasMatched).toBe(true);
    expect(out.alreadyArchived).toBe(false);
    const outbox = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect((outbox[0]!.payload as Record<string, unknown>).wasMatched).toBe(true);
  });
});

describe("ArchivePackagePhoto — idempotent no-op", () => {
  it("returns alreadyArchived without re-stamping or emitting when already archived", async () => {
    const fake = buildPrismaFake({
      photo: {
        id: PHOTO_ID,
        matched: false,
        archivedAt: new Date("2026-06-19T10:00:00.000Z"),
        archiveReason: "DUPLICATE",
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ArchivePackagePhoto,
        { photoId: PHOTO_ID, reason: "TEST_CAPTURE" },
        { idempotencyKey: `archive3:${PHOTO_ID}` }
      )
    );

    expect(out).toEqual({
      photoId: PHOTO_ID,
      archived: true,
      alreadyArchived: true,
      reason: "DUPLICATE", // preserves the ORIGINAL reason, not the new one
      wasMatched: false,
    });

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
    const audit = callsOf(fake.calls, "auditLog", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({ action: "shipping.package_photo.archive_noop" });
  });

  it("returns alreadyArchived without emitting when it loses the archive race (count=0)", async () => {
    const fake = buildPrismaFake({
      updateCount: 0,
      photoAfterUpdate: {
        id: PHOTO_ID,
        matched: false,
        archivedAt: new Date("2026-06-20T15:29:59.000Z"),
        archiveReason: "UNRESOLVABLE",
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ArchivePackagePhoto,
        { photoId: PHOTO_ID, reason: "TEST_CAPTURE" },
        { idempotencyKey: `archive4:${PHOTO_ID}` }
      )
    );

    expect(out.alreadyArchived).toBe(true);
    expect(out.reason).toBe("UNRESOLVABLE");
    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "packagePhoto", "findFirst")).toHaveLength(2);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("ArchivePackagePhoto — error + RBAC", () => {
  it("throws PACKAGE_PHOTO_ARCHIVE_NOT_FOUND when the photo is not in the org", async () => {
    const fake = buildPrismaFake({ photo: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ArchivePackagePhoto,
          { photoId: PHOTO_ID, reason: "TEST_CAPTURE" },
          { idempotencyKey: `e1:${PHOTO_ID}` }
        )
      )
    ).rejects.toMatchObject({ code: PACKAGE_PHOTO_ARCHIVE_NOT_FOUND });

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
  });

  it("rejects an actor without SHIP_ARCHIVE_PACKAGE_PHOTO", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH]),
            },
          ],
        },
      ]),
    });

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ArchivePackagePhoto,
          { photoId: PHOTO_ID, reason: "TEST_CAPTURE" },
          { idempotencyKey: `e2:${PHOTO_ID}` }
        )
      )
    ).rejects.toBeInstanceOf(errors.AuthorizationError);

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
  });
});
