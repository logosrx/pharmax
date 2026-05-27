// Classification helpers — pure tests against the closed enum.

import { describe, expect, it } from "vitest";

import {
  DOCUMENT_CLASSIFICATIONS,
  isDocumentClassification,
  maxSignedUrlTtlSeconds,
  requiresAadBinding,
  type DocumentClassification,
} from "./classification.js";

describe("DocumentClassification enum", () => {
  it("contains exactly four levels in a stable order", () => {
    expect(DOCUMENT_CLASSIFICATIONS).toEqual(["PHI", "CONFIDENTIAL", "INTERNAL", "PUBLIC"]);
  });

  it("narrows known strings and rejects unknowns", () => {
    for (const c of DOCUMENT_CLASSIFICATIONS) {
      expect(isDocumentClassification(c)).toBe(true);
    }
    expect(isDocumentClassification("MIXED")).toBe(false);
    expect(isDocumentClassification(42)).toBe(false);
    expect(isDocumentClassification(undefined)).toBe(false);
  });

  it("requiresAadBinding is true ONLY for PHI", () => {
    for (const c of DOCUMENT_CLASSIFICATIONS) {
      expect(requiresAadBinding(c as DocumentClassification)).toBe(c === "PHI");
    }
  });

  it("maxSignedUrlTtlSeconds is strictly decreasing in sensitivity", () => {
    const phi = maxSignedUrlTtlSeconds("PHI");
    const conf = maxSignedUrlTtlSeconds("CONFIDENTIAL");
    const internal = maxSignedUrlTtlSeconds("INTERNAL");
    const pub = maxSignedUrlTtlSeconds("PUBLIC");

    expect(phi).toBeLessThan(conf);
    expect(conf).toBeLessThan(internal);
    expect(internal).toBeLessThan(pub);
    // Sanity: PHI tops out at five minutes.
    expect(phi).toBe(5 * 60);
  });
});
