// CapturePackagePhoto contract tests.
//
// Pin the bus contract end-to-end (RBAC gate + tx + audit + outbox)
// against a Prisma fake. The test bus runs the real
// `executeCommand`, so we exercise:
//
//   - permission gate (SHIP_CAPTURE_PACKAGE_PHOTO)
//   - upload-token resolution (happy / unknown / tenant-mismatch)
//   - order match by externalOrderNumber (matched / unmatched)
//   - tracking-number resolution (manual override / from latest
//     shipment / none)
//   - notes encryption (notesEnc set when notes provided; never set
//     when omitted)
//   - duplicate sha256 path (P2002 → PACKAGE_PHOTO_DUPLICATE_BYTES)
//   - audit + outbox shape (no PHI; structural fields only)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
import { Prisma, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  CapturePackagePhoto,
  PACKAGE_PHOTO_DUPLICATE_BYTES,
  PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH,
  PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN,
} from "./capture-package-photo.js";
import {
  configurePackagePhotoStorage,
  resetPackagePhotoStorageConfigurationForTests,
} from "../storage/configure.js";
import { InMemoryPackagePhotoStorage } from "../storage/in-memory-package-photo-storage.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000ff";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const CLINIC_ID = "00000000-0000-4000-8000-000000000004";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000bb";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const WORKSTATION_ID = "00000000-0000-4000-8000-00000000000c";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO]),
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

interface OrderRow {
  readonly id: string;
  readonly patientId: string;
  readonly clinicId: string | null;
  readonly siteId: string;
}

interface ShipmentRow {
  readonly id: string;
  readonly trackingNumber: string;
}

interface FakeOverrides {
  readonly order?: OrderRow | null;
  readonly latestShipment?: ShipmentRow | null;
  readonly createThrows?: Error | null;
  readonly priorPackagePhoto?: { readonly id: string } | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const orderRow =
    overrides.order === undefined
      ? {
          id: ORDER_ID,
          patientId: PATIENT_ID,
          clinicId: CLINIC_ID,
          siteId: SITE_ID,
        }
      : overrides.order;

  const shipmentRow =
    overrides.latestShipment === undefined
      ? { id: SHIPMENT_ID, trackingNumber: "1Z999AA10123456784" }
      : overrides.latestShipment;

  const createThrows = overrides.createThrows ?? null;
  const priorPackagePhoto = overrides.priorPackagePhoto ?? null;

  const tx = {
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
    packagePhoto: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "packagePhoto", op: "create", args });
        if (createThrows !== null) {
          throw createThrows;
        }
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "packagePhoto", op: "findFirst", args });
        return priorPackagePhoto;
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
    clock: clock.createFrozenClock(new Date("2026-06-06T15:30:00.000Z")),
    logger: logger.noopLogger,
  });
}

let storage: InMemoryPackagePhotoStorage;

beforeEach(() => {
  storage = new InMemoryPackagePhotoStorage();
  configurePackagePhotoStorage({ storage });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "package-capture-test-seed" }) });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
  resetPackagePhotoStorageConfigurationForTests();
});

async function uploadTestBytes(orgId: string = ORG_ID, payload = "fake-jpeg-bytes-1") {
  return storage.beginUpload({
    organizationId: orgId,
    contentType: "image/jpeg",
    bytes: new TextEncoder().encode(payload),
  });
}

describe("CapturePackagePhoto — happy path (matched order, no manual tracking)", () => {
  it("inserts row with matched order + auto-resolved tracking + emits outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const upload = await uploadTestBytes();

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CapturePackagePhoto,
        {
          uploadToken: upload.uploadToken,
          pharmacyExternalOrderNumber: "EXT-12345",
        },
        { idempotencyKey: `package-photo:${upload.sha256}` }
      )
    );

    expect(out).toMatchObject({
      matched: true,
      matchedOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      trackingNumber: "1Z999AA10123456784",
      trackingSource: "ORDER",
      storageBucket: upload.bucket,
      storageKey: upload.key,
      sha256: upload.sha256,
    });
    expect(out.photoId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const create = callsOf(fake.calls, "packagePhoto", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(create.data).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      clinicId: CLINIC_ID,
      capturedByUserId: USER_ID,
      pharmacyExternalOrderNumber: "EXT-12345",
      matched: true,
      matchStrategy: "EXTERNAL_ORDER_NUMBER",
      matchedOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      trackingNumber: "1Z999AA10123456784",
      trackingSource: "ORDER",
      sourceShipmentId: SHIPMENT_ID,
      storageBucket: upload.bucket,
      storageKey: upload.key,
      contentType: "image/jpeg",
      sha256: upload.sha256,
    });
    expect(create.data).not.toHaveProperty("notesEnc");
    expect(create.data).not.toHaveProperty("capturedAtWorkstationId");

    const outbox = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outbox[0]).toMatchObject({
      eventType: "shipping.package_photo.captured.v1",
      aggregateType: "PackagePhoto",
    });
    const payload = outbox[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      matched: true,
      matchedOrderId: ORDER_ID,
      matchedPatientId: PATIENT_ID,
      trackingSource: "ORDER",
      sourceShipmentId: SHIPMENT_ID,
      sha256: upload.sha256,
    });
    expect(payload).not.toHaveProperty("notes");
    expect(payload).not.toHaveProperty("notesEnc");
  });
});

