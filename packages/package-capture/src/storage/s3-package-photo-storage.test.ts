import { createHash } from "node:crypto";

import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PACKAGE_PHOTO_UPLOAD_TTL_MS,
  S3PackagePhotoStorage,
  type S3PutObjectInput,
  type S3UploadClient,
} from "./s3-package-photo-storage.js";

// ---------------------------------------------------------------------------
// Fakes.
//
// The adapter takes:
//   - An S3UploadClient (we record every PutObject call).
//   - A PrismaClient (we fake only the surface the adapter uses:
//     `$transaction` + `packagePhotoUploadToken.create` +
//     `packagePhotoUploadToken.findUnique`). The fake tx applies
//     a minimal `$executeRaw` no-op so the session-GUC helpers
//     pass through without contacting Postgres.
//
// We do NOT validate the actual SQL string emitted by the GUC
// helpers — that's covered by `@pharmax/tenancy`'s own tests.
// What we DO validate here is that the helpers were INVOKED (so
// future bugs that drop the GUC apply are caught).
// ---------------------------------------------------------------------------

class FakeS3 implements S3UploadClient {
  public readonly calls: S3PutObjectInput[] = [];
  public nextResult: { ETag?: string } = { ETag: "etag-1" };
  public nextError: Error | null = null;

  async putObject(input: S3PutObjectInput): Promise<{ ETag?: string }> {
    this.calls.push(input);
    if (this.nextError !== null) throw this.nextError;
    return this.nextResult;
  }
}

interface FakeTokenRow {
  token: string;
  organizationId: string;
  uploadedByUserId: string;
  siteId: string | null;
  clinicId: string | null;
  storageBucket: string;
  storageKey: string;
  sha256: string;
  fileSize: number;
  contentType: string;
  expiresAt: Date;
  createdAt: Date;
}

class FakePrisma {
  public readonly rows = new Map<string, FakeTokenRow>();
  public readonly executedRawSqls: string[] = [];
  public createShouldThrow: Error | null = null;

