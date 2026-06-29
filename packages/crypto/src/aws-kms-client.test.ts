// createAwsKmsClient tests.
//
// `aws-kms-adapter.test.ts` exercises the adapter against a hand-rolled
// fake `AwsKmsClient`, so the production SDK wrapper (`createAwsKmsClient`
// in `aws-kms-client.ts`) was never executed by the unit suite. This
// file closes that gap by mocking `@aws-sdk/client-kms` +
// `@smithy/node-http-handler` and asserting the wrapper's contract:
//
//   1. Construction validation — empty region and non-positive
//      timeouts/attempts throw CRYPTO_VALIDATION before any SDK object
//      is built.
//   2. SDK client config — adaptive retry, maxAttempts, the versioned
//      `pharmax-crypto/<v>` user-agent token (+ optional suffix), and
//      the endpoint passthrough.
//   3. Each of the four operations (generateDataKey, decrypt, mac,
//      describeKey):
//        a. success → SDK response is mapped to the AwsKmsClient shape,
//           and EncryptionContext is COPIED (never the caller's ref);
//        b. a successful-but-incomplete SDK response throws
//           CRYPTO_VALIDATION rather than yielding an unusable envelope;
//        c. a thrown SDK error propagates unchanged AND bumps the
//           `pharmax_kms_operation_errors_total{operation}` counter.
//
// No real AWS, no network: the SDK client + request handler + telemetry
// meter are all mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { kmsSendMock, kmsCtorMock, handlerCtorMock, counterAddMock } = vi.hoisted(() => ({
  kmsSendMock: vi.fn(),
  kmsCtorMock: vi.fn(),
  handlerCtorMock: vi.fn(),
  counterAddMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: class {
    public send = kmsSendMock;
    constructor(config: unknown) {
      kmsCtorMock(config);
    }
  },
  // Command classes just capture their input so we can assert the
  // wrapper passed the right fields through to the SDK.
  GenerateDataKeyCommand: class {
    constructor(public readonly input: unknown) {}
  },
  DecryptCommand: class {
    constructor(public readonly input: unknown) {}
  },
  GenerateMacCommand: class {
    constructor(public readonly input: unknown) {}
  },
  DescribeKeyCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: class {
    constructor(config: unknown) {
      handlerCtorMock(config);
    }
  },
}));

vi.mock("@pharmax/telemetry", () => ({
  getMeter: () => ({
    createCounter: () => ({ add: counterAddMock }),
  }),
}));

// Imported AFTER the mocks are declared (vi.mock is hoisted above the
// imports by vitest, so this resolves to the mocked SDK).
import { createAwsKmsClient } from "./aws-kms-client.js";
import { CRYPTO_VALIDATION } from "./errors.js";

const VALIDATION = expect.objectContaining({ code: CRYPTO_VALIDATION });

/** Read the `input` of the Nth command handed to `kms.send`. */
function sentInput(call = 0): Record<string, unknown> {
  return (kmsSendMock.mock.calls[call]?.[0] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  kmsSendMock.mockReset();
  kmsCtorMock.mockReset();
  handlerCtorMock.mockReset();
  counterAddMock.mockReset();
});