describe("CapturePackagePhoto — manual tracking number override", () => {
  it("manualTrackingNumber wins over the matched order's latest shipment", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const upload = await uploadTestBytes();

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CapturePackagePhoto,
        {
          uploadToken: upload.uploadToken,
          pharmacyExternalOrderNumber: "EXT-12345",
          manualTrackingNumber: "MANUAL-OVERRIDE-9",
        },
        { idempotencyKey: `package-photo:${upload.sha256}:manual` }
      )
    );

    expect(out.trackingNumber).toBe("MANUAL-OVERRIDE-9");
    expect(out.trackingSource).toBe("MANUAL");
    expect(callsOf(fake.calls, "shipment", "findFirst")).toHaveLength(0);

    const create = callsOf(fake.calls, "packagePhoto", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(create.data).toMatchObject({
      trackingNumber: "MANUAL-OVERRIDE-9",
      trackingSource: "MANUAL",
    });
    expect(create.data).not.toHaveProperty("sourceShipmentId");
  });
});

describe("CapturePackagePhoto — unmatched external order number", () => {
  it("persists the row with matched=false and inherits siteId from caller's tenancy", async () => {
    const fake = buildPrismaFake({ order: null, latestShipment: null });
    configureBus(fake.client);
    const upload = await uploadTestBytes();

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CapturePackagePhoto,
        {
          uploadToken: upload.uploadToken,
          pharmacyExternalOrderNumber: "EXT-NOPE-404",
        },
        { idempotencyKey: `package-photo:${upload.sha256}:nomatch` }
      )
    );

    expect(out).toMatchObject({
      matched: false,
      matchedOrderId: null,
      matchedPatientId: null,
      trackingNumber: null,
      trackingSource: null,
    });

    const create = callsOf(fake.calls, "packagePhoto", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(create.data).toMatchObject({
      siteId: SITE_ID,
      matched: false,
      matchStrategy: "UNMATCHED",
    });
    expect(create.data).not.toHaveProperty("matchedOrderId");
    expect(create.data).not.toHaveProperty("matchedPatientId");
    expect(create.data).not.toHaveProperty("matchedAt");
    expect(create.data).not.toHaveProperty("clinicId");
    expect(create.data).not.toHaveProperty("trackingNumber");
    expect(create.data).not.toHaveProperty("trackingSource");
  });
});

describe("CapturePackagePhoto — notes are encrypted", () => {
  it("populates notesEnc when notes are provided and never echoes notes in audit/outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const upload = await uploadTestBytes();

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CapturePackagePhoto,
        {
          uploadToken: upload.uploadToken,
          pharmacyExternalOrderNumber: "EXT-12345",
          notes: "left side label crinkled — re-print before truck pickup",
        },
        { idempotencyKey: `package-photo:${upload.sha256}:notes` }
      )
    );

    const create = callsOf(fake.calls, "packagePhoto", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(create.data).toHaveProperty("notesEnc");
    const notesEnc = create.data.notesEnc as Record<string, unknown>;
    expect(notesEnc).toHaveProperty("ct");
    expect(notesEnc).toHaveProperty("iv");
    expect(notesEnc).toHaveProperty("tag");
    expect(notesEnc).toHaveProperty("kek");

    const audit = callsOf(fake.calls, "auditLog", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    const auditMetadata = JSON.stringify(audit.data.metadata ?? {});
    expect(auditMetadata).not.toContain("crinkled");
    expect(auditMetadata).toMatch(/"hasNotes":true/);

    const outbox = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    const outboxJson = JSON.stringify(outbox);
    expect(outboxJson).not.toContain("crinkled");
  });
});

describe("CapturePackagePhoto — workstation context", () => {
  it("threads capturedAtWorkstationId when supplied in input", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const upload = await uploadTestBytes();

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CapturePackagePhoto,
        {
          uploadToken: upload.uploadToken,
          pharmacyExternalOrderNumber: "EXT-12345",
          workstationId: WORKSTATION_ID,
        },
        { idempotencyKey: `package-photo:${upload.sha256}:ws` }
      )
    );

    const create = callsOf(fake.calls, "packagePhoto", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(create.data).toMatchObject({ capturedAtWorkstationId: WORKSTATION_ID });
  });
});

describe("CapturePackagePhoto — upload-token failures", () => {
  it("throws PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN for an unrecognized token", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CapturePackagePhoto,
          {
            uploadToken: "unknown-token-123",
            pharmacyExternalOrderNumber: "EXT-12345",
          },
          { idempotencyKey: "package-photo:unknown-1" }
        )
      ).rejects.toMatchObject({ code: PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN });
    });

    expect(callsOf(fake.calls, "packagePhoto", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "findFirst")).toHaveLength(0);
  });

  it("throws PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH when the token's org differs from the caller's", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const upload = await uploadTestBytes(OTHER_ORG_ID);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CapturePackagePhoto,
          {
            uploadToken: upload.uploadToken,
            pharmacyExternalOrderNumber: "EXT-12345",
          },
          { idempotencyKey: `package-photo:${upload.sha256}:cross-tenant` }
        )
      ).rejects.toMatchObject({ code: PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH });
    });

    expect(callsOf(fake.calls, "packagePhoto", "create")).toHaveLength(0);
  });
});

describe("CapturePackagePhoto — duplicate sha256", () => {
  it("translates a Prisma P2002 unique violation into PACKAGE_PHOTO_DUPLICATE_BYTES with existing photo id", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildPrismaFake({
      createThrows: duplicate,
      priorPackagePhoto: { id: "01EXISTINGPHOTO000000000001" },
    });
    configureBus(fake.client);
    const upload = await uploadTestBytes();

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CapturePackagePhoto,
          {
            uploadToken: upload.uploadToken,
            pharmacyExternalOrderNumber: "EXT-12345",
          },
          { idempotencyKey: `package-photo:${upload.sha256}:dup` }
        )
      ).rejects.toMatchObject({
        code: PACKAGE_PHOTO_DUPLICATE_BYTES,
        metadata: {
          sha256: upload.sha256,
          existingPhotoId: "01EXISTINGPHOTO000000000001",
        },
      });
    });
  });
});
