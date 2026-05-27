// ResolvePackagePhotoMatch contract tests.
//
// Pin the bus contract end-to-end (RBAC gate + tx + audit + outbox)
// against a Prisma fake. The bus runs the real `executeCommand`,
// so we exercise:
//
//   - permission gate (SHIP_RESOLVE_PACKAGE_PHOTO_MATCH)
//   - photo lookup (NotFound vs. found-and-unmatched vs. found-but-already-matched)
//   - target-order lookup (NotFound)
//   - clinicId back-fill rule (only when photo had null clinicId)
//   - tracking back-fill rule (only when photo had null trackingNumber)
//   - the race-safe updateMany path (count=0 → ALREADY_MATCHED)
//   - audit + outbox shape (no PHI; structural deltas only)

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

import {
  PACKAGE_PHOTO_ALREADY_MATCHED,
  PACKAGE_PHOTO_NOT_FOUND,
  PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND,
  ResolvePackagePhotoMatch,
} from "./resolve-package-photo-match.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const CLINIC_ID = "00000000-0000-4000-8000-000000000004";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000bb";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const PHOTO_ID = "01J9X8QTVKA8WX7Z2KVE5RHK10"; // ULID-shaped (matches CapturePackagePhoto's output)

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH]),
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
  readonly clinicId: string | null;
  readonly matched: boolean;
  readonly matchStrategy: string;
  readonly matchedOrderId: string | null;
  readonly trackingNumber: string | null;
  readonly trackingSource: string | null;
  readonly sourceShipmentId: string | null;
}

interface OrderRow {
  readonly id: string;
  readonly patientId: string;
  readonly clinicId: string | null;
}

interface ShipmentRow {
  readonly id: string;
  readonly trackingNumber: string;
}

interface FakeOverrides {
  readonly photo?: PhotoRow | null;
  readonly photoAfterUpdate?: PhotoRow | null;
  readonly order?: OrderRow | null;
  readonly latestShipment?: ShipmentRow | null;
  readonly updateCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const photoRow =
    overrides.photo === undefined
      ? {
          id: PHOTO_ID,
          clinicId: null,
          matched: false,
          matchStrategy: "UNMATCHED",
          matchedOrderId: null,
          trackingNumber: null,
          trackingSource: null,
          sourceShipmentId: null,
        }
      : overrides.photo;

  const orderRow =
    overrides.order === undefined
      ? { id: ORDER_ID, patientId: PATIENT_ID, clinicId: CLINIC_ID }
      : overrides.order;

  const shipmentRow =
    overrides.latestShipment === undefined
      ? { id: SHIPMENT_ID, trackingNumber: "1Z999AA10123456784" }
      : overrides.latestShipment;

  const updateCount = overrides.updateCount ?? 1;

  // After a successful update, subsequent findFirst calls (the
  // race-loser re-read path) should see the matched row.
  const photoAfterUpdate =
    overrides.photoAfterUpdate === undefined
      ? photoRow !== null
        ? {
            ...photoRow,
            matched: true,
            matchStrategy: "MANUAL_ORDER_ID",
            matchedOrderId: orderRow?.id ?? null,
          }
        : null
      : overrides.photoAfterUpdate;

  let photoFindFirstCallCount = 0;

