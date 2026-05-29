// Thin AWS SDK v3 wrapper that satisfies the `AwsKmsClient` interface.
//
// Kept in its own file so:
//
//   - `aws-kms-adapter.ts` does not statically import the SDK. The
//     adapter is testable without `@aws-sdk/client-kms` installed
//     (CI / unit tests don't pull the SDK).
//   - The production wiring path stays a single file you can read
//     in one screen to confirm the AWS call shape matches what the
//     adapter expects.
//
// Production wiring (apps/web, apps/worker):
//
//     import { AwsKmsAdapter, createAwsKmsClient } from "@pharmax/crypto";
//     const kms = new AwsKmsAdapter({
//       client: createAwsKmsClient({ region: env.AWS_REGION }),
//       dataKeyKeyId: env.AWS_KMS_DATA_KEY_ID,
//       searchKeyKeyId: env.AWS_KMS_SEARCH_KEY_ID,
//       keyIdLabel: "app-phi",
//     });
//     await kms.validate();           // boot-time check
//     configureCrypto({ kms });
//
// Reliability posture:
//
//   - Retry strategy: `adaptive` mode (token-bucket throttling on
//     top of standard exponential backoff with full jitter). AWS-
//     recommended for high-throughput services that may experience
//     server-side throttling. `maxAttempts = 3` keeps the worst-
//     case tail bounded — a third failure becomes a request-level
//     error surfaced via Sentry, not a 30s hang on a degraded
//     endpoint. The SDK chooses delay = random(0, min(cap, base *
//     2^attempt)); the random component is the "jitter".
//
//   - Connection timeout: 3s. Fail fast on TLS handshake / DNS
//     stalls; KMS regional endpoints are typically <50ms p99.
//
//   - Socket timeout: 5s. Per-socket inactivity threshold. KMS
//     individual operations are typically <100ms; a 5s socket
//     idle is near-certainly a hung connection.
//
//   - Request timeout: 5s end-to-end wall clock PER ATTEMPT.
//     Bounded so a hung KMS endpoint cannot keep us pinned past
//     the user-perceptible threshold. Worst-case across the 3
//     attempts is ~15s + jitter backoff — that's the upper bound
//     on the caller's wait. Configure higher only for
//     long-running batch workloads where p99 latency matters more
//     than tail latency.
//
//   - Connection reuse: NodeHttpHandler with `httpsAgent.keepAlive
//     = true`. The SDK's default does enable keep-alive, but we
//     instantiate explicitly here so the contract is visible in
//     this file rather than buried in SDK defaults — KMS billing
//     is per-call and HTTPS handshake savings on a hot path
//     (`GenerateDataKey` per PHI field) matter at our volume.
//     We cap concurrent sockets at 50: a runaway request burst
//     hitting a misconfigured KMS endpoint would otherwise spawn
//     unbounded TCP connections.
//
// Observability posture:
//
//   - `customUserAgent` adds a `pharmax-crypto/<version>` token to
//     the User-Agent header so KMS CloudTrail events trace back to
//     this package (the AWS-side audit trail can attribute calls
//     to the responsible component without us correlating by IAM
//     principal alone). The token is `["pharmax-crypto", version]`
//     so the SDK renders it as `pharmax-crypto/<version>` rather
//     than the un-versioned `pharmax-crypto` form.
//
//   - No request/response bodies are ever logged here — KMS call
//     plaintexts ARE the PHI envelope; logging them would defeat
//     envelope encryption. The SDK's debug logger is left at the
//     default (off); if explicit debug is ever needed, route via
//     OTel spans, never console.

import https from "node:https";

import {
  KMSClient,
  DecryptCommand,
  DescribeKeyCommand,
  GenerateDataKeyCommand,
  GenerateMacCommand,
} from "@aws-sdk/client-kms";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getMeter } from "@pharmax/telemetry";

import type {
  AwsKmsClient,
  AwsKmsDecryptInput,
  AwsKmsDecryptOutput,
  AwsKmsDescribeKeyInput,
  AwsKmsDescribeKeyOutput,
  AwsKmsGenerateDataKeyInput,
  AwsKmsGenerateDataKeyOutput,
  AwsKmsMacInput,
  AwsKmsMacOutput,
} from "./aws-kms-adapter.js";
import { cryptoValidationError } from "./errors.js";

const meter = getMeter("@pharmax/crypto");

const kmsOperationErrorsCounter = meter.createCounter("pharmax_kms_operation_errors_total", {
  description:
    "AWS KMS operation failures (after SDK-internal retries). Labelled by operation name in snake_case.",
});

