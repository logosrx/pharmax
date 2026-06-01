import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryPackagePhotoStorage } from "./in-memory-package-photo-storage.js";

const ORG_A = "org-a-0000-0000-0000-000000000000";
const ORG_B = "org-b-0000-0000-0000-000000000000";

function bytes(payload: string): Uint8Array {
  return new TextEncoder().encode(payload);
}

function expectedSha256(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

describe("InMemoryPackagePhotoStorage.beginUpload", () => {
  it("computes sha256 + fileSize and returns an org-prefixed key", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const payload = "fake jpeg bytes 0xFFD8FFE0";

    const result = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/jpeg",
      bytes: bytes(payload),
    });

    expect(result.bucket).toBe("pharmax-package-photos-inmemory");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.sha256).toBe(expectedSha256(payload));
    expect(result.fileSize).toBe(bytes(payload).byteLength);
    expect(result.key).toBe(`org/${ORG_A}/photo/${result.sha256}`);
    expect(result.uploadToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("respects a custom bucket name", async () => {
    const storage = new InMemoryPackagePhotoStorage({ bucket: "custom-bucket" });
    const result = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/png",
      bytes: bytes("png bytes"),
    });
    expect(result.bucket).toBe("custom-bucket");
  });
});

describe("InMemoryPackagePhotoStorage.resolveUploadToken", () => {
  it("returns the resolved upload metadata for a known token", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const upload = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/jpeg",
      bytes: bytes("photo-1"),
    });

    const resolved = await storage.resolveUploadToken(upload.uploadToken);

    expect(resolved).not.toBeNull();
    expect(resolved!.bucket).toBe(upload.bucket);
    expect(resolved!.key).toBe(upload.key);
    expect(resolved!.sha256).toBe(upload.sha256);
    expect(resolved!.fileSize).toBe(upload.fileSize);
    expect(resolved!.contentType).toBe(upload.contentType);
    expect(resolved!.organizationId).toBe(ORG_A);
  });

  it("returns null for an unknown token", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    expect(await storage.resolveUploadToken("not-a-real-token")).toBeNull();
  });

  it("isolates orgs by organizationId on the resolved token", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const a = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/jpeg",
      bytes: bytes("photo-a"),
    });
    const b = await storage.beginUpload({
      organizationId: ORG_B,
      contentType: "image/jpeg",
      bytes: bytes("photo-b"),
    });

    const resolvedA = await storage.resolveUploadToken(a.uploadToken);
    const resolvedB = await storage.resolveUploadToken(b.uploadToken);

    expect(resolvedA!.organizationId).toBe(ORG_A);
    expect(resolvedB!.organizationId).toBe(ORG_B);
    expect(resolvedA!.key).not.toBe(resolvedB!.key);
  });
});

describe("InMemoryPackagePhotoStorage maintenance helpers", () => {
  it("size + getBytesByKey + clear behave consistently", async () => {
    const storage = new InMemoryPackagePhotoStorage();

    expect(storage.size()).toBe(0);

    const upload = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/jpeg",
      bytes: bytes("readback"),
    });

    expect(storage.size()).toBe(1);
    const readBack = storage.getBytesByKey(upload.key);
    expect(readBack).toBeDefined();
    expect(new TextDecoder().decode(readBack!)).toBe("readback");

    storage.clear();
    expect(storage.size()).toBe(0);
    expect(await storage.resolveUploadToken(upload.uploadToken)).toBeNull();
    expect(storage.getBytesByKey(upload.key)).toBeUndefined();
  });
});

describe("InMemoryPackagePhotoStorage.readObject", () => {
  it("returns the bytes + content type for a known (org, bucket, key)", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const upload = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/png",
      bytes: bytes("the-pixels"),
    });

    const got = await storage.readObject({
      organizationId: ORG_A,
      bucket: upload.bucket,
      key: upload.key,
    });

    expect(got).not.toBeNull();
    expect(got!.contentType).toBe("image/png");
    expect(new TextDecoder().decode(got!.bytes)).toBe("the-pixels");
  });

  it("returns null for an unknown key", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const got = await storage.readObject({
      organizationId: ORG_A,
      bucket: "pharmax-package-photos-inmemory",
      key: "org/org-a-0000-0000-0000-000000000000/photo/does-not-exist",
    });
    expect(got).toBeNull();
  });

  it("refuses to serve bytes when the requesting org does not match the entry", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const upload = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/jpeg",
      bytes: bytes("org-a-bytes"),
    });
    // Same key, but a different org asks for it → not-found.
    const got = await storage.readObject({
      organizationId: ORG_B,
      bucket: upload.bucket,
      key: upload.key,
    });
    expect(got).toBeNull();
  });

  it("refuses to serve bytes when the bucket does not match the entry", async () => {
    const storage = new InMemoryPackagePhotoStorage();
    const upload = await storage.beginUpload({
      organizationId: ORG_A,
      contentType: "image/jpeg",
      bytes: bytes("bucket-mismatch"),
    });
    const got = await storage.readObject({
      organizationId: ORG_A,
      bucket: "some-other-bucket",
      key: upload.key,
    });
    expect(got).toBeNull();
  });
});