  const tx = {
    packagePhoto: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "packagePhoto", op: "findFirst", args });
        photoFindFirstCallCount += 1;
        // First call: pre-update read.
        // Second call (only happens when updateMany returns count=0):
        //   the race-loser path re-reads to surface the winner.
        if (photoFindFirstCallCount === 1) return photoRow;
        return photoAfterUpdate;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "packagePhoto", op: "updateMany", args });
        return { count: updateCount };
      }),
    },
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return orderRow;
      }),
    },
    shipment: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "findFirst", args });
        return shipmentRow;
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        return {
          organizationId: ORG_ID,
          latestHash: Buffer.alloc(32),
          latestSeq: 1n,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        calls.push({
          table: "$executeRaw",
          op: "set_config",
          args: { sql: template.join("?"), values: [...values] },
        });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
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
    clock: clock.createFrozenClock(new Date("2026-06-12T15:30:00.000Z")),
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

describe("ResolvePackagePhotoMatch — happy path (back-fills clinic + tracking)", () => {
  it("matches an unmatched photo, back-fills clinic and tracking, emits audit+outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolvePackagePhotoMatch,
        { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
        { idempotencyKey: `resolve-package-photo-match:${PHOTO_ID}` }
      )
    );

    expect(out).toEqual({
      photoId: PHOTO_ID,
      matchedOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      clinicId: CLINIC_ID,
      trackingNumber: "1Z999AA10123456784",
      trackingSource: "ORDER",
      clinicBackfilled: true,
      trackingBackfilled: true,
    });

    const update = callsOf(fake.calls, "packagePhoto", "updateMany")[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toMatchObject({
      id: PHOTO_ID,
      organizationId: ORG_ID,
      matched: false,
    });
    expect(update.data).toMatchObject({
      matched: true,
      matchStrategy: "MANUAL_ORDER_ID",
      matchedOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      clinicId: CLINIC_ID,
      trackingNumber: "1Z999AA10123456784",
      trackingSource: "ORDER",
      sourceShipmentId: SHIPMENT_ID,
    });
    expect(update.data).toHaveProperty("matchedAt");

    const audit = callsOf(fake.calls, "auditLog", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      action: "shipping.package_photo.match_resolved",
      resourceType: "PackagePhoto",
      resourceId: PHOTO_ID,
    });
    const auditMeta = audit.data["metadata"] as Record<string, unknown>;
    expect(auditMeta).toMatchObject({
      photoId: PHOTO_ID,
      targetOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      priorMatchStrategy: "UNMATCHED",
      newMatchStrategy: "MANUAL_ORDER_ID",
      clinicBackfilled: true,
      trackingBackfilled: true,
    });

    const outbox = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outbox[0]).toMatchObject({
      eventType: "shipping.package_photo.match_resolved.v1",
      aggregateType: "PackagePhoto",
      aggregateId: PHOTO_ID,
    });
    const payload = outbox[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      photoId: PHOTO_ID,
      matchedOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      priorMatchStrategy: "UNMATCHED",
      newMatchStrategy: "MANUAL_ORDER_ID",
      clinicBackfilled: true,
      trackingBackfilled: true,
      resolvedByUserId: USER_ID,
    });
    expect(payload).toHaveProperty("resolvedAt");
  });
});

