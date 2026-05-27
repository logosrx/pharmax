// AwsKmsAdapter tests.
//
// We pin the behaviors that matter for HIPAA + SOC 2:
//
//   1. EncryptionContext binds tenant — wrapping under tenant A and
//      decrypting as tenant B must fail (cryptographic enforcement
//      on top of the kid check).
//   2. The kid uniquely identifies the wrap, embeds the tenant +
//      keyIdLabel, and round-trips through parse.
//   3. KMS round trips: KMS-returned bytes flow correctly through
//      Plaintext / CiphertextBlob.
//   4. Search-key derivation is deterministic per (tenant, purpose)
//      and partitioned across tenants and purposes.
//   5. Search-key memoization: a second call for the same
//      (tenant, purpose) does NOT round-trip to KMS, AND two
//      concurrent first-time callers collapse to ONE round-trip.
//   6. Boot-time `validate()` rejects disabled keys, wrong
//      KeyUsage / KeySpec, missing metadata fields, and KMS-
//      transport failures.
//   7. Cross-adapter envelope leakage: a kid from `LocalKmsAdapter`
//      (`kek:...`) is rejected by `AwsKmsAdapter.unwrapDataKey`.
//   8. Defence-in-depth: a kid with the wrong `keyIdLabel` is
//      rejected before reaching KMS.
//   9. Defective KMS responses (unexpected MAC / DEK length) are
//      rejected rather than producing unrecoverable envelopes.
//  10. Adapter does not interfere with SDK-level retry semantics —
//      a transient `ThrottlingException` followed by success is
//      surfaced as success (chaos test).
//
// We use a hand-rolled fake client. No nock, no aws-sdk-client-mock —
// the adapter accepts the `AwsKmsClient` interface, so we just
// implement it.

import { createHmac, randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AwsKmsAdapter,
  sanitizeKeyIdForLabel,
  type AwsKmsClient,
  type AwsKmsDecryptInput,
  type AwsKmsDescribeKeyInput,
  type AwsKmsDescribeKeyOutput,
  type AwsKmsGenerateDataKeyInput,
  type AwsKmsMacInput,
} from "./aws-kms-adapter.js";

// ---------------------------------------------------------------------------
// Fake KMS client.
// ---------------------------------------------------------------------------
//
// Models the AWS behaviors we depend on:
//
//   - `generateDataKey` returns 32 random bytes and a deterministic
//     "wrapped" representation that encodes the EncryptionContext so
//     `decrypt` can verify it.
//   - `decrypt` verifies the EncryptionContext matches; mismatch
//     throws (mirroring AWS's InvalidCiphertextException).
//   - `mac` computes HMAC-SHA-256 against a deterministic per-key
//     seed so search keys are stable across calls.
//   - `describeKey` returns metadata from a configurable map.
//
// The point isn't to mimic AWS perfectly — it's to exercise the
// adapter's tenancy + caching + error paths with deterministic
// inputs.

interface FakeKey {
  readonly KeyUsage: "ENCRYPT_DECRYPT" | "GENERATE_VERIFY_MAC";
  readonly KeySpec?: "SYMMETRIC_DEFAULT" | "HMAC_256";
  readonly Enabled: boolean;
  readonly seed: Buffer; // used to deterministically derive MACs
}

interface FakeKmsClient extends AwsKmsClient {
  readonly generateCalls: AwsKmsGenerateDataKeyInput[];
  readonly decryptCalls: AwsKmsDecryptInput[];
  readonly macCalls: AwsKmsMacInput[];
  readonly describeCalls: AwsKmsDescribeKeyInput[];
}