describe("createAwsKmsClient — construction validation", () => {
  it("rejects an empty region before building any SDK object", () => {
    expect(() => createAwsKmsClient({ region: "" })).toThrowError(VALIDATION);
    expect(kmsCtorMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string region", () => {
    expect(() => createAwsKmsClient({ region: undefined as unknown as string })).toThrowError(
      VALIDATION
    );
  });

  it.each([
    ["connectTimeoutMs", { connectTimeoutMs: 0 }],
    ["socketTimeoutMs", { socketTimeoutMs: 1.5 }],
    ["requestTimeoutMs", { requestTimeoutMs: Number.NaN }],
    ["maxAttempts", { maxAttempts: -1 }],
  ])("rejects a non-positive-integer %s", (_field, override) => {
    expect(() => createAwsKmsClient({ region: "us-east-1", ...override })).toThrowError(VALIDATION);
    expect(kmsCtorMock).not.toHaveBeenCalled();
  });
});

describe("createAwsKmsClient — SDK client configuration", () => {
  it("configures adaptive retry, maxAttempts, and the versioned user-agent token", () => {
    createAwsKmsClient({ region: "us-east-1" });

    expect(kmsCtorMock).toHaveBeenCalledTimes(1);
    const config = kmsCtorMock.mock.calls[0]![0] as {
      region: string;
      retryMode: string;
      maxAttempts: number;
      customUserAgent: [string, string][];
      endpoint?: string;
    };
    expect(config.region).toBe("us-east-1");
    expect(config.retryMode).toBe("adaptive");
    expect(config.maxAttempts).toBe(3);
    expect(config.customUserAgent).toEqual([["pharmax-crypto", "0.1.0"]]);
    // No endpoint override unless explicitly supplied.
    expect(config.endpoint).toBeUndefined();

    // The keep-alive request handler is wired with the default timeouts.
    expect(handlerCtorMock).toHaveBeenCalledTimes(1);
    const handlerConfig = handlerCtorMock.mock.calls[0]![0] as {
      connectionTimeout: number;
      socketTimeout: number;
      requestTimeout: number;
    };
    expect(handlerConfig.connectionTimeout).toBe(3_000);
    expect(handlerConfig.socketTimeout).toBe(5_000);
    expect(handlerConfig.requestTimeout).toBe(5_000);
  });

  it("appends an optional user-agent suffix as a separate token and passes the endpoint through", () => {
    createAwsKmsClient({
      region: "eu-west-1",
      endpoint: "https://kms.local:4599",
      userAgentSuffix: "integration-test",
    });

    const config = kmsCtorMock.mock.calls[0]![0] as {
      endpoint?: string;
      customUserAgent: [string, string][];
    };
    expect(config.endpoint).toBe("https://kms.local:4599");
    expect(config.customUserAgent).toEqual([
      ["pharmax-crypto", "0.1.0"],
      ["integration-test", ""],
    ]);
  });

  it("ignores an empty user-agent suffix", () => {
    createAwsKmsClient({ region: "us-east-1", userAgentSuffix: "" });
    const config = kmsCtorMock.mock.calls[0]![0] as { customUserAgent: [string, string][] };
    expect(config.customUserAgent).toEqual([["pharmax-crypto", "0.1.0"]]);
  });
});

describe("createAwsKmsClient — generateDataKey", () => {
  it("maps a successful response and copies the EncryptionContext", async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const ciphertext = new Uint8Array([4, 5, 6]);
    kmsSendMock.mockResolvedValueOnce({ Plaintext: plaintext, CiphertextBlob: ciphertext });

    const client = createAwsKmsClient({ region: "us-east-1" });
    const encryptionContext = { tenant: "org-1" };
    const out = await client.generateDataKey({
      KeyId: "key-1",
      KeySpec: "AES_256",
      EncryptionContext: encryptionContext,
    });

    expect(out).toEqual({ Plaintext: plaintext, CiphertextBlob: ciphertext });
    const input = sentInput();
    expect(input["KeyId"]).toBe("key-1");
    expect(input["KeySpec"]).toBe("AES_256");
    expect(input["EncryptionContext"]).toEqual(encryptionContext);
    // Defensive copy — never the caller's object by reference.
    expect(input["EncryptionContext"]).not.toBe(encryptionContext);
  });

  it("throws CRYPTO_VALIDATION when the response omits Plaintext/CiphertextBlob", async () => {
    kmsSendMock.mockResolvedValueOnce({ CiphertextBlob: new Uint8Array([1]) });
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(
      client.generateDataKey({ KeyId: "key-1", KeySpec: "AES_256", EncryptionContext: {} })
    ).rejects.toMatchObject({ code: CRYPTO_VALIDATION });
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "generate_data_key" });
  });

  it("propagates an SDK error and records the operation failure", async () => {
    const boom = new Error("ThrottlingException");
    kmsSendMock.mockRejectedValueOnce(boom);
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(
      client.generateDataKey({ KeyId: "key-1", KeySpec: "AES_256", EncryptionContext: {} })
    ).rejects.toBe(boom);
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "generate_data_key" });
  });
});

describe("createAwsKmsClient — decrypt", () => {
  it("maps a successful response and copies the EncryptionContext", async () => {
    const plaintext = new Uint8Array([7, 8, 9]);
    kmsSendMock.mockResolvedValueOnce({ Plaintext: plaintext });
    const client = createAwsKmsClient({ region: "us-east-1" });
    const encryptionContext = { tenant: "org-2" };

    const out = await client.decrypt({
      KeyId: "key-1",
      CiphertextBlob: new Uint8Array([1]),
      EncryptionContext: encryptionContext,
    });

    expect(out).toEqual({ Plaintext: plaintext });
    expect(sentInput()["EncryptionContext"]).not.toBe(encryptionContext);
  });

  it("throws CRYPTO_VALIDATION when the response omits Plaintext", async () => {
    kmsSendMock.mockResolvedValueOnce({});
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(
      client.decrypt({ KeyId: "key-1", CiphertextBlob: new Uint8Array([1]), EncryptionContext: {} })
    ).rejects.toMatchObject({ code: CRYPTO_VALIDATION });
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "decrypt" });
  });

  it("propagates an SDK error and records the operation failure", async () => {
    const boom = new Error("InvalidCiphertextException");
    kmsSendMock.mockRejectedValueOnce(boom);
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(
      client.decrypt({ KeyId: "key-1", CiphertextBlob: new Uint8Array([1]), EncryptionContext: {} })
    ).rejects.toBe(boom);
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "decrypt" });
  });
});

