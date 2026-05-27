// Configure singleton — same shape as @pharmax/package-capture,
// @pharmax/notifications, and @pharmax/crypto. Pinning the contract
// here keeps the boot behaviour identical across packages.

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryDocumentStorage } from "./adapters/in-memory-document-storage.js";
import {
  configureDocumentStorage,
  getDocumentStorage,
  resetDocumentStorageConfigurationForTests,
} from "./configure.js";

afterEach(() => {
  resetDocumentStorageConfigurationForTests();
});

describe("configureDocumentStorage", () => {
  it("throws InternalError(DOCUMENTS_NOT_CONFIGURED) when unconfigured", () => {
    expect(() => getDocumentStorage()).toThrowError(
      expect.objectContaining({ code: "DOCUMENTS_NOT_CONFIGURED" })
    );
  });

  it("returns the configured storage", () => {
    const storage = new InMemoryDocumentStorage();
    configureDocumentStorage({ storage });
    expect(getDocumentStorage()).toBe(storage);
  });

  it("the second call replaces the first storage", () => {
    const a = new InMemoryDocumentStorage({ bucket: "a" });
    const b = new InMemoryDocumentStorage({ bucket: "b" });
    configureDocumentStorage({ storage: a });
    configureDocumentStorage({ storage: b });
    expect(getDocumentStorage()).toBe(b);
  });

  it("reset returns to the unconfigured state", () => {
    configureDocumentStorage({ storage: new InMemoryDocumentStorage() });
    resetDocumentStorageConfigurationForTests();
    expect(() => getDocumentStorage()).toThrowError(
      expect.objectContaining({ code: "DOCUMENTS_NOT_CONFIGURED" })
    );
  });
});