describe("ResolvePackagePhotoMatch — does not overwrite operator's capture-time choices", () => {
  it("does NOT back-fill clinicId when the photo already had one", async () => {
    const fake = buildPrismaFake({
      photo: {
        id: PHOTO_ID,
        clinicId: "00000000-0000-4000-8000-0000000000c1", // pre-existing
        matched: false,
        matchStrategy: "UNMATCHED",
        matchedOrderId: null,
        trackingNumber: null,
        trackingSource: null,
        sourceShipmentId: null,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolvePackagePhotoMatch,
        { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
        { idempotencyKey: `r1:${PHOTO_ID}` }
      )
    );

    expect(out.clinicId).toBe("00000000-0000-4000-8000-0000000000c1");
    expect(out.clinicBackfilled).toBe(false);

    const update = callsOf(fake.calls, "packagePhoto", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    // The data object must NOT include clinicId — leaving the
    // pre-existing value untouched.
    expect(update.data).not.toHaveProperty("clinicId");
  });

  it("does NOT back-fill trackingNumber when the photo already had a manual one", async () => {
    const fake = buildPrismaFake({
      photo: {
        id: PHOTO_ID,
        clinicId: null,
        matched: false,
        matchStrategy: "UNMATCHED",
        matchedOrderId: null,
        trackingNumber: "MANUAL-AT-CAPTURE",
        trackingSource: "MANUAL",
        sourceShipmentId: null,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolvePackagePhotoMatch,
        { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
        { idempotencyKey: `r2:${PHOTO_ID}` }
      )
    );

    expect(out.trackingNumber).toBe("MANUAL-AT-CAPTURE");
    expect(out.trackingSource).toBe("MANUAL");
    expect(out.trackingBackfilled).toBe(false);

    expect(callsOf(fake.calls, "shipment", "findFirst")).toHaveLength(0);

    const update = callsOf(fake.calls, "packagePhoto", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty("trackingNumber");
    expect(update.data).not.toHaveProperty("trackingSource");
  });
});

describe("ResolvePackagePhotoMatch — no shipment to back-fill from", () => {
  it("succeeds with trackingBackfilled=false when the order has no shipments", async () => {
    const fake = buildPrismaFake({ latestShipment: null });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolvePackagePhotoMatch,
        { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
        { idempotencyKey: `r3:${PHOTO_ID}` }
      )
    );

    expect(out.trackingNumber).toBeNull();
    expect(out.trackingSource).toBeNull();
    expect(out.trackingBackfilled).toBe(false);

    const update = callsOf(fake.calls, "packagePhoto", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty("trackingNumber");
  });
});

describe("ResolvePackagePhotoMatch — error paths", () => {
  it("throws PACKAGE_PHOTO_NOT_FOUND when the photo doesn't exist in the org", async () => {
    const fake = buildPrismaFake({ photo: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ResolvePackagePhotoMatch,
          { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
          { idempotencyKey: `e1:${PHOTO_ID}` }
        )
      )
    ).rejects.toMatchObject({
      code: PACKAGE_PHOTO_NOT_FOUND,
    });

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "findFirst")).toHaveLength(0);
  });

  it("throws PACKAGE_PHOTO_ALREADY_MATCHED when the photo is already matched (pre-update read)", async () => {
    const fake = buildPrismaFake({
      photo: {
        id: PHOTO_ID,
        clinicId: CLINIC_ID,
        matched: true,
        matchStrategy: "EXTERNAL_ORDER_NUMBER",
        matchedOrderId: "00000000-0000-4000-8000-0000000000a9",
        trackingNumber: "1Z-EXISTING",
        trackingSource: "ORDER",
        sourceShipmentId: SHIPMENT_ID,
      },
    });
    configureBus(fake.client);

    let captured: errors.ConflictError | undefined;
    await withTenancyContext(ctxFor(), async () => {
      try {
        await executeCommand(
          ResolvePackagePhotoMatch,
          { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
          { idempotencyKey: `e2:${PHOTO_ID}` }
        );
      } catch (err) {
        if (err instanceof errors.ConflictError) captured = err;
        else throw err;
      }
    });

    expect(captured).toBeDefined();
    expect(captured!.code).toBe(PACKAGE_PHOTO_ALREADY_MATCHED);
    expect(captured!.metadata).toMatchObject({
      photoId: PHOTO_ID,
      existingMatchedOrderId: "00000000-0000-4000-8000-0000000000a9",
      existingMatchStrategy: "EXTERNAL_ORDER_NUMBER",
    });

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
  });

  it("throws PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND when the target order doesn't exist", async () => {
    const fake = buildPrismaFake({ order: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ResolvePackagePhotoMatch,
          { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
          { idempotencyKey: `e3:${PHOTO_ID}` }
        )
      )
    ).rejects.toMatchObject({
      code: PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND,
    });

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
  });

  it("throws PACKAGE_PHOTO_ALREADY_MATCHED when updateMany returns count=0 (race lost)", async () => {
    const fake = buildPrismaFake({
      updateCount: 0,
      // The race-loser re-read returns the winner's match info.
      photoAfterUpdate: {
        id: PHOTO_ID,
        clinicId: CLINIC_ID,
        matched: true,
        matchStrategy: "EXTERNAL_ORDER_NUMBER",
        matchedOrderId: "00000000-0000-4000-8000-0000000000a9",
        trackingNumber: null,
        trackingSource: null,
        sourceShipmentId: null,
      },
    });
    configureBus(fake.client);

    let captured: errors.ConflictError | undefined;
    await withTenancyContext(ctxFor(), async () => {
      try {
        await executeCommand(
          ResolvePackagePhotoMatch,
          { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
          { idempotencyKey: `e4:${PHOTO_ID}` }
        );
      } catch (err) {
        if (err instanceof errors.ConflictError) captured = err;
        else throw err;
      }
    });

    expect(captured).toBeDefined();
    expect(captured!.code).toBe(PACKAGE_PHOTO_ALREADY_MATCHED);
    expect(captured!.metadata).toMatchObject({
      photoId: PHOTO_ID,
      existingMatchedOrderId: "00000000-0000-4000-8000-0000000000a9",
      existingMatchStrategy: "EXTERNAL_ORDER_NUMBER",
    });

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(1);
    // The race-loser path re-reads (second findFirst).
    expect(callsOf(fake.calls, "packagePhoto", "findFirst")).toHaveLength(2);
  });
});

describe("ResolvePackagePhotoMatch — RBAC gate", () => {
  it("rejects an actor without SHIP_RESOLVE_PACKAGE_PHOTO_MATCH", async () => {
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
              permissions: new Set([PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO]),
            },
          ],
        },
      ]),
    });

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ResolvePackagePhotoMatch,
          { photoId: PHOTO_ID, targetOrderId: ORDER_ID },
          { idempotencyKey: `e5:${PHOTO_ID}` }
        )
      )
    ).rejects.toBeInstanceOf(errors.AuthorizationError);

    expect(callsOf(fake.calls, "packagePhoto", "updateMany")).toHaveLength(0);
  });
});