/**
 * Wrap an async KMS call so any thrown error increments the
 * `pharmax_kms_operation_errors_total{operation}` counter exactly
 * once before re-throwing. The error itself is rethrown unchanged
 * so the caller's error mapping is untouched.
 */
async function recordKmsError<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    kmsOperationErrorsCounter.add(1, { operation });
    throw cause;
  }
}

/**
 * User-agent identifier name component. Bumped by hand together
 * with `package.json` on shipped changes. Kept as a constant
 * (rather than a runtime `require("../package.json")`) to keep
 * the build artifact minimal and avoid pulling package.json into
 * the runtime closure.
 */
const PHARMAX_CRYPTO_USER_AGENT_NAME = "pharmax-crypto";
const PHARMAX_CRYPTO_USER_AGENT_VERSION = "0.1.0";

/** Default connection (TLS+DNS) timeout in milliseconds. */
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

/** Default per-socket inactivity timeout in milliseconds. */
const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

/** Default end-to-end per-attempt request timeout in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** Default max retry attempts (initial + 2 retries). */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Cap on concurrent KMS sockets per process. */
const KMS_HTTPS_AGENT_MAX_SOCKETS = 50;

export interface CreateAwsKmsClientOptions {
  readonly region: string;
  /**
   * Optional. If unset, the SDK resolves credentials via the standard
   * AWS chain (environment, ECS task role, EC2 instance profile,
   * etc.). In production we rely on the ECS task role — no static
   * credentials in env or code.
   */
  readonly endpoint?: string;
  /** TLS+DNS connection timeout in ms. Default {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  readonly connectTimeoutMs?: number;
  /** Per-socket inactivity timeout in ms. Default {@link DEFAULT_SOCKET_TIMEOUT_MS}. */
  readonly socketTimeoutMs?: number;
  /**
   * End-to-end per-attempt request timeout in ms. Default
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}. This bounds the wall-clock
   * time of a single attempt (independent of `socketTimeoutMs`
   * which only catches inactivity).
   */
  readonly requestTimeoutMs?: number;
  /**
   * Max retry attempts (initial attempt + retries).
   * Default {@link DEFAULT_MAX_ATTEMPTS}. The SDK uses adaptive
   * retry with full-jitter exponential backoff for retryable
   * errors (5xx, throttling). Non-retryable errors (4xx other than
   * throttling, e.g. `InvalidCiphertextException`) are surfaced
   * immediately — retries cannot help.
   */
  readonly maxAttempts?: number;
  /**
   * Override the user-agent suffix. Tests use this to make the
   * SDK config deterministic. Production should leave at default.
   */
  readonly userAgentSuffix?: string;
}

/**
 * Build a production-ready AWS KMS client wrapper. The returned
 * object implements `AwsKmsClient` and can be passed directly to
 * `new AwsKmsAdapter({ client, ... })`.
 *
 * Invariants:
 *
 *   - The underlying `KMSClient` is configured for adaptive retry.
 *   - HTTPS connections are reused via a single keep-alive agent.
 *   - All four KMS operations (`GenerateDataKey`, `Decrypt`,
 *     `GenerateMac`, `DescribeKey`) translate from SDK shape to
 *     `AwsKmsClient` shape WITHOUT mutating the caller's input.
 *   - SDK-level errors (throttling, timeout, network) propagate
 *     unchanged so the caller can map them to internal codes.
 *   - Missing fields on a successful SDK response throw
 *     `CRYPTO_VALIDATION` rather than producing an envelope the
 *     decrypt path cannot use.
 */
