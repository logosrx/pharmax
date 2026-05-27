// Behavioural tests for the in-memory adapter.
//
// The PHI tests exercise the @pharmax/crypto AAD-binding contract
// end-to-end: a wrong recordId at get() time surfaces as
// AAD_MISMATCH from the crypto layer, NOT a silent ciphertext
// return. Locking the contract here means a production S3 adapter
// inherits the proven shape — swap the bytes backend, keep the
// crypto wrapper.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalKmsAdapter,
  configureCrypto,
  resetCryptoConfigurationForTests,
  type RecordBinding,
} from "@pharmax/crypto";

import { InMemoryDocumentStorage } from "./in-memory-document-storage.js";

const TENANT_A = "org-doctest-aaaa-aaaa-aaaa-000000000001";
const TENANT_B = "org-doctest-bbbb-bbbb-bbbb-000000000002";

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "documents-test-seed" }) });
});

afterEach(() => {
  resetCryptoConfigurationForTests();
});

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function phiBinding(overrides: Partial<RecordBinding> = {}): RecordBinding {
  return {
    tenantId: TENANT_A,
    table: "prescription",
    column: "scan_image",
    recordId: "01JZ000000000000000000000P",
    ...overrides,
  };
}

describe("InMemoryDocumentStorage — non-PHI happy path", () => {
  it("PUBLIC: put → get round-trips the bytes", async () => {
    const storage = new InMemoryDocumentStorage();
    const payload = bytesOf("public press kit");

    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "PUBLIC",
      contentType: "application/pdf",
      bytes: payload,
    });

    expect(put.bucket).toBe("pharmax-documents-inmemory");
    expect(put.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(put.fileSize).toBe(payload.byteLength);

    const got = await storage.get(put.documentId);
    expect(new TextDecoder().decode(got.bytes)).toBe("public press kit");
    expect(got.classification).toBe("PUBLIC");
    expect(got.contentType).toBe("application/pdf");
  });

  it("INTERNAL: put records metadata + classification on list()", async () => {
    const storage = new InMemoryDocumentStorage();
    await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/markdown",
      bytes: bytesOf("# SOP v1"),
      metadata: { source: "sop-uploader" },
    });

    const listed = storage.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.tenantId).toBe(TENANT_A);
    expect(listed[0]?.classification).toBe("INTERNAL");
  });

  it("CONFIDENTIAL: accepts (but does not crypto-bind) an aadBinding", async () => {
    const storage = new InMemoryDocumentStorage();
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "CONFIDENTIAL",
      contentType: "application/pdf",
      bytes: bytesOf("invoice pdf"),
      aadBinding: phiBinding({ table: "invoice", column: "rendered_pdf" }),
    });

    // CONFIDENTIAL is stored as plaintext, so a get with NO
    // binding succeeds — the binding was record-keeping only.
    const got = await storage.get(put.documentId);
    expect(new TextDecoder().decode(got.bytes)).toBe("invoice pdf");
  });
});