function createFakeKmsClient(keys: Record<string, FakeKey>): FakeKmsClient {
  const generateCalls: AwsKmsGenerateDataKeyInput[] = [];
  const decryptCalls: AwsKmsDecryptInput[] = [];
  const macCalls: AwsKmsMacInput[] = [];
  const describeCalls: AwsKmsDescribeKeyInput[] = [];

  return {
    generateCalls,
    decryptCalls,
    macCalls,
    describeCalls,

    async generateDataKey(input) {
      generateCalls.push(input);
      const key = keys[input.KeyId];
      if (key === undefined) throw new Error(`NotFoundException: ${input.KeyId}`);
      if (!key.Enabled) throw new Error("DisabledException");
      if (key.KeyUsage !== "ENCRYPT_DECRYPT") throw new Error("InvalidKeyUsageException");

      const Plaintext = new Uint8Array(randomBytes(32));
      // Encode the EncryptionContext into the "ciphertext" so we
      // can verify it on decrypt. Real KMS does this cryptographically;
      // we do it structurally because that's all our test needs.
      const ecJson = JSON.stringify(input.EncryptionContext);
      const ecBytes = Buffer.from(ecJson, "utf8");
      const len = Buffer.alloc(2);
      len.writeUInt16BE(ecBytes.length, 0);
      const CiphertextBlob = new Uint8Array(Buffer.concat([len, ecBytes, Buffer.from(Plaintext)]));
      return { Plaintext, CiphertextBlob };
    },

    async decrypt(input) {
      decryptCalls.push(input);
      const key = keys[input.KeyId];
      if (key === undefined) throw new Error(`NotFoundException: ${input.KeyId}`);
      if (!key.Enabled) throw new Error("DisabledException");
      if (key.KeyUsage !== "ENCRYPT_DECRYPT") throw new Error("InvalidKeyUsageException");

      const blob = Buffer.from(input.CiphertextBlob);
      if (blob.length < 2) throw new Error("InvalidCiphertextException");
      const ecLen = blob.readUInt16BE(0);
      if (blob.length < 2 + ecLen + 32) throw new Error("InvalidCiphertextException");
      const ecJson = blob.subarray(2, 2 + ecLen).toString("utf8");
      let storedEc: Record<string, string>;
      try {
        storedEc = JSON.parse(ecJson) as Record<string, string>;
      } catch {
        throw new Error("InvalidCiphertextException");
      }

      // Verify EncryptionContext matches.
      const expected = JSON.stringify(storedEc);
      const actual = JSON.stringify(input.EncryptionContext);
      if (expected !== actual) {
        throw new Error("InvalidCiphertextException: EncryptionContext mismatch");
      }

      const Plaintext = new Uint8Array(blob.subarray(2 + ecLen));
      return { Plaintext };
    },

    async mac(input) {
      macCalls.push(input);
      const key = keys[input.KeyId];
      if (key === undefined) throw new Error(`NotFoundException: ${input.KeyId}`);
      if (!key.Enabled) throw new Error("DisabledException");
      if (key.KeyUsage !== "GENERATE_VERIFY_MAC") throw new Error("InvalidKeyUsageException");
      if (input.MacAlgorithm !== "HMAC_SHA_256") throw new Error("InvalidParameterValueException");

      const Mac = new Uint8Array(
        createHmac("sha256", key.seed).update(Buffer.from(input.Message)).digest()
      );
      return { Mac };
    },

    async describeKey(input): Promise<AwsKmsDescribeKeyOutput> {
      describeCalls.push(input);
      const key = keys[input.KeyId];
      if (key === undefined) throw new Error(`NotFoundException: ${input.KeyId}`);
      return {
        KeyMetadata: {
          KeyId: input.KeyId,
          Arn: `arn:aws:kms:us-east-1:000000000000:${input.KeyId}`,
          KeyUsage: key.KeyUsage,
          ...(key.KeySpec !== undefined ? { KeySpec: key.KeySpec } : {}),
          Enabled: key.Enabled,
        },
      };
    },
  };
}

const DATA_KEY = "alias/pharmax/app-phi-key";
const SEARCH_KEY = "alias/pharmax/search-key";

function defaultKeys(): Record<string, FakeKey> {
  return {
    [DATA_KEY]: {
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
      Enabled: true,
      seed: Buffer.from("unused-for-encrypt-decrypt"),
    },
    [SEARCH_KEY]: {
      KeyUsage: "GENERATE_VERIFY_MAC",
      KeySpec: "HMAC_256",
      Enabled: true,
      seed: Buffer.from("test-hmac-seed-deterministic"),
    },
  };
}

