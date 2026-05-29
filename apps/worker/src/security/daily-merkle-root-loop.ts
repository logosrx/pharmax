// Daily Merkle root signing job, wrapped as a worker-process loop.
//
// The actual root-computation, signing, and manifest publication
// logic lives in @pharmax/security. This file is the SEAM between
// the worker process (Prisma + tenancy + logging + AWS clients) and
// that package. The crypto invariants (RFC 6962 leaf+node domain
// tags, ECDSA-P256 SHA-256, COMPLIANCE Object Lock retention) are
// enforced INSIDE @pharmax/security; the loop is responsible for:
//
//   - Iterating organizations sequentially.
//   - Isolating per-org failures so one signer/publisher error
//     does not stop the day's run.
//   - Emitting structured metrics (counters) the digest probes can
//     turn into "X orgs skipped today" lines.
//   - Halting cleanly on shutdown — the in-flight org completes,
//     the queue drains, then the scheduler resolves stop().
//
// Why per-org sequential, not parallel: KMS Sign + S3 PutObject are
// individually fast (~50ms + ~100ms p99), but COMPLIANCE Object Lock
// PUTs are rate-limited by the customer KMS key's TPS and by the
// fact that the audit-archive S3 bucket lives behind a single VPC
// endpoint. At our org count this is negligible; at 10k orgs the
// loop would want a small concurrent worker pool — that's a later
// change behind a feature flag, not a today problem.

import type { PrismaClient } from "@pharmax/database";
import { errors, type logger as loggerContract } from "@pharmax/platform-core";
import {
  InMemoryManifestPublisher,
  KmsAsymmetricSigner,
  LocalEd25519Signer,
  MERKLE_MANIFEST_OVERWRITE_REFUSED,
  MERKLE_PUBLIC_KEY_FETCH_FAILED,
  MERKLE_PUBLISH_FAILED,
  MERKLE_SIGN_FAILED,
  S3ObjectLockPublisher,
  SIGNING_DOMAIN_TAG,
  adaptAwsKmsSdkClientForSigning,
  adaptAwsS3SdkClient,
  buildSignedMerkleManifest,
  computeDailyMerkleRoot,
  createPrismaAuditChainSource,
  type ManifestPublisher,
  type MerkleRootSigner,
} from "@pharmax/security";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

import { createDailyUtcScheduler, type DailyUtcScheduler } from "./daily-utc-scheduler.js";

// Process-scoped state for the audit-manifest freshness gauge.
// Updated on each successful (signed | idempotent) per-org publish;
// observed by the ObservableGauge below on every metric scrape.
//
// Freshness intent: an operator alert fires when
// `now - latest_signed_at_seconds > ~36h` → a nightly run was
// missed. Process restart leaves the map empty until the next
// successful run, which is acceptable (the gauge simply absent
// is itself an alert-worthy condition once the loop has had time
// to run at least once).
const latestSignedAtByOrg = new Map<string, Date>();

const meter = getMeter("@pharmax/worker.security");

meter
  .createObservableGauge("pharmax_audit_manifest_latest_signed_at_seconds", {
    description:
      "Unix seconds since epoch of the most-recent successful Merkle manifest publish, per organization. Stale value indicates a missed nightly signing run.",
    unit: "s",
  })
  .addCallback((result) => {
    for (const [organizationId, signedAt] of latestSignedAtByOrg) {
      result.observe(Math.floor(signedAt.getTime() / 1000), { organization_id: organizationId });
    }
  });

type Logger = loggerContract.Logger;

/**
 * Structured tally returned by `runOnce()` and emitted as the
 * final `merkle.run.complete` log line. Exposed for tests and for
 * the digest probe that turns "yesterday we skipped N orgs" into a
 * line in the nightly digest.
 */
export interface NightlyMerkleRunSummary {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly organizationCount: number;
  /** Manifest published for the first time in this run. */
  readonly orgsSigned: number;
  /** Manifest already existed under Object Lock — counted as a no-op success. */
  readonly orgsIdempotent: number;
  /** Org skipped due to a structured error. */
  readonly orgsFailed: number;
  /** Per-error-code count for the loop's structured log + downstream metrics. */
  readonly errorsByCode: Readonly<Record<string, number>>;
}

export interface NightlyMerkleRootLoopOptions {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Default 02:00 UTC. */
  readonly utcHour?: number;
  readonly utcMinute?: number;
  /** Inject for tests. Defaults to env-resolved signer (KMS prod, Ed25519 dev). */
  readonly signer?: MerkleRootSigner;
  /** Inject for tests. Defaults to env-resolved publisher (S3 prod, in-memory dev). */
  readonly publisher?: ManifestPublisher;
  /**
   * Resolve which UTC day the run signs. Defaults to "yesterday in
   * UTC". Override only for the back-fill script.
   */
  readonly resolveWindow?: (now: Date) => { readonly periodStart: Date; readonly periodEnd: Date };
  /**
   * Environment shape consumed by the default signer / publisher
   * factories. Tests typically inject `signer` + `publisher`
   * directly and omit `env`.
   */
  readonly env?: NightlyMerkleEnv;
  /** Override the clock; tests use a fake. */
  readonly now?: () => Date;
}