describe("InMemoryDocumentStorage — PHI AAD-binding round-trip", () => {
  it("happy path: put + get with matching binding returns the original bytes", async () => {
    const storage = new InMemoryDocumentStorage();
    const binding = phiBinding();
    const payload = bytesOf("REDACTED-SYNTHETIC-PHI-IMAGE-BYTES");

    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "PHI",
      contentType: "image/png",
      bytes: payload,
      aadBinding: binding,
    });

    const got = await storage.get(put.documentId, { aadBinding: binding });
    expect(new TextDecoder().decode(got.bytes)).toBe("REDACTED-SYNTHETIC-PHI-IMAGE-BYTES");
    expect(got.classification).toBe("PHI");
  });

  it("PHI without aadBinding on put() throws DOCUMENT_AAD_BINDING_REQUIRED", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(
      storage.put({
        tenantId: TENANT_A,
        classification: "PHI",
        contentType: "image/png",
        bytes: bytesOf("x"),
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_AAD_BINDING_REQUIRED" });
  });

  it("PUBLIC with aadBinding on put() throws DOCUMENT_AAD_BINDING_UNEXPECTED", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(
      storage.put({
        tenantId: TENANT_A,
        classification: "PUBLIC",
        contentType: "text/plain",
        bytes: bytesOf("x"),
        aadBinding: phiBinding(),
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_AAD_BINDING_UNEXPECTED" });
  });

  it("PHI get() without aadBinding throws DOCUMENT_AAD_BINDING_REQUIRED", async () => {
    const storage = new InMemoryDocumentStorage();
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "PHI",
      contentType: "image/png",
      bytes: bytesOf("phi"),
      aadBinding: phiBinding(),
    });
    await expect(storage.get(put.documentId)).rejects.toMatchObject({
      code: "DOCUMENT_AAD_BINDING_REQUIRED",
    });
  });

  it("PHI get() with the wrong recordId surfaces AAD_MISMATCH from the crypto layer", async () => {
    const storage = new InMemoryDocumentStorage();
    const correct = phiBinding();
    const tampered = phiBinding({ recordId: "01JZ000000000000000000000X" });

    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "PHI",
      contentType: "image/png",
      bytes: bytesOf("phi"),
      aadBinding: correct,
    });

    await expect(storage.get(put.documentId, { aadBinding: tampered })).rejects.toMatchObject({
      code: "AAD_MISMATCH",
    });
  });

  it("PHI get() with a tenant mismatch throws DOCUMENT_TENANT_MISMATCH before crypto runs", async () => {
    const storage = new InMemoryDocumentStorage();
    const correct = phiBinding();
    const wrongTenant = phiBinding({ tenantId: TENANT_B });

    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "PHI",
      contentType: "image/png",
      bytes: bytesOf("phi"),
      aadBinding: correct,
    });

    await expect(storage.get(put.documentId, { aadBinding: wrongTenant })).rejects.toMatchObject({
      code: "DOCUMENT_TENANT_MISMATCH",
    });
  });

  it("PHI put() rejects when aadBinding.tenantId disagrees with input.tenantId", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(
      storage.put({
        tenantId: TENANT_A,
        classification: "PHI",
        contentType: "image/png",
        bytes: bytesOf("phi"),
        aadBinding: phiBinding({ tenantId: TENANT_B }),
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_TENANT_MISMATCH" });
  });
});

describe("InMemoryDocumentStorage — signUrl", () => {
  it("returns a URL with expiresAt = now + ttlSeconds", async () => {
    const fixedNow = new Date("2026-05-25T20:00:00.000Z");
    const storage = new InMemoryDocumentStorage({ now: () => fixedNow });
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/plain",
      bytes: bytesOf("x"),
    });

    const signed = await storage.signUrl(put.documentId, { ttlSeconds: 30 });
    expect(signed.expiresAt.toISOString()).toBe("2026-05-25T20:00:30.000Z");
    expect(signed.url).toContain(put.documentId);
  });

  it("encodes downloadFilename when provided", async () => {
    const storage = new InMemoryDocumentStorage();
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/plain",
      bytes: bytesOf("x"),
    });
    const signed = await storage.signUrl(put.documentId, {
      ttlSeconds: 30,
      downloadFilename: "report v1.txt",
    });
    expect(signed.url).toContain("filename=report%20v1.txt");
  });

  it("rejects ttlSeconds exceeding the classification ceiling", async () => {
    const storage = new InMemoryDocumentStorage();
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "PHI",
      contentType: "image/png",
      bytes: bytesOf("phi"),
      aadBinding: phiBinding(),
    });

    // PHI ceiling is 5 minutes.
    await expect(storage.signUrl(put.documentId, { ttlSeconds: 10 * 60 })).rejects.toMatchObject({
      code: "DOCUMENT_TTL_EXCEEDED",
    });
  });

  it("rejects zero / negative ttlSeconds with DOCUMENT_VALIDATION", async () => {
    const storage = new InMemoryDocumentStorage();
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/plain",
      bytes: bytesOf("x"),
    });
    await expect(storage.signUrl(put.documentId, { ttlSeconds: 0 })).rejects.toMatchObject({
      code: "DOCUMENT_VALIDATION",
    });
  });

  it("404s on unknown documentId", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(storage.signUrl("unknown-id", { ttlSeconds: 30 })).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });
});