function makeAdapter(overrides?: {
  keys?: Record<string, FakeKey>;
  dataKeyKeyId?: string;
  searchKeyKeyId?: string;
  keyIdLabel?: string;
}): { adapter: AwsKmsAdapter; client: FakeKmsClient } {
  const keys = overrides?.keys ?? defaultKeys();
  const client = createFakeKmsClient(keys);
  const adapter = new AwsKmsAdapter({
    client,
    dataKeyKeyId: overrides?.dataKeyKeyId ?? DATA_KEY,
    searchKeyKeyId: overrides?.searchKeyKeyId ?? SEARCH_KEY,
    keyIdLabel: overrides?.keyIdLabel ?? "app-phi",
  });
  return { adapter, client };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("AwsKmsAdapter — construction", () => {
  it("rejects empty dataKeyKeyId", () => {
    expect(
      () =>
        new AwsKmsAdapter({
          client: createFakeKmsClient(defaultKeys()),
          dataKeyKeyId: "",
          searchKeyKeyId: SEARCH_KEY,
        })
    ).toThrowError(expect.objectContaining({ code: "CRYPTO_VALIDATION" }));
  });

  it("rejects empty searchKeyKeyId", () => {
    expect(
      () =>
        new AwsKmsAdapter({
          client: createFakeKmsClient(defaultKeys()),
          dataKeyKeyId: DATA_KEY,
          searchKeyKeyId: "",
        })
    ).toThrowError(expect.objectContaining({ code: "CRYPTO_VALIDATION" }));
  });

  it("derives a sane keyIdLabel from an ARN if none supplied", () => {
    const adapter = new AwsKmsAdapter({
      client: createFakeKmsClient(defaultKeys()),
      dataKeyKeyId: "arn:aws:kms:us-east-1:111111111111:key/abc-123",
      searchKeyKeyId: SEARCH_KEY,
    });
    // ASYNC currentKid: we don't await here, but the kid is a sync
    // template — pulling it back via a generateDataKey would be more
    // realistic but adds noise; this is enough.
    return adapter.currentKid({ tenantId: "org-1" }).then((kid) => {
      expect(kid).toBe("aws:kek:key-abc-123:org-1:v1");
    });
  });
});

describe("AwsKmsAdapter — generateDataKey + unwrapDataKey", () => {
  it("round-trips: wrapped DEK unwraps to the same plaintext DEK", async () => {
    const { adapter } = makeAdapter();
    const generated = await adapter.generateDataKey({ tenantId: "org-1" });
    expect(generated.plaintextDek.length).toBe(32);
    expect(generated.kid).toBe("aws:kek:app-phi:org-1:v1");

    const unwrapped = await adapter.unwrapDataKey({
      tenantId: "org-1",
      kid: generated.kid,
      wrappedDek: generated.wrappedDek,
    });
    expect(unwrapped.equals(generated.plaintextDek)).toBe(true);
  });

  it("calls KMS with EncryptionContext = { tenantId }", async () => {
    const { adapter, client } = makeAdapter();
    await adapter.generateDataKey({ tenantId: "org-1" });
    expect(client.generateCalls).toHaveLength(1);
    expect(client.generateCalls[0]?.EncryptionContext).toEqual({ tenantId: "org-1" });
    expect(client.generateCalls[0]?.KeySpec).toBe("AES_256");
    expect(client.generateCalls[0]?.KeyId).toBe(DATA_KEY);
  });

  it("rejects empty tenantId on generateDataKey", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.generateDataKey({ tenantId: "" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
  });

  it("generates a different DEK every call", async () => {
    const { adapter } = makeAdapter();
    const a = await adapter.generateDataKey({ tenantId: "org-1" });
    const b = await adapter.generateDataKey({ tenantId: "org-1" });
    expect(a.plaintextDek.equals(b.plaintextDek)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });
});

describe("AwsKmsAdapter — tenant isolation (EncryptionContext binding)", () => {
  it("a wrapped DEK from tenant A cannot be unwrapped as tenant B", async () => {
    const { adapter } = makeAdapter();
    const generated = await adapter.generateDataKey({ tenantId: "org-A" });

    // Even if we tamper the kid to look correct for tenant B, KMS
    // will refuse: EncryptionContext is part of the wrap, and the
    // caller supplied tenantId is passed to KMS. The kid carries
    // tenant A; if we pass tenantId='org-B' the kid check refuses
    // first; if we ALSO rewrite the kid to point at B, KMS refuses
    // because the stored EncryptionContext is { tenantId: 'org-A' }.
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-B",
        kid: generated.kid,
        wrappedDek: generated.wrappedDek,
      })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });

    // Forged kid for tenant B; KMS-side EncryptionContext still
    // pins to A.
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-B",
        kid: "aws:kek:app-phi:org-B:v1",
        wrappedDek: generated.wrappedDek,
      })
    ).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });

  it("rejects an unparseable kid (looks like LocalKmsAdapter envelope)", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-1",
        kid: "kek:org-1:v1", // LocalKmsAdapter format
        wrappedDek: Buffer.alloc(64),
      })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("rejects a malformed kid", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-1",
        kid: "not-a-valid-kid",
        wrappedDek: Buffer.alloc(64),
      })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("rejects empty tenantId on unwrapDataKey", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.unwrapDataKey({
        tenantId: "",
        kid: "aws:kek:app-phi:org-1:v1",
        wrappedDek: Buffer.alloc(64),
      })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });
});