export interface NightlyMerkleEnv {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly AWS_REGION?: string | undefined;
  readonly AUDIT_ARCHIVE_S3_BUCKET?: string | undefined;
  readonly AUDIT_ARCHIVE_S3_KMS_KEY_ID?: string | undefined;
  readonly AUDIT_ARCHIVE_RETENTION_YEARS?: number | undefined;
  readonly MERKLE_SIGNER_KMS_KEY_ID?: string | undefined;
}

export interface NightlyMerkleRootLoop {
  readonly scheduler: DailyUtcScheduler;
  start(): void;
  stop(): Promise<void>;
  /** Exposed for tests + the manual back-fill script. */
  runOnce(at?: Date): Promise<NightlyMerkleRunSummary>;
}

function defaultWindow(now: Date): { readonly periodStart: Date; readonly periodEnd: Date } {
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const periodEnd = new Date(todayUtcMidnight);
  const periodStart = new Date(todayUtcMidnight - 86_400_000);
  return { periodStart, periodEnd };
}

/**
 * Map an arbitrary thrown value to a stable error CODE the loop's
 * tally and the auditor's evidence pack can group by. Unknown
 * codes are bucketed as `MERKLE_RUN_UNKNOWN` so a future error
 * class never silently breaks the digest.
 */
function classifyError(cause: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (cause instanceof errors.PharmaxError) {
    return { code: cause.code, message: `${cause.name}: ${cause.message}` };
  }
  if (cause instanceof Error) {
    return { code: "MERKLE_RUN_UNKNOWN", message: `${cause.name}: ${cause.message}` };
  }
  return { code: "MERKLE_RUN_UNKNOWN", message: "unknown" };
}

/**
 * Build the production `KmsAsymmetricSigner` when
 * `MERKLE_SIGNER_KMS_KEY_ID` is set; otherwise fall back to a
 * local Ed25519 signer suitable for dev/test.
 *
 * The AWS SDK is loaded with a dynamic `import()` so that:
 *   - `@pharmax/security` test suites do not resolve the SDK.
 *   - The worker process pays the SDK-load cost exactly once, when
 *     production env vars are present.
 */
export async function buildMerkleSigner(opts: {
  readonly logger: Logger;
  readonly env: NightlyMerkleEnv;
}): Promise<MerkleRootSigner> {
  const { logger, env } = opts;
  const kmsKeyId = env.MERKLE_SIGNER_KMS_KEY_ID;
  const region = env.AWS_REGION;
  if (typeof kmsKeyId === "string" && kmsKeyId.length > 0) {
    if (typeof region !== "string" || region.length === 0) {
      throw new Error(
        "MERKLE_SIGNER_KMS_KEY_ID is set but AWS_REGION is not. The asymmetric KMS signer requires both."
      );
    }
    const { KMSClient } = await import("@aws-sdk/client-kms");
    const sdkClient = new KMSClient({ region });
    const port = adaptAwsKmsSdkClientForSigning(sdkClient);
    logger.info("merkle.signer.kms", { keyArn: kmsKeyId, region });
    return new KmsAsymmetricSigner({ keyArn: kmsKeyId, kmsClient: port });
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to boot Merkle loop in production: MERKLE_SIGNER_KMS_KEY_ID is required. Provision via Terraform and inject through Secrets Manager."
    );
  }
  const seedHex = process.env["PHARMAX_AUDIT_SIGNING_SEED"];
  if (typeof seedHex === "string" && seedHex.length > 0) {
    const seed = Buffer.from(seedHex, "hex");
    if (seed.length !== 32) {
      throw new Error("PHARMAX_AUDIT_SIGNING_SEED must decode to exactly 32 bytes (64 hex chars).");
    }
    logger.info("merkle.signer.local_ed25519", { source: "PHARMAX_AUDIT_SIGNING_SEED" });
    return new LocalEd25519Signer({ seed });
  }
  logger.warn("merkle.signer.local_ed25519_ephemeral", {
    reason:
      "No MERKLE_SIGNER_KMS_KEY_ID or PHARMAX_AUDIT_SIGNING_SEED set; using ephemeral keypair. Manifests will not be verifiable across process restarts.",
  });
  return new LocalEd25519Signer();
}

