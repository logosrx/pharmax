// Contract tests for `getPackagePhotoStorageDescriptor`.
//
// Asserts:
//   - Scoped to (organizationId, photoId).
//   - Projects ONLY structural storage fields (no notesEnc, no
//     matched ids).
//   - Maps the row to the descriptor + freezes it.
//   - Returns null on a tenancy / id miss.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PHOTO_ID = "00000000-0000-4000-8000-0000000000f1";

const prismaMock = {
  packagePhoto: { findFirst: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

const { getPackagePhotoStorageDescriptor } = await import("./get-package-photo-descriptor.js");

afterEach(() => vi.clearAllMocks());

describe("getPackagePhotoStorageDescriptor", () => {
  it("scopes the lookup to (organizationId, photoId) with a structural-only select", async () => {
    prismaMock.packagePhoto.findFirst.mockResolvedValueOnce(null);
    await getPackagePhotoStorageDescriptor({ organizationId: ORG_ID, photoId: PHOTO_ID });

    const call = prismaMock.packagePhoto.findFirst.mock.calls[0]![0]!;
    expect(call.where).toEqual({ id: PHOTO_ID, organizationId: ORG_ID });
    expect("notesEnc" in call.select).toBe(false);
    expect("matchedOrderId" in call.select).toBe(false);
    expect("matchedPatientId" in call.select).toBe(false);
  });

  it("maps the row to a frozen descriptor", async () => {
    prismaMock.packagePhoto.findFirst.mockResolvedValueOnce({
      id: PHOTO_ID,
      storageBucket: "pharmax-package-photos-prod",
      storageKey: `org/${ORG_ID}/photo/upload/tok-1`,
      contentType: "image/jpeg",
      fileSize: 23_456,
      sha256: "feedface0001",
    });

    const out = await getPackagePhotoStorageDescriptor({
      organizationId: ORG_ID,
      photoId: PHOTO_ID,
    });

    expect(out).not.toBeNull();
    expect(out!.photoId).toBe(PHOTO_ID);
    expect(out!.bucket).toBe("pharmax-package-photos-prod");
    expect(out!.key).toBe(`org/${ORG_ID}/photo/upload/tok-1`);
    expect(out!.contentType).toBe("image/jpeg");
    expect(out!.fileSize).toBe(23_456);
    expect(out!.sha256).toBe("feedface0001");
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("returns null when the photo is not in the tenant", async () => {
    prismaMock.packagePhoto.findFirst.mockResolvedValueOnce(null);
    const out = await getPackagePhotoStorageDescriptor({
      organizationId: ORG_ID,
      photoId: PHOTO_ID,
    });
    expect(out).toBeNull();
  });
});
