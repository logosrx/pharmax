// LocalKmsAdapter tests.
//
// What we pin about the local adapter:
//   - Determinism with the same seed (essential for tests that need
//     stable derived material across processes).
//   - Different seeds produce different KEKs/DEKs.
//   - Different tenants are cryptographically isolated.
//   - Wrap → unwrap round-trips correctly.
//   - A DEK wrapped under tenant A cannot be unwrapped as tenant B.
//   - KEK rotation increments the kid; old kids still unwrap.
//   - Search keys are deterministic per (tenant, purpose) and
//     independent of KEKs (KEK rotation doesn't break blind indexes).
//   - Empty / non-string inputs are rejected loudly.

import { describe, expect, it } from "vitest";

import { LocalKmsAdapter, hmacSha256, timingSafeEqualBuffers } from "./local-kms-adapter.js";

const SEED = "pharmax.test.seed.deterministic";

function freshAdapter(seed: string = SEED): LocalKmsAdapter {
  return new LocalKmsAdapter({ seed });
}

describe("LocalKmsAdapter — construction", () => {
  it("accepts a string seed", () => {
    expect(() => new LocalKmsAdapter({ seed: "test" })).not.toThrow();
  });

  it("accepts a Buffer seed", () => {
    expect(() => new LocalKmsAdapter({ seed: Buffer.from("test", "utf8") })).not.toThrow();
  });

  it("rejects an empty seed", () => {
    expect(() => new LocalKmsAdapter({ seed: "" })).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
    expect(() => new LocalKmsAdapter({ seed: Buffer.alloc(0) })).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });
});