/**
 * Build the production `S3ObjectLockPublisher` when
 * `AUDIT_ARCHIVE_S3_BUCKET` is set; otherwise fall back to the
 * in-memory publisher.
 *
 * Hard-fails when `AUDIT_ARCHIVE_S3_BUCKET` is set but the SSE-KMS
 * key id is missing — refusing to publish unencrypted into the
 * audit archive is part of the SOC 2 posture.
 */
export async function buildMerklePublisher(opts: {
  readonly logger: Logger;
  readonly env: NightlyMerkleEnv;
}): Promise<ManifestPublisher> {
  const { logger, env } = opts;
  const bucket = env.AUDIT_ARCHIVE_S3_BUCKET;
  if (typeof bucket !== "string" || bucket.length === 0) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Refusing to boot Merkle loop in production: AUDIT_ARCHIVE_S3_BUCKET is required. Provision the Object Lock bucket via Terraform and inject the name through env."
      );
    }
    logger.warn("merkle.publisher.in_memory", {
      reason: "AUDIT_ARCHIVE_S3_BUCKET unset; manifests will be discarded on process exit.",
    });
    return new InMemoryManifestPublisher();
  }
  const kmsKeyId = env.AUDIT_ARCHIVE_S3_KMS_KEY_ID;
  if (typeof kmsKeyId !== "string" || kmsKeyId.length === 0) {
    throw new Error(
      "AUDIT_ARCHIVE_S3_BUCKET is set but AUDIT_ARCHIVE_S3_KMS_KEY_ID is not. SSE-KMS is required for the audit archive."
    );
  }
  const region = env.AWS_REGION;
  if (typeof region !== "string" || region.length === 0) {
    throw new Error("AUDIT_ARCHIVE_S3_BUCKET requires AWS_REGION to be set.");
  }
  const retentionYears = env.AUDIT_ARCHIVE_RETENTION_YEARS ?? 7;
  const retentionDays = retentionYears * 365;
  const { S3Client } = await import("@aws-sdk/client-s3");
  const sdkClient = new S3Client({ region });
  const port = adaptAwsS3SdkClient(sdkClient);
  logger.info("merkle.publisher.s3", { bucket, region, retentionDays });
  return new S3ObjectLockPublisher({
    bucket,
    region,
    retentionDays,
    kmsKeyId,
    s3Client: port,
  });
}

export interface CreateNightlyMerkleRootLoopAsyncOptions extends Omit<
  NightlyMerkleRootLoopOptions,
  "signer" | "publisher"
> {
  /** Tests can still inject. Production: omit; the env-driven factories run. */
  readonly signer?: MerkleRootSigner;
  readonly publisher?: ManifestPublisher;
}

/**
 * Async factory variant: resolves the signer + publisher from env
 * via dynamic AWS SDK imports BEFORE returning the loop handle.
 * The synchronous `createNightlyMerkleRootLoop` below is used by
 * tests that inject the signer + publisher directly.
 */
export async function createNightlyMerkleRootLoopFromEnv(
  options: CreateNightlyMerkleRootLoopAsyncOptions
): Promise<NightlyMerkleRootLoop> {
  const env: NightlyMerkleEnv = options.env ?? { NODE_ENV: "development" };
  const signer = options.signer ?? (await buildMerkleSigner({ logger: options.logger, env }));
  const publisher =
    options.publisher ?? (await buildMerklePublisher({ logger: options.logger, env }));
  return createNightlyMerkleRootLoop({ ...options, signer, publisher });
}

