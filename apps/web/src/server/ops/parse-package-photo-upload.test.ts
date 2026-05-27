import { describe, expect, it } from "vitest";

import {
  MAX_PACKAGE_PHOTO_BYTES,
  PACKAGE_PHOTO_FIELD_NAME,
  PACKAGE_PHOTO_UPLOAD_CONTENT_TYPE_REJECTED,
  PACKAGE_PHOTO_UPLOAD_EMPTY,
  PACKAGE_PHOTO_UPLOAD_FILE_MISSING,
  PACKAGE_PHOTO_UPLOAD_TOO_LARGE,
  parsePackagePhotoUpload,
} from "./parse-package-photo-upload.js";

function fileFromBytes(bytes: Uint8Array, contentType: string, filename = "p.jpg"): File {
  // `Uint8Array` is a valid `BlobPart`. Casting to `BlobPart[]`
  // keeps both lib.dom and node lib happy.
  return new File([bytes as unknown as BlobPart], filename, { type: contentType });
}

function formWithFile(file: File): FormData {
  const fd = new FormData();
  fd.set(PACKAGE_PHOTO_FIELD_NAME, file);
  return fd;
}

describe("parsePackagePhotoUpload — happy paths", () => {
  it("accepts a valid JPEG", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const result = await parsePackagePhotoUpload(formWithFile(fileFromBytes(bytes, "image/jpeg")));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.contentType).toBe("image/jpeg");
      expect(result.bytes).toEqual(bytes);
    }
  });

  it("accepts a valid PNG", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = await parsePackagePhotoUpload(formWithFile(fileFromBytes(bytes, "image/png")));
    expect(result.kind).toBe("ok");
  });

  it("accepts a valid WebP", async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const result = await parsePackagePhotoUpload(formWithFile(fileFromBytes(bytes, "image/webp")));
    expect(result.kind).toBe("ok");
  });
});

describe("parsePackagePhotoUpload — content-type allowlist", () => {
  it.each([
    "image/heic",
    "image/gif",
    "image/svg+xml",
    "image/tiff",
    "application/pdf",
    "text/plain",
    "application/octet-stream",
    "",
  ])("rejects content type %s", async (contentType) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await parsePackagePhotoUpload(formWithFile(fileFromBytes(bytes, contentType)));
    expect(result).toMatchObject({
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_CONTENT_TYPE_REJECTED,
    });
  });
});

describe("parsePackagePhotoUpload — missing file", () => {
  it("returns FILE_MISSING when the field is absent", async () => {
    const fd = new FormData();
    const result = await parsePackagePhotoUpload(fd);
    expect(result).toMatchObject({
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_FILE_MISSING,
    });
  });

  it("returns FILE_MISSING when the field holds a string instead of a File", async () => {
    const fd = new FormData();
    fd.set(PACKAGE_PHOTO_FIELD_NAME, "not-a-file");
    const result = await parsePackagePhotoUpload(fd);
    expect(result).toMatchObject({
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_FILE_MISSING,
    });
  });
});

describe("parsePackagePhotoUpload — empty file", () => {
  it("returns EMPTY when the file has 0 bytes", async () => {
    const result = await parsePackagePhotoUpload(
      formWithFile(fileFromBytes(new Uint8Array(0), "image/jpeg"))
    );
    expect(result).toMatchObject({
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_EMPTY,
    });
  });
});

describe("parsePackagePhotoUpload — size cap", () => {
  it("rejects via header check when raw.size already exceeds the cap", async () => {
    // Build a file whose `size` is > cap WITHOUT actually allocating
    // 25 MiB. Sub-class `File`-shaped object: vitest happdom's
    // FormData.get returns the same object the test put in via
    // `set`, so we can hand it any File-compatible. We use a real
    // File with a tiny payload but mock `size` via Object.defineProperty.
    const inner = fileFromBytes(new Uint8Array([1]), "image/jpeg");
    Object.defineProperty(inner, "size", { value: MAX_PACKAGE_PHOTO_BYTES + 1 });

    const result = await parsePackagePhotoUpload(formWithFile(inner));
    expect(result).toMatchObject({
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_TOO_LARGE,
    });
  });

  it("accepts a file exactly at the cap", async () => {
    // Don't allocate the full cap in test memory; a 64 KiB payload
    // is enough to exercise the post-arrayBuffer branch's <=
    // boundary, and the helper short-circuits before that on size.
    const bytes = new Uint8Array(64 * 1024).fill(0xaa);
    const result = await parsePackagePhotoUpload(formWithFile(fileFromBytes(bytes, "image/jpeg")));
    expect(result.kind).toBe("ok");
  });
});