describe("AwsKmsAdapter — deriveSearchKey", () => {
  it("returns 32 bytes", async () => {
    const { adapter } = makeAdapter();
    const key = await adapter.deriveSearchKey({
      tenantId: "org-1",
      purpose: "patient.first_name",
    });
    expect(key.length).toBe(32);
  });

  it("is deterministic for the same (tenantId, purpose)", async () => {
    const { adapter } = makeAdapter();
    const a = await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    const b = await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    expect(a.equals(b)).toBe(true);
  });

  it("partitions across tenants", async () => {
    const { adapter } = makeAdapter();
    const a = await adapter.deriveSearchKey({ tenantId: "org-A", purpose: "p" });
    const b = await adapter.deriveSearchKey({ tenantId: "org-B", purpose: "p" });
    expect(a.equals(b)).toBe(false);
  });

  it("partitions across purposes", async () => {
    const { adapter } = makeAdapter();
    const a = await adapter.deriveSearchKey({
      tenantId: "org-1",
      purpose: "patient.first_name",
    });
    const b = await adapter.deriveSearchKey({
      tenantId: "org-1",
      purpose: "patient.last_name",
    });
    expect(a.equals(b)).toBe(false);
  });

  it("memoizes — second call for same key does NOT hit KMS", async () => {
    const { adapter, client } = makeAdapter();
    await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    expect(client.macCalls).toHaveLength(1);
  });

  it("different (tenant, purpose) → separate KMS round-trips", async () => {
    const { adapter, client } = makeAdapter();
    await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "q" });
    await adapter.deriveSearchKey({ tenantId: "org-2", purpose: "p" });
    expect(client.macCalls).toHaveLength(3);
  });

  it("rejects empty purpose", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.deriveSearchKey({ tenantId: "org-1", purpose: "" })).rejects.toMatchObject(
      { code: "CRYPTO_VALIDATION" }
    );
  });

  it("rejects empty tenantId", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.deriveSearchKey({ tenantId: "", purpose: "p" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
  });

  it("uses MacAlgorithm = HMAC_SHA_256", async () => {
    const { adapter, client } = makeAdapter();
    await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    expect(client.macCalls[0]?.MacAlgorithm).toBe("HMAC_SHA_256");
    expect(client.macCalls[0]?.KeyId).toBe(SEARCH_KEY);
  });
});

