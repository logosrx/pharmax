import { afterEach, describe, expect, it } from "vitest";

import {
  configurePackagePhotoStorage,
  getPackagePhotoStorage,
  resetPackagePhotoStorageConfigurationForTests,
} from "./configure.js";
import { InMemoryPackagePhotoStorage } from "./in-memory-package-photo-storage.js";

afterEach(() => {
  resetPackagePhotoStorageConfigurationForTests();
});

describe("configurePackagePhotoStorage", () => {
  it("throws InternalError(PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED) when unconfigured", () => {
    expect(() => getPackagePhotoStorage()).toThrowError(
      expect.objectContaining({ code: "PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED" })
    );
  });

  it("returns the configured adapter", () => {
    const storage = new InMemoryPackagePhotoStorage();
    configurePackagePhotoStorage({ storage });
    expect(getPackagePhotoStorage()).toBe(storage);
  });

  it("the second call replaces the first adapter", () => {
    const a = new InMemoryPackagePhotoStorage({ bucket: "a" });
    const b = new InMemoryPackagePhotoStorage({ bucket: "b" });
    configurePackagePhotoStorage({ storage: a });
    configurePackagePhotoStorage({ storage: b });
    expect(getPackagePhotoStorage()).toBe(b);
  });

  it("reset returns to the unconfigured state", () => {
    configurePackagePhotoStorage({ storage: new InMemoryPackagePhotoStorage() });
    resetPackagePhotoStorageConfigurationForTests();
    expect(() => getPackagePhotoStorage()).toThrowError(
      expect.objectContaining({ code: "PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED" })
    );
  });
});