describe("InMemoryDocumentStorage — delete + maintenance", () => {
  it("delete drops the document and a subsequent get 404s", async () => {
    const storage = new InMemoryDocumentStorage();
    const put = await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/plain",
      bytes: bytesOf("x"),
    });

    await storage.delete(put.documentId, { reason: "USER_REQUESTED" });

    expect(storage.size()).toBe(0);
    await expect(storage.get(put.documentId)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("delete on an unknown id 404s", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(storage.delete("nope", { reason: "ADMIN_PURGE" })).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("clear() drops everything and resets size()", async () => {
    const storage = new InMemoryDocumentStorage();
    await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/plain",
      bytes: bytesOf("x"),
    });
    expect(storage.size()).toBe(1);
    storage.clear();
    expect(storage.size()).toBe(0);
  });
});

describe("InMemoryDocumentStorage — input validation", () => {
  it("rejects empty tenantId", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(
      storage.put({
        tenantId: "",
        classification: "INTERNAL",
        contentType: "text/plain",
        bytes: bytesOf("x"),
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_VALIDATION" });
  });

  it("rejects unknown classification", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(
      storage.put({
        tenantId: TENANT_A,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        classification: "MIXED" as any,
        contentType: "text/plain",
        bytes: bytesOf("x"),
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_VALIDATION" });
  });

  it("rejects non-Uint8Array bytes", async () => {
    const storage = new InMemoryDocumentStorage();
    await expect(
      storage.put({
        tenantId: TENANT_A,
        classification: "INTERNAL",
        contentType: "text/plain",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: "not a buffer" as any,
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_VALIDATION" });
  });
});

describe("InMemoryDocumentStorage — failNext", () => {
  it("surfaces the queued failure on the next adapter call", async () => {
    const storage = new InMemoryDocumentStorage();
    storage.failNext({ code: "S3_5XX", message: "bucket down" });

    await expect(
      storage.put({
        tenantId: TENANT_A,
        classification: "INTERNAL",
        contentType: "text/plain",
        bytes: bytesOf("x"),
      })
    ).rejects.toMatchObject({ code: "S3_5XX" });

    // One-shot — the next call succeeds.
    const ok = await storage.put({
      tenantId: TENANT_A,
      classification: "INTERNAL",
      contentType: "text/plain",
      bytes: bytesOf("x"),
    });
    expect(ok.documentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("InMemoryDocumentStorage — tenant isolation", () => {
  it("PHI documents from different tenants get distinct keys + isolated KMS", async () => {
    const storage = new InMemoryDocumentStorage();
    const aBinding = phiBinding({ tenantId: TENANT_A });
    const bBinding = phiBinding({ tenantId: TENANT_B });

    const a = await storage.put({
      tenantId: TENANT_A,
      classification: "PHI",
      contentType: "image/png",
      bytes: bytesOf("phi-A"),
      aadBinding: aBinding,
    });
    const b = await storage.put({
      tenantId: TENANT_B,
      classification: "PHI",
      contentType: "image/png",
      bytes: bytesOf("phi-B"),
      aadBinding: bBinding,
    });

    expect(a.key).not.toBe(b.key);
    // Tenant A's binding cannot decrypt tenant B's document
    // (tenant mismatch fires before crypto).
    await expect(storage.get(b.documentId, { aadBinding: aBinding })).rejects.toMatchObject({
      code: "DOCUMENT_TENANT_MISMATCH",
    });
  });
});