export function createNightlyMerkleRootLoop(
  options: NightlyMerkleRootLoopOptions & {
    readonly signer: MerkleRootSigner;
    readonly publisher: ManifestPublisher;
  }
): NightlyMerkleRootLoop {
  const log = options.logger.child({ component: "nightly-merkle-root" });
  const signer = options.signer;
  const publisher = options.publisher;
  const resolveWindow = options.resolveWindow ?? defaultWindow;
  const utcHour = options.utcHour ?? 2;
  const utcMinute = options.utcMinute ?? 0;
  const clock = options.now ?? (() => new Date());

  // Single shared ChainSource for the run — paginates internally
  // and is safe to reuse across orgs because each iteration passes
  // its own `organizationId`.
  const source = createPrismaAuditChainSource(options.prisma);

  let stopRequested = false;

  async function runForOrg(args: {
    readonly organizationId: string;
    readonly slug: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }): Promise<{ readonly outcome: "signed" | "idempotent" | "failed"; readonly code?: string }> {
    const { organizationId, slug, periodStart, periodEnd } = args;
    try {
      const root = await withSystemContext("security:compute-merkle-root", () =>
        computeDailyMerkleRoot({
          organizationId,
          periodStart,
          periodEnd,
          source,
        })
      );
      const sigOut = await signer.sign({
        rootHash: root.rootHash,
        organizationId,
        periodStart,
        periodEnd,
      });
      const manifest = buildSignedMerkleManifest({
        organizationId,
        periodStart,
        periodEnd,
        computedAt: root.computedAt,
        signedAt: sigOut.signedAt,
        leafCount: root.leafCount,
        firstSeq: root.firstSeq,
        lastSeq: root.lastSeq,
        rootHash: root.rootHash,
        signature: sigOut.signature,
        signerKid: sigOut.signerKid,
        algorithm: sigOut.algorithm,
        signingDomainTag: SIGNING_DOMAIN_TAG,
      });
      const publishResult = await publisher.publish(manifest);
      const outcome = publishResult.idempotent === true ? "idempotent" : "signed";

      // Update the freshness gauge: both "signed" and "idempotent"
      // outcomes prove the manifest for this period exists in the
      // archive. We pin the gauge to sigOut.signedAt rather than
      // publishResult time so the dashboard reports the
      // *signing* recency, which is the auditor's question.
      latestSignedAtByOrg.set(organizationId, sigOut.signedAt);

      log.info(outcome === "idempotent" ? "merkle.run.org.idempotent" : "merkle.run.org.signed", {
        organizationId,
        slug,
        leafCount: root.leafCount,
        firstSeq: root.firstSeq?.toString() ?? null,
        lastSeq: root.lastSeq?.toString() ?? null,
        uri: publishResult.uri,
        eTag: publishResult.eTag,
        versionId: publishResult.versionId,
        retainUntil: publishResult.retainUntilDate?.toISOString(),
        signerKid: sigOut.signerKid,
      });
      return { outcome };
    } catch (cause) {
      const { code, message } = classifyError(cause);
      log.error("merkle.run.org_failed", {
        organizationId,
        slug,
        code,
        errorMessage: message,
      });
      return { outcome: "failed", code };
    }
  }

  async function runOnce(at?: Date): Promise<NightlyMerkleRunSummary> {
    const now = at ?? clock();
    const { periodStart, periodEnd } = resolveWindow(now);
    const orgs = await withSystemContext("security:list-orgs-for-merkle", () =>
      options.prisma.organization.findMany({
        select: { id: true, slug: true },
        orderBy: { slug: "asc" },
      })
    );
    log.info("merkle.run.start", {
      organizationCount: orgs.length,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });

    let orgsSigned = 0;
    let orgsIdempotent = 0;
    let orgsFailed = 0;
    const errorsByCode: Record<string, number> = {};

    for (const org of orgs) {
      if (stopRequested) {
        log.warn("merkle.run.stop_requested_mid_batch", {
          remaining: orgs.length - (orgsSigned + orgsIdempotent + orgsFailed),
        });
        break;
      }
      const result = await runForOrg({
        organizationId: org.id,
        slug: org.slug,
        periodStart,
        periodEnd,
      });
      if (result.outcome === "signed") orgsSigned += 1;
      else if (result.outcome === "idempotent") orgsIdempotent += 1;
      else {
        orgsFailed += 1;
        const code = result.code ?? "MERKLE_RUN_UNKNOWN";
        errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
      }
    }

    const summary: NightlyMerkleRunSummary = {
      periodStart,
      periodEnd,
      organizationCount: orgs.length,
      orgsSigned,
      orgsIdempotent,
      orgsFailed,
      errorsByCode: Object.freeze({ ...errorsByCode }),
    };

    log.info("merkle.run.complete", {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      organizationCount: orgs.length,
      orgsSigned,
      orgsIdempotent,
      orgsFailed,
      errorsByCode: summary.errorsByCode,
    });

    return summary;
  }

  const scheduler = createDailyUtcScheduler({
    name: "nightly-merkle-root",
    utcHour,
    utcMinute,
    runJob: async () => {
      await runOnce();
    },
    logger: options.logger,
  });

  return {
    scheduler,
    start(): void {
      scheduler.start();
    },
    async stop(): Promise<void> {
      stopRequested = true;
      await scheduler.stop();
    },
    runOnce,
  };
}

// The error codes the loop classifies — re-exported so the digest
// probe and tests can assert against the same strings the runtime
// emits. `MERKLE_RUN_UNKNOWN` is the bucket the loop assigns when
// the thrown value is not a `PharmaxError`; production code SHOULD
// never produce it.
export const NIGHTLY_MERKLE_ERROR_CODES = {
  MERKLE_SIGN_FAILED,
  MERKLE_PUBLISH_FAILED,
  MERKLE_PUBLIC_KEY_FETCH_FAILED,
  MERKLE_MANIFEST_OVERWRITE_REFUSED,
  MERKLE_RUN_UNKNOWN: "MERKLE_RUN_UNKNOWN",
} as const;