describe("createAwsKmsClient — mac", () => {
  it("maps a successful response", async () => {
    const mac = new Uint8Array([10, 11, 12]);
    kmsSendMock.mockResolvedValueOnce({ Mac: mac });
    const client = createAwsKmsClient({ region: "us-east-1" });

    const out = await client.mac({
      KeyId: "key-1",
      Message: new Uint8Array([1]),
      MacAlgorithm: "HMAC_SHA_256",
    });

    expect(out).toEqual({ Mac: mac });
    expect(sentInput()["MacAlgorithm"]).toBe("HMAC_SHA_256");
  });

  it("throws CRYPTO_VALIDATION when the response omits Mac", async () => {
    kmsSendMock.mockResolvedValueOnce({});
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(
      client.mac({ KeyId: "key-1", Message: new Uint8Array([1]), MacAlgorithm: "HMAC_SHA_256" })
    ).rejects.toMatchObject({ code: CRYPTO_VALIDATION });
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "generate_mac" });
  });

  it("propagates an SDK error and records the operation failure", async () => {
    const boom = new Error("KMSInternalException");
    kmsSendMock.mockRejectedValueOnce(boom);
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(
      client.mac({ KeyId: "key-1", Message: new Uint8Array([1]), MacAlgorithm: "HMAC_SHA_256" })
    ).rejects.toBe(boom);
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "generate_mac" });
  });
});

describe("createAwsKmsClient — describeKey", () => {
  it("maps full key metadata", async () => {
    kmsSendMock.mockResolvedValueOnce({
      KeyMetadata: {
        KeyId: "key-1",
        Arn: "arn:aws:kms:us-east-1:123:key/key-1",
        KeyUsage: "ENCRYPT_DECRYPT",
        KeySpec: "SYMMETRIC_DEFAULT",
        Enabled: true,
      },
    });
    const client = createAwsKmsClient({ region: "us-east-1" });

    const out = await client.describeKey({ KeyId: "key-1" });
    expect(out).toEqual({
      KeyMetadata: {
        KeyId: "key-1",
        Arn: "arn:aws:kms:us-east-1:123:key/key-1",
        KeyUsage: "ENCRYPT_DECRYPT",
        KeySpec: "SYMMETRIC_DEFAULT",
        Enabled: true,
      },
    });
  });

  it("omits absent optional metadata fields", async () => {
    kmsSendMock.mockResolvedValueOnce({ KeyMetadata: { KeyId: "key-1" } });
    const client = createAwsKmsClient({ region: "us-east-1" });

    const out = await client.describeKey({ KeyId: "key-1" });
    expect(out).toEqual({ KeyMetadata: { KeyId: "key-1" } });
    expect(Object.keys(out.KeyMetadata)).toEqual(["KeyId"]);
  });

  it("throws CRYPTO_VALIDATION when KeyMetadata is missing", async () => {
    kmsSendMock.mockResolvedValueOnce({});
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(client.describeKey({ KeyId: "key-1" })).rejects.toMatchObject({
      code: CRYPTO_VALIDATION,
    });
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "describe_key" });
  });

  it("throws CRYPTO_VALIDATION when KeyMetadata.KeyId is missing", async () => {
    kmsSendMock.mockResolvedValueOnce({ KeyMetadata: { Arn: "arn:aws:kms:...:key/x" } });
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(client.describeKey({ KeyId: "key-1" })).rejects.toMatchObject({
      code: CRYPTO_VALIDATION,
    });
  });

  it("propagates an SDK error and records the operation failure", async () => {
    const boom = new Error("NotFoundException");
    kmsSendMock.mockRejectedValueOnce(boom);
    const client = createAwsKmsClient({ region: "us-east-1" });

    await expect(client.describeKey({ KeyId: "key-1" })).rejects.toBe(boom);
    expect(counterAddMock).toHaveBeenCalledWith(1, { operation: "describe_key" });
  });
});