export function createAwsKmsClient(options: CreateAwsKmsClientOptions): AwsKmsClient {
  if (typeof options.region !== "string" || options.region.length === 0) {
    throw cryptoValidationError({ field: "region", reason: "must be a non-empty string" });
  }

  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const socketTimeoutMs = options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  requirePositiveInt(connectTimeoutMs, "connectTimeoutMs");
  requirePositiveInt(socketTimeoutMs, "socketTimeoutMs");
  requirePositiveInt(requestTimeoutMs, "requestTimeoutMs");
  requirePositiveInt(maxAttempts, "maxAttempts");

  // Single keep-alive agent shared across this client's request
  // handler. Caps total concurrent sockets per process so a
  // misconfigured endpoint cannot exhaust file descriptors.
  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: KMS_HTTPS_AGENT_MAX_SOCKETS,
  });

  const requestHandler = new NodeHttpHandler({
    httpsAgent,
    connectionTimeout: connectTimeoutMs,
    socketTimeout: socketTimeoutMs,
    requestTimeout: requestTimeoutMs,
  });

  // User-Agent rendering: the SDK serializes each pair as
  // `${name}/${version}` (or `name` alone if version is missing /
  // empty). Splitting name + version avoids rendering an empty-
  // suffix `pharmax-crypto/0.1.0/` token. The optional caller-
  // supplied `userAgentSuffix` is appended as a separate pair so
  // it doesn't collide with the version slot.
  const customUserAgent: [string, string][] = [
    [PHARMAX_CRYPTO_USER_AGENT_NAME, PHARMAX_CRYPTO_USER_AGENT_VERSION],
  ];
  if (typeof options.userAgentSuffix === "string" && options.userAgentSuffix.length > 0) {
    customUserAgent.push([options.userAgentSuffix, ""]);
  }

  const kms = new KMSClient({
    region: options.region,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    // `adaptive` adds a client-side rate limiter on top of
    // exponential-with-jitter backoff. Recommended for KMS at any
    // meaningful throughput. Throttling responses (4xx with
    // retryable codes) feed the rate limiter; non-retryable 4xx
    // (`InvalidCiphertextException`, `AccessDeniedException`) are
    // surfaced immediately.
    retryMode: "adaptive",
    maxAttempts,
    requestHandler,
    customUserAgent,
  });

  return {
    async generateDataKey(input: AwsKmsGenerateDataKeyInput): Promise<AwsKmsGenerateDataKeyOutput> {
      const out = await recordKmsError("generate_data_key", () =>
        kms.send(
          new GenerateDataKeyCommand({
            KeyId: input.KeyId,
            KeySpec: input.KeySpec,
            EncryptionContext: { ...input.EncryptionContext },
          })
        )
      );
      if (out.Plaintext === undefined || out.CiphertextBlob === undefined) {
        kmsOperationErrorsCounter.add(1, { operation: "generate_data_key" });
        throw cryptoValidationError({
          field: "kms.generateDataKey",
          reason: "AWS KMS returned no Plaintext or CiphertextBlob",
        });
      }
      return { Plaintext: out.Plaintext, CiphertextBlob: out.CiphertextBlob };
    },

    async decrypt(input: AwsKmsDecryptInput): Promise<AwsKmsDecryptOutput> {
      const out = await recordKmsError("decrypt", () =>
        kms.send(
          new DecryptCommand({
            KeyId: input.KeyId,
            CiphertextBlob: input.CiphertextBlob,
            EncryptionContext: { ...input.EncryptionContext },
          })
        )
      );
      if (out.Plaintext === undefined) {
        kmsOperationErrorsCounter.add(1, { operation: "decrypt" });
        throw cryptoValidationError({
          field: "kms.decrypt",
          reason: "AWS KMS returned no Plaintext",
        });
      }
      return { Plaintext: out.Plaintext };
    },

    async mac(input: AwsKmsMacInput): Promise<AwsKmsMacOutput> {
      const out = await recordKmsError("generate_mac", () =>
        kms.send(
          new GenerateMacCommand({
            KeyId: input.KeyId,
            Message: input.Message,
            MacAlgorithm: input.MacAlgorithm,
          })
        )
      );
      if (out.Mac === undefined) {
        kmsOperationErrorsCounter.add(1, { operation: "generate_mac" });
        throw cryptoValidationError({
          field: "kms.mac",
          reason: "AWS KMS returned no Mac",
        });
      }
      return { Mac: out.Mac };
    },

    async describeKey(input: AwsKmsDescribeKeyInput): Promise<AwsKmsDescribeKeyOutput> {
      const out = await recordKmsError("describe_key", () =>
        kms.send(new DescribeKeyCommand({ KeyId: input.KeyId }))
      );
      if (out.KeyMetadata === undefined || out.KeyMetadata.KeyId === undefined) {
        kmsOperationErrorsCounter.add(1, { operation: "describe_key" });
        throw cryptoValidationError({
          field: "kms.describeKey",
          reason: "AWS KMS returned no KeyMetadata",
        });
      }
      return {
        KeyMetadata: {
          KeyId: out.KeyMetadata.KeyId,
          ...(out.KeyMetadata.Arn !== undefined ? { Arn: out.KeyMetadata.Arn } : {}),
          ...(out.KeyMetadata.KeyUsage !== undefined ? { KeyUsage: out.KeyMetadata.KeyUsage } : {}),
          ...(out.KeyMetadata.KeySpec !== undefined ? { KeySpec: out.KeyMetadata.KeySpec } : {}),
          ...(out.KeyMetadata.Enabled !== undefined ? { Enabled: out.KeyMetadata.Enabled } : {}),
        },
      };
    },
  };
}

function requirePositiveInt(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw cryptoValidationError({
      field,
      reason: `must be a positive integer; got ${String(value)}`,
    });
  }
}