  async $transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
    return cb(this);
  }

  $executeRaw(template: TemplateStringsArray, ..._values: ReadonlyArray<unknown>): Promise<number> {
    this.executedRawSqls.push(template.join("?"));
    return Promise.resolve(1);
  }

  packagePhotoUploadToken = {
    create: async ({ data }: { data: FakeTokenRow }): Promise<FakeTokenRow> => {
      if (this.createShouldThrow !== null) throw this.createShouldThrow;
      const row: FakeTokenRow = {
        ...data,
        siteId: data.siteId ?? null,
        clinicId: data.clinicId ?? null,
        createdAt: data.createdAt ?? new Date(),
      };
      this.rows.set(row.token, row);
      return row;
    },
    findUnique: async ({ where }: { where: { token: string } }): Promise<FakeTokenRow | null> => {
      return this.rows.get(where.token) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Test scaffolding.
// ---------------------------------------------------------------------------

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const SITE_ID = "00000000-0000-4000-8000-0000000000bb";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000cc";
const CORRELATION_ID = "01HZX00000000000000000RR1A";

function ctx(orgId: string = ORG_A) {
  return buildTenancyContext({
    organizationId: orgId,
    siteId: SITE_ID,
    clinicId: CLINIC_ID,
    actor: { userId: USER_ID, correlationId: CORRELATION_ID },
  });
}

function bytes(payload: string): Uint8Array {
  return new TextEncoder().encode(payload);
}

function sha256HexOf(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function sha256B64Of(payload: string): string {
  return createHash("sha256").update(payload).digest("base64");
}

let s3: FakeS3;
let prisma: FakePrisma;
let storage: S3PackagePhotoStorage;
const NOW = new Date("2026-05-27T17:00:00.000Z");

beforeEach(() => {
  s3 = new FakeS3();
  prisma = new FakePrisma();
  storage = new S3PackagePhotoStorage({
    s3,
    prisma: prisma as unknown as ConstructorParameters<typeof S3PackagePhotoStorage>[0]["prisma"],
    bucket: "pharmax-package-photos-prod",
    kmsKeyId: "alias/pharmax/package-photos",
    now: () => NOW,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// beginUpload — happy path.
// ---------------------------------------------------------------------------

describe("S3PackagePhotoStorage.beginUpload — happy path", () => {
  it("PUTs to S3 with SSE-KMS + ChecksumSHA256 and persists a token row with the active tenancy", async () => {
    const payload = "dock-jpeg-bytes-1";
    const result = await withTenancyContext(ctx(ORG_A), () =>
      storage.beginUpload({
        organizationId: ORG_A,
        contentType: "image/jpeg",
        bytes: bytes(payload),
      })
    );

    expect(s3.calls).toHaveLength(1);
    const put = s3.calls[0]!;
    expect(put.Bucket).toBe("pharmax-package-photos-prod");
    expect(put.Key).toBe(`org/${ORG_A}/photo/upload/${result.uploadToken}`);
    expect(put.ContentType).toBe("image/jpeg");
    expect(put.ContentLength).toBe(payload.length);
    expect(put.ServerSideEncryption).toBe("aws:kms");
    expect(put.SSEKMSKeyId).toBe("alias/pharmax/package-photos");
    expect(put.ChecksumSHA256).toBe(sha256B64Of(payload));
    expect(put.Metadata).toEqual({
      sha256: sha256HexOf(payload),
      organizationid: ORG_A,
      contenttype: "image/jpeg",
      uploadedbyuserid: USER_ID,
    });

    expect(result.bucket).toBe("pharmax-package-photos-prod");
    expect(result.key).toBe(put.Key);
    expect(result.sha256).toBe(sha256HexOf(payload));
    expect(result.fileSize).toBe(payload.length);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.uploadToken).toMatch(/^[0-9a-f-]{36}$/);

    expect(prisma.rows.size).toBe(1);
    const row = prisma.rows.get(result.uploadToken)!;
    expect(row.organizationId).toBe(ORG_A);
    expect(row.uploadedByUserId).toBe(USER_ID);
    expect(row.siteId).toBe(SITE_ID);
    expect(row.clinicId).toBe(CLINIC_ID);
    expect(row.storageBucket).toBe("pharmax-package-photos-prod");
    expect(row.storageKey).toBe(put.Key);
    expect(row.sha256).toBe(sha256HexOf(payload));
    expect(row.fileSize).toBe(payload.length);
    expect(row.contentType).toBe("image/jpeg");
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + PACKAGE_PHOTO_UPLOAD_TTL_MS);

    expect(prisma.executedRawSqls.length).toBeGreaterThanOrEqual(2);
    expect(prisma.executedRawSqls.some((s) => s.includes("set_config"))).toBe(true);
  });

  it("omits siteId and clinicId on the row when the tenancy frame has no narrowers", async () => {
    const skinny = buildTenancyContext({
      organizationId: ORG_A,
      actor: { userId: USER_ID, correlationId: CORRELATION_ID },
    });
    const result = await withTenancyContext(skinny, () =>
      storage.beginUpload({ organizationId: ORG_A, contentType: "image/jpeg", bytes: bytes("p2") })
    );

    const row = prisma.rows.get(result.uploadToken)!;
    expect(row.siteId).toBeNull();
    expect(row.clinicId).toBeNull();
  });

  it("respects a custom ttl override", async () => {
    const custom = new S3PackagePhotoStorage({
      s3,
      prisma: prisma as unknown as ConstructorParameters<typeof S3PackagePhotoStorage>[0]["prisma"],
      bucket: "pharmax-package-photos-prod",
      kmsKeyId: "alias/pharmax/package-photos",
      tokenTtlMs: 5_000,
      now: () => NOW,
    });
    const result = await withTenancyContext(ctx(ORG_A), () =>
      custom.beginUpload({ organizationId: ORG_A, contentType: "image/jpeg", bytes: bytes("p3") })
    );
    const row = prisma.rows.get(result.uploadToken)!;
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + 5_000);
  });
});

// ---------------------------------------------------------------------------
// beginUpload — failure modes.
// ---------------------------------------------------------------------------

describe("S3PackagePhotoStorage.beginUpload — failure modes", () => {
  it("throws when called outside a tenancy frame", async () => {
    await expect(
      storage.beginUpload({ organizationId: ORG_A, contentType: "image/jpeg", bytes: bytes("p") })
    ).rejects.toThrow(/S3_PACKAGE_PHOTO_STORAGE_NO_TENANCY/);

    expect(s3.calls).toHaveLength(0);
    expect(prisma.rows.size).toBe(0);
  });

  it("throws when input.organizationId mismatches the active tenancy frame", async () => {
    await expect(
      withTenancyContext(ctx(ORG_A), () =>
        storage.beginUpload({
          organizationId: ORG_B,
          contentType: "image/jpeg",
          bytes: bytes("p"),
        })
      )
    ).rejects.toThrow(/S3_PACKAGE_PHOTO_STORAGE_TENANCY_MISMATCH/);

    expect(s3.calls).toHaveLength(0);
    expect(prisma.rows.size).toBe(0);
  });

  it("does NOT persist a token row when S3 PutObject fails", async () => {
    s3.nextError = new Error("s3 down");

    await expect(
      withTenancyContext(ctx(ORG_A), () =>
        storage.beginUpload({
          organizationId: ORG_A,
          contentType: "image/jpeg",
          bytes: bytes("p4"),
        })
      )
    ).rejects.toThrow("s3 down");

    expect(s3.calls).toHaveLength(1);
    expect(prisma.rows.size).toBe(0);
  });

  it("leaves the S3 object orphaned (acceptable; janitor sweeps) when the DB INSERT fails", async () => {
    prisma.createShouldThrow = new Error("insert failed");

    await expect(
      withTenancyContext(ctx(ORG_A), () =>
        storage.beginUpload({
          organizationId: ORG_A,
          contentType: "image/jpeg",
          bytes: bytes("p5"),
        })
      )
    ).rejects.toThrow("insert failed");

    expect(s3.calls).toHaveLength(1);
    expect(prisma.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveUploadToken.
// ---------------------------------------------------------------------------

describe("S3PackagePhotoStorage.resolveUploadToken", () => {
  it("returns the storage tuple for a fresh token", async () => {
    const issued = await withTenancyContext(ctx(ORG_A), () =>
      storage.beginUpload({
        organizationId: ORG_A,
        contentType: "image/jpeg",
        bytes: bytes("p6"),
      })
    );

    const resolved = await storage.resolveUploadToken(issued.uploadToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.bucket).toBe("pharmax-package-photos-prod");
    expect(resolved!.key).toBe(issued.key);
    expect(resolved!.sha256).toBe(sha256HexOf("p6"));
    expect(resolved!.fileSize).toBe(2);
    expect(resolved!.contentType).toBe("image/jpeg");
    expect(resolved!.organizationId).toBe(ORG_A);
  });

  it("returns null for an unknown token (cross-tenant guess collapses here too)", async () => {
    const resolved = await storage.resolveUploadToken("00000000-0000-4000-8000-deadbeefdead");
    expect(resolved).toBeNull();
  });

  it("returns null for an expired token (gate is `expiresAt <= now`)", async () => {
    const issued = await withTenancyContext(ctx(ORG_A), () =>
      storage.beginUpload({
        organizationId: ORG_A,
        contentType: "image/jpeg",
        bytes: bytes("p7"),
      })
    );

    const future = new Date(NOW.getTime() + PACKAGE_PHOTO_UPLOAD_TTL_MS + 1);
    const expiredStorage = new S3PackagePhotoStorage({
      s3,
      prisma: prisma as unknown as ConstructorParameters<typeof S3PackagePhotoStorage>[0]["prisma"],
      bucket: "pharmax-package-photos-prod",
      kmsKeyId: "alias/pharmax/package-photos",
      now: () => future,
    });
    const resolved = await expiredStorage.resolveUploadToken(issued.uploadToken);
    expect(resolved).toBeNull();
  });

  it("applies system context (auditable bypass) — emits set_config calls", async () => {
    const issued = await withTenancyContext(ctx(ORG_A), () =>
      storage.beginUpload({
        organizationId: ORG_A,
        contentType: "image/jpeg",
        bytes: bytes("p8"),
      })
    );

    prisma.executedRawSqls.length = 0;
    await storage.resolveUploadToken(issued.uploadToken);

    expect(prisma.executedRawSqls.length).toBeGreaterThanOrEqual(2);
    expect(prisma.executedRawSqls.some((s) => s.includes("set_config"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: beginUpload → resolveUploadToken round-trip across orgs.
// ---------------------------------------------------------------------------

describe("S3PackagePhotoStorage — cross-org round-trip", () => {
  it("each org sees only its own upload metadata on resolveUploadToken", async () => {
    const a = await withTenancyContext(ctx(ORG_A), () =>
      storage.beginUpload({ organizationId: ORG_A, contentType: "image/jpeg", bytes: bytes("aa") })
    );
    const b = await withTenancyContext(ctx(ORG_B), () =>
      storage.beginUpload({ organizationId: ORG_B, contentType: "image/jpeg", bytes: bytes("bb") })
    );

    expect(a.uploadToken).not.toBe(b.uploadToken);

    const resolvedA = await storage.resolveUploadToken(a.uploadToken);
    const resolvedB = await storage.resolveUploadToken(b.uploadToken);

    expect(resolvedA?.organizationId).toBe(ORG_A);
    expect(resolvedB?.organizationId).toBe(ORG_B);
    expect(resolvedA?.key.startsWith(`org/${ORG_A}/`)).toBe(true);
    expect(resolvedB?.key.startsWith(`org/${ORG_B}/`)).toBe(true);
  });
});