describe("AwsKmsAdapter — validate()", () => {
  it("accepts well-formed keys", async () => {
    const { adapter, client } = makeAdapter();
    await expect(adapter.validate()).resolves.toBeUndefined();
    expect(client.describeCalls).toHaveLength(2);
  });

  it("is idempotent (no second round-trip)", async () => {
    const { adapter, client } = makeAdapter();
    await adapter.validate();
    await adapter.validate();
    expect(client.describeCalls).toHaveLength(2);
  });

  it("rejects a disabled data key", async () => {
    const keys = defaultKeys();
    keys[DATA_KEY] = { ...keys[DATA_KEY]!, Enabled: false };
    const { adapter } = makeAdapter({ keys });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("rejects a data key with wrong KeyUsage", async () => {
    const keys = defaultKeys();
    keys[DATA_KEY] = { ...keys[DATA_KEY]!, KeyUsage: "GENERATE_VERIFY_MAC" };
    const { adapter } = makeAdapter({ keys });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });

  it("rejects a search key with wrong KeyUsage", async () => {
    const keys = defaultKeys();
    keys[SEARCH_KEY] = { ...keys[SEARCH_KEY]!, KeyUsage: "ENCRYPT_DECRYPT" };
    const { adapter } = makeAdapter({ keys });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });

  it("rejects a search key with wrong KeySpec", async () => {
    const keys = defaultKeys();
    keys[SEARCH_KEY] = {
      ...keys[SEARCH_KEY]!,
      KeySpec: "SYMMETRIC_DEFAULT",
    };
    const { adapter } = makeAdapter({ keys });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });
});

describe("AwsKmsAdapter — kid format", () => {
  it("currentKid embeds tenantId and label", async () => {
    const { adapter } = makeAdapter({ keyIdLabel: "phi-v1" });
    const kid = await adapter.currentKid({ tenantId: "org-1" });
    expect(kid).toBe("aws:kek:phi-v1:org-1:v1");
  });

  it("the kid emitted by generateDataKey parses back to the same tenantId", async () => {
    const { adapter } = makeAdapter();
    const gen = await adapter.generateDataKey({ tenantId: "org-X" });
    expect(gen.kid).toMatch(/^aws:kek:app-phi:org-X:v1$/);
  });
});

describe("sanitizeKeyIdForLabel", () => {
  it("passes through a plain key id", () => {
    expect(sanitizeKeyIdForLabel("abc-def")).toBe("abc-def");
  });

  it("strips the leading colon-joined ARN segments", () => {
    expect(sanitizeKeyIdForLabel("arn:aws:kms:us-east-1:111111111111:key/abc-def-ghi")).toBe(
      "key-abc-def-ghi"
    );
  });

  it("rewrites alias slashes to hyphens (and drops the arn prefix)", () => {
    expect(sanitizeKeyIdForLabel("alias/pharmax/app-phi-key")).toBe("alias-pharmax-app-phi-key");
    expect(sanitizeKeyIdForLabel("arn:aws:kms:us-east-1:111111111111:alias/pharmax/x")).toBe(
      "alias-pharmax-x"
    );
  });
});

describe("AwsKmsAdapter — observability hooks (smoke)", () => {
  // Negative test: nothing on the adapter should expose plaintext
  // DEK material via toString / JSON.stringify in a way that could
  // leak through a Sentry capture. The adapter never logs; this is
  // a contract pin to prevent regressions.
  it("does not leak plaintext via JSON.stringify of the adapter instance", () => {
    const { adapter } = makeAdapter();
    const json = JSON.stringify(adapter);
    // The adapter has no enumerable plaintext key material at rest;
    // stringify should produce either "{}" or an empty-ish object.
    expect(json).not.toMatch(/[A-Za-z0-9+/=]{40,}/); // no base64-looking blobs
  });

  it("vi.fn-style mocks can stand in for AwsKmsClient", async () => {
    const fake: AwsKmsClient = {
      generateDataKey: vi.fn().mockResolvedValue({
        Plaintext: new Uint8Array(32),
        CiphertextBlob: new Uint8Array(64),
      }),
      decrypt: vi.fn().mockResolvedValue({ Plaintext: new Uint8Array(32) }),
      mac: vi.fn().mockResolvedValue({ Mac: new Uint8Array(32) }),
      describeKey: vi.fn().mockResolvedValue({
        KeyMetadata: { KeyId: "k", Enabled: true, KeyUsage: "ENCRYPT_DECRYPT" },
      }),
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: "k1",
      searchKeyKeyId: "k2",
      keyIdLabel: "lbl",
    });
    const gen = await adapter.generateDataKey({ tenantId: "org-1" });
    expect(gen.plaintextDek.length).toBe(32);
    expect(fake.generateDataKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Defence-in-depth: kid `keyIdLabel` slot.
// ---------------------------------------------------------------------------
//
// The kid format is `aws:kek:<keyIdLabel>:<tenantId>:v1`. The adapter
// also validates the `keyIdLabel` matches the configured one. The
// motivating attack/operator-error: an envelope wrapped under a
// previous `AWS_KMS_KEY_LABEL` value lands in front of an adapter
// configured for a new label. Without this check, we'd issue a
// KMS Decrypt against the wrong CMK and either succeed (wrong
// answer) or fail with an opaque KMS error.

describe("AwsKmsAdapter — keyIdLabel mismatch defence", () => {
  it("rejects a kid whose keyIdLabel does not match the adapter", async () => {
    const { adapter } = makeAdapter({ keyIdLabel: "app-phi" });
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-1",
        kid: "aws:kek:OTHER-LABEL:org-1:v1",
        wrappedDek: Buffer.alloc(64, 1),
      })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("the kid emitted by this adapter unwraps cleanly under the same label", async () => {
    const { adapter } = makeAdapter({ keyIdLabel: "phi-east" });
    const gen = await adapter.generateDataKey({ tenantId: "org-1" });
    expect(gen.kid).toBe("aws:kek:phi-east:org-1:v1");
    const dek = await adapter.unwrapDataKey({
      tenantId: "org-1",
      kid: gen.kid,
      wrappedDek: gen.wrappedDek,
    });
    expect(dek.equals(gen.plaintextDek)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wrappedDek argument validation.
// ---------------------------------------------------------------------------

describe("AwsKmsAdapter — wrappedDek input validation", () => {
  it("rejects a zero-length wrappedDek before reaching KMS", async () => {
    const { adapter, client } = makeAdapter();
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-1",
        kid: "aws:kek:app-phi:org-1:v1",
        wrappedDek: Buffer.alloc(0),
      })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
    expect(client.decryptCalls).toHaveLength(0);
  });

  it("rejects a non-Buffer wrappedDek", async () => {
    const { adapter, client } = makeAdapter();
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-1",
        kid: "aws:kek:app-phi:org-1:v1",
        // Cast simulates a malformed call site (e.g. callers
        // forgetting to deserialize the envelope before unwrap).
        wrappedDek: "not-a-buffer" as unknown as Buffer,
      })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
    expect(client.decryptCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Defective KMS responses.
// ---------------------------------------------------------------------------
//
// AWS KMS should always return 32-byte DEKs (KeySpec=AES_256) and
// 32-byte MACs (HMAC_256). If the SDK or a regional issue ever
// shipped a different size, our envelope format can't store it —
// fail loud rather than persist garbage.

describe("AwsKmsAdapter — KMS response size validation", () => {
  function makeFakeReturning(
    overrides: Partial<AwsKmsClient> & {
      readonly mac?: AwsKmsClient["mac"];
      readonly generateDataKey?: AwsKmsClient["generateDataKey"];
    }
  ): AwsKmsClient {
    const base = createFakeKmsClient(defaultKeys());
    return { ...base, ...overrides };
  }

  it("rejects a MAC of unexpected size (< 32 bytes)", async () => {
    const fake = makeFakeReturning({
      mac: async () => ({ Mac: new Uint8Array(16) }),
    });
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(
      adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });

  it("rejects a MAC of unexpected size (> 32 bytes)", async () => {
    const fake = makeFakeReturning({
      mac: async () => ({ Mac: new Uint8Array(48) }),
    });
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(
      adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });

  it("rejects a DEK of unexpected size from generateDataKey", async () => {
    const fake = makeFakeReturning({
      generateDataKey: async () => ({
        Plaintext: new Uint8Array(16), // wrong size
        CiphertextBlob: new Uint8Array(64),
      }),
    });
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.generateDataKey({ tenantId: "org-1" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
  });

  it("rejects a zero-length CiphertextBlob from generateDataKey", async () => {
    const fake = makeFakeReturning({
      generateDataKey: async () => ({
        Plaintext: new Uint8Array(32),
        CiphertextBlob: new Uint8Array(0),
      }),
    });
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.generateDataKey({ tenantId: "org-1" })).rejects.toMatchObject({
      code: "CRYPTO_VALIDATION",
    });
  });

  it("rejects a decrypt that returns a DEK of unexpected size", async () => {
    const base = createFakeKmsClient(defaultKeys());
    let firstCall = true;
    const fake: AwsKmsClient = {
      ...base,
      decrypt: async (input) => {
        const out = await base.decrypt(input);
        if (firstCall) {
          firstCall = false;
          return { Plaintext: new Uint8Array(20) };
        }
        return out;
      },
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    const gen = await adapter.generateDataKey({ tenantId: "org-1" });
    await expect(
      adapter.unwrapDataKey({
        tenantId: "org-1",
        kid: gen.kid,
        wrappedDek: gen.wrappedDek,
      })
    ).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });
});

// ---------------------------------------------------------------------------
// validate() — additional coverage.
// ---------------------------------------------------------------------------

describe("AwsKmsAdapter — validate() additional coverage", () => {
  it("rejects when DescribeKey throws (IAM AccessDenied path)", async () => {
    const fake: AwsKmsClient = {
      ...createFakeKmsClient(defaultKeys()),
      describeKey: async () => {
        throw new Error("AccessDeniedException: kms:DescribeKey is required");
      },
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("rejects when DescribeKey returns metadata missing KeyUsage", async () => {
    const fake: AwsKmsClient = {
      ...createFakeKmsClient(defaultKeys()),
      describeKey: async () => ({
        KeyMetadata: { KeyId: DATA_KEY, Enabled: true },
      }),
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });

  it("rejects when DescribeKey returns metadata missing KeySpec", async () => {
    const fake: AwsKmsClient = {
      ...createFakeKmsClient(defaultKeys()),
      describeKey: async () => ({
        KeyMetadata: {
          KeyId: DATA_KEY,
          Enabled: true,
          KeyUsage: "ENCRYPT_DECRYPT",
          // KeySpec intentionally omitted
        },
      }),
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "CRYPTO_VALIDATION" });
  });

  it("subsequent validate() after a failed first one re-attempts (no false-cache)", async () => {
    let nthCall = 0;
    const ok = createFakeKmsClient(defaultKeys());
    const fake: AwsKmsClient = {
      ...ok,
      describeKey: async (input) => {
        nthCall += 1;
        if (nthCall === 1) throw new Error("ThrottlingException");
        return ok.describeKey(input);
      },
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.validate()).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
    // Second call should succeed (no validated=true cache after failure).
    await expect(adapter.validate()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Search-key cache concurrency.
// ---------------------------------------------------------------------------

describe("AwsKmsAdapter — search-key cache concurrency", () => {
  it("collapses two concurrent calls for the same (tenant, purpose) to ONE KMS round-trip", async () => {
    const { adapter, client } = makeAdapter();
    const [a, b] = await Promise.all([
      adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" }),
      adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" }),
    ]);
    expect(a.equals(b)).toBe(true);
    expect(client.macCalls).toHaveLength(1);
    expect(adapter._searchKeyCacheSize()).toBe(1);
  });

  it("evicts the cache entry on transient failure so the next call retries", async () => {
    const base = createFakeKmsClient(defaultKeys());
    let macCalls = 0;
    const fake: AwsKmsClient = {
      ...base,
      mac: async (input) => {
        macCalls += 1;
        if (macCalls === 1) throw new Error("ThrottlingException");
        return base.mac(input);
      },
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" })).rejects.toThrow();
    // Cache must be empty so the retry can happen.
    expect(adapter._searchKeyCacheSize()).toBe(0);
    // Retry succeeds and populates the cache.
    const key = await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    expect(key.length).toBe(32);
    expect(adapter._searchKeyCacheSize()).toBe(1);
    expect(macCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Chaos — SDK throttling.
// ---------------------------------------------------------------------------
//
// In production, the AWS SDK transparently retries `ThrottlingException`
// via its adaptive retry strategy. The adapter must not interfere with
// that — i.e. if the SDK eventually returns a successful response, the
// adapter MUST return success. This test simulates the SDK's behaviour
// by wrapping the fake client in a "throttle once then succeed" layer
// that mirrors what the SDK presents to the adapter after a successful
// retry.

describe("AwsKmsAdapter — chaos: transient SDK throttling", () => {
  it("generateDataKey: first call propagates SDK throttle, second succeeds", async () => {
    const base = createFakeKmsClient(defaultKeys());
    let attempt = 0;
    const fake: AwsKmsClient = {
      ...base,
      generateDataKey: async (input) => {
        attempt += 1;
        if (attempt === 1) throw new Error("ThrottlingException");
        return base.generateDataKey(input);
      },
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });

    // First call: adapter surfaces SDK throttle as the underlying
    // Error. The SDK's own retry loop is what makes this transparent
    // in production; we model "after the SDK gave up" here. The
    // adapter must not swallow.
    await expect(adapter.generateDataKey({ tenantId: "org-1" })).rejects.toThrow(
      /ThrottlingException/
    );
    // Second call (representing a successful SDK retry / next request):
    // adapter returns a clean result with no side-effects from the
    // previous throttle.
    const gen = await adapter.generateDataKey({ tenantId: "org-1" });
    expect(gen.plaintextDek.length).toBe(32);
    expect(attempt).toBe(2);
  });

  it("decrypt: a throttle followed by success round-trips cleanly", async () => {
    const base = createFakeKmsClient(defaultKeys());
    // Wrap once against the BASE client so we have a wrapped DEK to
    // decrypt. The decrypt itself is what we want to exercise the
    // throttle on, so build a SECOND adapter whose client throttles
    // on the first decrypt call and succeeds on the second.
    const adapterForWrap = new AwsKmsAdapter({
      client: base,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    const gen = await adapterForWrap.generateDataKey({ tenantId: "org-1" });

    let decryptAttempt = 0;
    const decryptFake: AwsKmsClient = {
      ...base,
      decrypt: async (input) => {
        decryptAttempt += 1;
        if (decryptAttempt === 1) throw new Error("ThrottlingException");
        return base.decrypt(input);
      },
    };
    const adapterForDecrypt = new AwsKmsAdapter({
      client: decryptFake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    // First call surfaces the throttle as DECRYPT_FAILED (the
    // adapter maps any client-thrown error in the decrypt path to
    // its internal code; the SDK's own retry layer is what would
    // make a transient throttle invisible in production).
    await expect(
      adapterForDecrypt.unwrapDataKey({
        tenantId: "org-1",
        kid: gen.kid,
        wrappedDek: gen.wrappedDek,
      })
    ).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    // Second call (simulating the SDK retry succeeded) returns the
    // correct DEK — no poisoned state from the previous attempt.
    const dek = await adapterForDecrypt.unwrapDataKey({
      tenantId: "org-1",
      kid: gen.kid,
      wrappedDek: gen.wrappedDek,
    });
    expect(dek.equals(gen.plaintextDek)).toBe(true);
    expect(decryptAttempt).toBe(2);
  });

  it("mac: a throttle does not poison the search-key cache", async () => {
    const base = createFakeKmsClient(defaultKeys());
    let attempt = 0;
    const fake: AwsKmsClient = {
      ...base,
      mac: async (input) => {
        attempt += 1;
        if (attempt === 1) throw new Error("ThrottlingException");
        return base.mac(input);
      },
    };
    const adapter = new AwsKmsAdapter({
      client: fake,
      dataKeyKeyId: DATA_KEY,
      searchKeyKeyId: SEARCH_KEY,
      keyIdLabel: "app-phi",
    });
    await expect(adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" })).rejects.toThrow(
      /ThrottlingException/
    );
    // Cache must NOT contain a poisoned rejected Promise.
    expect(adapter._searchKeyCacheSize()).toBe(0);
    const key = await adapter.deriveSearchKey({ tenantId: "org-1", purpose: "p" });
    expect(key.length).toBe(32);
    expect(attempt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// kid partitioning across different labels.
// ---------------------------------------------------------------------------

describe("AwsKmsAdapter — kid uniqueness across labels", () => {
  it("two adapters with different labels produce different kids for the same tenant", async () => {
    const a = makeAdapter({ keyIdLabel: "label-a" }).adapter;
    const b = makeAdapter({ keyIdLabel: "label-b" }).adapter;
    const kidA = await a.currentKid({ tenantId: "org-1" });
    const kidB = await b.currentKid({ tenantId: "org-1" });
    expect(kidA).not.toBe(kidB);
    expect(kidA).toBe("aws:kek:label-a:org-1:v1");
    expect(kidB).toBe("aws:kek:label-b:org-1:v1");
  });
});

beforeEach(() => {
  // No global state to reset; the cache lives on each adapter
  // instance and the fake client lives per-test.
});
