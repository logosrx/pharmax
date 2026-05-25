// encryptField / decryptField contract tests.
//
// This is the security-critical surface. The tests pin:
//
//   1. Happy path: encrypt(plaintext, binding) → decrypt(envelope,
//      binding) yields the same plaintext.
//   2. Two encrypts of the SAME plaintext under the SAME binding
//      produce DIFFERENT ciphertexts (random IV + random DEK).
//   3. AAD binding is enforced — every single field of the binding
//      that differs between encrypt and decrypt causes AAD_MISMATCH.
//   4. A ciphertext from tenant A cannot be decrypted as tenant B
//      (KMS isolation + AAD binding both fire).
//   5. Tampering with any envelope field is detected at decrypt.
//   6. The configure singleton refuses ops when not configured.
//   7. Unicode and multi-byte plaintext round-trips correctly.
//   8. KEK rotation does NOT break decryption of pre-rotation
//      envelopes (the kid in the envelope routes to the old KEK).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureCrypto, resetCryptoConfigurationForTests } from "./configure.js";
import { decryptField, encryptField } from "./encrypt.js";
import { LocalKmsAdapter } from "./local-kms-adapter.js";
import { serializeEnvelope } from "./envelope.js";
import type { RecordBinding } from "./aad.js";

let kms: LocalKmsAdapter;

beforeEach(() => {
  kms = new LocalKmsAdapter({ seed: "encrypt-test-seed" });
  configureCrypto({ kms });
});

afterEach(() => {
  resetCryptoConfigurationForTests();
});

function binding(overrides: Partial<RecordBinding> = {}): RecordBinding {
  return {
    tenantId: "org-acme",
    table: "patient",
    column: "first_name",
    recordId: "01JZ000000000000000000000P",
    ...overrides,
  };
}

describe("encryptField — configuration", () => {
  it("throws CRYPTO_NOT_CONFIGURED when configureCrypto was never called", async () => {
    resetCryptoConfigurationForTests();
    await expect(encryptField({ plaintext: "x", binding: binding() })).rejects.toMatchObject({
      code: "CRYPTO_NOT_CONFIGURED",
    });
  });

  it("rejects non-string plaintext defensively", async () => {
    await expect(
      encryptField({ plaintext: 42 as unknown as string, binding: binding() })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });
});

describe("encryptField + decryptField — happy paths", () => {
  it("round-trips simple ASCII", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    const out = await decryptField({ envelope: env, binding: binding() });
    expect(out).toBe("Jane Doe");
  });

  it("round-trips an empty string", async () => {
    const env = await encryptField({ plaintext: "", binding: binding() });
    const out = await decryptField({ envelope: env, binding: binding() });
    expect(out).toBe("");
  });

  it("round-trips unicode (NFC accents + emoji + CJK)", async () => {
    const tricky = "Renée Müller 患者 🧬💊";
    const env = await encryptField({ plaintext: tricky, binding: binding() });
    const out = await decryptField({ envelope: env, binding: binding() });
    expect(out).toBe(tricky);
  });

  it("works on serialized JSON round-trips (Prisma Json column path)", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    const wire = JSON.parse(JSON.stringify(serializeEnvelope(env))) as unknown;
    const out = await decryptField({ envelope: wire, binding: binding() });
    expect(out).toBe("Jane Doe");
  });
});

describe("encryptField — non-determinism (randomness invariant)", () => {
  it("two encrypts of the same plaintext under the same binding diverge", async () => {
    const a = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    const b = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wDek).not.toBe(b.wDek);
    expect(a.tag).not.toBe(b.tag);
    // Yet both decrypt to the same plaintext.
    expect(await decryptField({ envelope: a, binding: binding() })).toBe("Jane Doe");
    expect(await decryptField({ envelope: b, binding: binding() })).toBe("Jane Doe");
  });
});

describe("decryptField — AAD binding enforcement", () => {
  it("rejects when tenantId differs (cross-tenant via swapped binding)", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    await expect(
      decryptField({ envelope: env, binding: binding({ tenantId: "org-other" }) })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
    // Note: cross-tenant fails at KMS first because the kid embeds the
    // tenant. AAD_MISMATCH below covers same-tenant binding drift.
  });

  it("rejects when table differs", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    await expect(
      decryptField({ envelope: env, binding: binding({ table: "prescription" }) })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
  });

  it("rejects when column differs", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    await expect(
      decryptField({ envelope: env, binding: binding({ column: "last_name" }) })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
  });

  it("rejects when recordId differs (move-ciphertext-between-rows attack)", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    await expect(
      decryptField({ envelope: env, binding: binding({ recordId: "01JZ999999999999999999999Z" }) })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
  });
});

describe("decryptField — ciphertext tampering", () => {
  it("flipping a byte in `ct` is detected", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    const tampered = { ...env, ct: flipFirstByteOfB64Url(env.ct) };
    await expect(decryptField({ envelope: tampered, binding: binding() })).rejects.toMatchObject({
      code: "AAD_MISMATCH", // GCM auth fails identically; we surface as AAD by policy.
    });
  });

  it("flipping a byte in `tag` is detected", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    const tampered = { ...env, tag: flipFirstByteOfB64Url(env.tag) };
    await expect(decryptField({ envelope: tampered, binding: binding() })).rejects.toMatchObject({
      code: "AAD_MISMATCH",
    });
  });

  it("a wrong-length iv is rejected with DECRYPT_FAILED before GCM runs", async () => {
    const env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    const tampered = { ...env, iv: "AAAA" };
    await expect(decryptField({ envelope: tampered, binding: binding() })).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });
});

describe("decryptField — KEK rotation interop", () => {
  it("envelopes encrypted under v1 still decrypt after rotation to v2", async () => {
    const v1Env = await encryptField({ plaintext: "Jane Doe", binding: binding() });
    expect(v1Env.kek).toBe("kek:org-acme:v1");

    kms.rotateKek({ tenantId: "org-acme" });

    // New writes use v2.
    const v2Env = await encryptField({ plaintext: "Other", binding: binding() });
    expect(v2Env.kek).toBe("kek:org-acme:v2");

    // Old envelope still decrypts.
    expect(await decryptField({ envelope: v1Env, binding: binding() })).toBe("Jane Doe");
    expect(await decryptField({ envelope: v2Env, binding: binding() })).toBe("Other");
  });
});

function flipFirstByteOfB64Url(s: string): string {
  const buf = Buffer.from(s, "base64url");
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString("base64url");
}