describe("LocalKmsAdapter — generateDataKey + unwrapDataKey", () => {
  it("round-trips: wrapped DEK unwraps to the same plaintext DEK", async () => {
    const kms = freshAdapter();
    const generated = await kms.generateDataKey({ tenantId: "org-1" });
    const unwrapped = await kms.unwrapDataKey({
      tenantId: "org-1",
      kid: generated.kid,
      wrappedDek: generated.wrappedDek,
    });
    expect(timingSafeEqualBuffers(unwrapped, generated.plaintextDek)).toBe(true);
  });

  it("generates a different DEK every call (random)", async () => {
    const kms = freshAdapter();
    const a = await kms.generateDataKey({ tenantId: "org-1" });
    const b = await kms.generateDataKey({ tenantId: "org-1" });
    expect(a.plaintextDek.equals(b.plaintextDek)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("returns plaintextDek of 32 bytes", async () => {
    const kms = freshAdapter();
    const generated = await kms.generateDataKey({ tenantId: "org-1" });
    expect(generated.plaintextDek.length).toBe(32);
  });

  it("kid encodes the tenant + version", async () => {
    const kms = freshAdapter();
    const generated = await kms.generateDataKey({ tenantId: "org-1" });
    expect(generated.kid).toBe("kek:org-1:v1");
  });
});

describe("LocalKmsAdapter — tenant isolation", () => {
  it("a wrapped DEK from tenant A cannot be unwrapped as tenant B", async () => {
    const kms = freshAdapter();
    const generated = await kms.generateDataKey({ tenantId: "org-A" });
    await expect(
      kms.unwrapDataKey({
        tenantId: "org-B",
        kid: generated.kid,
        wrappedDek: generated.wrappedDek,
      })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("two tenants get different derived KEKs (different ciphertexts for same DEK)", async () => {
    const kms = freshAdapter();
    const a = await kms.generateDataKey({ tenantId: "org-A" });
    const b = await kms.generateDataKey({ tenantId: "org-B" });
    expect(a.kid).not.toBe(b.kid);
    // The wrapped-byte distributions diverge because the KEK differs.
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });
});

describe("LocalKmsAdapter — determinism across instances", () => {
  it("same seed + same tenant + same purpose → same search key", async () => {
    const kmsA = freshAdapter();
    const kmsB = freshAdapter();
    const keyA = await kmsA.deriveSearchKey({ tenantId: "org-1", purpose: "patient.first_name" });
    const keyB = await kmsB.deriveSearchKey({ tenantId: "org-1", purpose: "patient.first_name" });
    expect(timingSafeEqualBuffers(keyA, keyB)).toBe(true);
  });

  it("different seeds → different search keys (KEK isolation)", async () => {
    const a = freshAdapter("seed-A");
    const b = freshAdapter("seed-B");
    const keyA = await a.deriveSearchKey({ tenantId: "org-1", purpose: "patient.first_name" });
    const keyB = await b.deriveSearchKey({ tenantId: "org-1", purpose: "patient.first_name" });
    expect(keyA.equals(keyB)).toBe(false);
  });

  it("different purposes → different search keys (purpose isolation)", async () => {
    const kms = freshAdapter();
    const a = await kms.deriveSearchKey({ tenantId: "org-1", purpose: "patient.first_name" });
    const b = await kms.deriveSearchKey({ tenantId: "org-1", purpose: "patient.last_name" });
    expect(a.equals(b)).toBe(false);
  });

  it("different tenants → different search keys (tenant isolation)", async () => {
    const kms = freshAdapter();
    const a = await kms.deriveSearchKey({ tenantId: "org-1", purpose: "patient.first_name" });
    const b = await kms.deriveSearchKey({ tenantId: "org-2", purpose: "patient.first_name" });
    expect(a.equals(b)).toBe(false);
  });
});

describe("LocalKmsAdapter — KEK rotation", () => {
  it("rotate bumps the kid version and currentKid reflects it", async () => {
    const kms = freshAdapter();
    expect(await kms.currentKid({ tenantId: "org-1" })).toBe("kek:org-1:v1");
    const after = kms.rotateKek({ tenantId: "org-1" });
    expect(after.kid).toBe("kek:org-1:v2");
    expect(await kms.currentKid({ tenantId: "org-1" })).toBe("kek:org-1:v2");
  });

  it("DEKs wrapped under the OLD kid still unwrap after rotation", async () => {
    const kms = freshAdapter();
    const old = await kms.generateDataKey({ tenantId: "org-1" });
    kms.rotateKek({ tenantId: "org-1" });
    const newDek = await kms.generateDataKey({ tenantId: "org-1" });
    expect(newDek.kid).toBe("kek:org-1:v2");
    // Old envelope still works.
    const unwrapped = await kms.unwrapDataKey({
      tenantId: "org-1",
      kid: old.kid,
      wrappedDek: old.wrappedDek,
    });
    expect(timingSafeEqualBuffers(unwrapped, old.plaintextDek)).toBe(true);
  });

  it("KEK rotation does NOT change the per-tenant search key", async () => {
    const kms = freshAdapter();
    const before = await kms.deriveSearchKey({
      tenantId: "org-1",
      purpose: "patient.first_name",
    });
    kms.rotateKek({ tenantId: "org-1" });
    const after = await kms.deriveSearchKey({
      tenantId: "org-1",
      purpose: "patient.first_name",
    });
    expect(timingSafeEqualBuffers(before, after)).toBe(true);
  });
});

describe("LocalKmsAdapter — input validation", () => {
  it("rejects empty tenantId", async () => {
    const kms = freshAdapter();
    await expect(kms.generateDataKey({ tenantId: "" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
    await expect(kms.deriveSearchKey({ tenantId: "", purpose: "x" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
  });

  it("rejects empty purpose", async () => {
    const kms = freshAdapter();
    await expect(kms.deriveSearchKey({ tenantId: "org-1", purpose: "" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
  });

  it("rejects unparseable kid", async () => {
    const kms = freshAdapter();
    await expect(
      kms.unwrapDataKey({
        tenantId: "org-1",
        kid: "not-a-valid-kid",
        wrappedDek: Buffer.alloc(60),
      })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("rejects wrappedDek with wrong length", async () => {
    const kms = freshAdapter();
    await expect(
      kms.unwrapDataKey({
        tenantId: "org-1",
        kid: "kek:org-1:v1",
        wrappedDek: Buffer.alloc(10),
      })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });
});

describe("hmacSha256 helper", () => {
  it("produces 32-byte HMAC-SHA256 output", () => {
    const out = hmacSha256(Buffer.alloc(32, 0xaa), Buffer.from("hello", "utf8"));
    expect(out.length).toBe(32);
  });

  it("is deterministic", () => {
    const a = hmacSha256(Buffer.alloc(32, 0xaa), Buffer.from("hello", "utf8"));
    const b = hmacSha256(Buffer.alloc(32, 0xaa), Buffer.from("hello", "utf8"));
    expect(timingSafeEqualBuffers(a, b)).toBe(true);
  });
});
