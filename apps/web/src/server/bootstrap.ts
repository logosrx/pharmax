// Process-wide singleton boot.
//
// Wires every "configure once, use everywhere" subsystem the web app
// depends on. Imported from `apps/web/instrumentation.ts` (Next.js's
// official one-shot boot hook) so it runs exactly once per Node
// process — even though the Next dev server may import server modules
// many times during the request lifecycle, instrumentation runs once.
//
// Anything that needs a process-wide singleton MUST be wired here:
//   - @pharmax/crypto: KMS adapter (PHI encryption).
//   - @pharmax/rbac: permission loader (when wired in Phase 1.5).
//   - @pharmax/command-bus: Prisma client + clock + logger (when
//     wired with the first route-driven command in Phase 2).
//
// Why a single file:
//   - The order of `configureX` calls is part of the contract
//     (crypto must be ready BEFORE the first PHI read/write).
//   - A reviewer can audit boot in one place — "what runs at process
//     start?" should not require grep across the repo.
//   - If a subsystem fails to configure, the process MUST refuse to
//     serve requests. Centralizing the failure surface here means a
//     misconfig produces ONE clear stack trace at boot, not a stream
//     of cryptic errors per request.
//
// PHI invariant: nothing in this file may read or log PHI. The KMS
// seed itself is high-entropy random and not PHI, but treat it as a
// secret — env.ts validates length and never echoes the value.

import "server-only";

import { buildAuthConfiguration, configureAuth, createArgon2idHasher } from "@pharmax/auth";
import { configureBilling } from "@pharmax/billing";
import { configureCommandBus } from "@pharmax/command-bus";
import { buildKmsAdapterFromEnv } from "@pharmax/composition";
import { configureCrypto } from "@pharmax/crypto";
import { prisma, readReportingInOrgScope, reportingClientIsReplica } from "@pharmax/database";
import { clock } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import {
  configurePackagePhotoStorage,
  InMemoryPackagePhotoStorage,
  S3PackagePhotoStorage,
  type PackagePhotoStorage,
} from "@pharmax/package-capture";
import {
  configureReportReadScope,
  configureReportRunArchive,
  InMemoryReportRunArchive,
  S3ReportRunArchive,
  type ReportRunArchivePort,
} from "@pharmax/reporting";
import {
  configureShipping,
  createEasyPostFactory,
  createFedExFactory,
  createUpsFactory,
} from "@pharmax/shipping";
import {
  initTelemetry,
  resolveTelemetryConfigFromEnv,
  type TelemetryHandle,
} from "@pharmax/telemetry";

import { env } from "./env.js";
import { logger } from "./logger.js";
import { notificationPasswordResetMailer } from "./auth/password-reset-mailer.js";
import { initSentry } from "./observability/sentry-init.js";
import { buildStripeRefundPortFromEnv } from "./billing/stripe-refund-port.js";

let bootPromise: Promise<void> | null = null;

/**
 * Build the report-run archive port. S3 when the env vars are
 * present, else in-memory. The web tier mirrors the worker's
 * fallback so a single-host dev setup keeps consistent behavior
 * across the two processes.
 *
 * The web side mostly READS (operator download path); the
 * worker WRITES (scheduled-run persistence). They MUST point at
 * the same bucket in production so a download attempted on the
 * web tier finds the bytes the worker wrote.
 */
async function buildReportArchive(): Promise<ReportRunArchivePort> {
  const bucket = env.REPORT_ARCHIVE_S3_BUCKET;
  const kmsKeyId = env.REPORT_ARCHIVE_S3_KMS_KEY_ID;
  if (
    typeof bucket !== "string" ||
    bucket.length === 0 ||
    typeof kmsKeyId !== "string" ||
    kmsKeyId.length === 0
  ) {
    if (env.NODE_ENV === "production") {
      logger.warn("apps/web booted without S3 report archive", {
        reason:
          "REPORT_ARCHIVE_S3_BUCKET or REPORT_ARCHIVE_S3_KMS_KEY_ID unset; download route will report unavailable.",
      });
    }
    return new InMemoryReportRunArchive();
  }
  const region = env.AWS_REGION;
  if (typeof region !== "string" || region.length === 0) {
    throw new Error(
      "REPORT_ARCHIVE_S3_BUCKET is set but AWS_REGION is missing. Set both to use the S3 archive."
    );
  }
  // Dynamic import of the AWS SDK keeps it out of the dev cold-
  // start path for clones that don't use S3.
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region });
  return new S3ReportRunArchive({
    bucket,
    kmsKeyId,
    s3: {
      async putObject(input) {
        await client.send(
          new PutObjectCommand({
            Bucket: input.Bucket,
            Key: input.Key,
            Body: input.Body,
            ContentType: input.ContentType,
            ContentLength: input.ContentLength,
            ChecksumSHA256: input.ChecksumSHA256,
            ServerSideEncryption: input.ServerSideEncryption,
            SSEKMSKeyId: input.SSEKMSKeyId,
            Metadata: { ...input.Metadata },
          })
        );
        return {};
      },
      async getObject(input) {
        const response = await client.send(
          new GetObjectCommand({ Bucket: input.Bucket, Key: input.Key })
        );
        const body = response.Body;
        if (body === undefined || body === null) return null;
        const chunks: Buffer[] = [];
        const stream = body as NodeJS.ReadableStream;
        for await (const chunk of stream) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        return {
          Body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          ...(response.ContentType !== undefined ? { ContentType: response.ContentType } : {}),
          ...(response.Metadata !== undefined ? { Metadata: response.Metadata } : {}),
        };
      },
    },
  });
}

/**
 * Build the package-photo storage adapter. Production
 * `S3PackagePhotoStorage` when the env vars are present, else the
 * in-memory dev/test adapter.
 *
 * The S3 adapter writes photo bytes to S3 under SSE-KMS and persists
 * an opaque upload-token row to Postgres so the dispatch step
 * (`CapturePackagePhoto`) can resolve the token across web-tier
 * instances. The in-memory adapter keeps bytes in process memory —
 * a redeploy drops every in-flight capture, so it is dev/staging
 * only.
 *
 * Production HARD-FAILS the boot when unset (unlike
 * `buildReportArchive`, whose in-memory fallback only loses a
 * re-runnable CSV): dock captures are one-shot physical evidence,
 * and per-instance in-memory storage silently loses them whenever
 * the upload and the dispatch land on different instances or a
 * redeploy occurs. Dev/test keep the in-memory adapter. The bucket +
 * KMS key MUST match across instances so an upload routed to
 * instance A and a dispatch routed to instance B resolve the same
 * token row (the token row lives in Postgres, but the bytes live in
 * the shared S3 bucket).
 */
async function buildPackagePhotoStorage(): Promise<{
  readonly storage: PackagePhotoStorage;
  readonly adapterName: "S3PackagePhotoStorage" | "InMemoryPackagePhotoStorage";
}> {
  const bucket = env.S3_PACKAGE_PHOTOS_BUCKET;
  const kmsKeyId = env.S3_PACKAGE_PHOTOS_KMS_KEY_ID;
  if (
    typeof bucket !== "string" ||
    bucket.length === 0 ||
    typeof kmsKeyId !== "string" ||
    kmsKeyId.length === 0
  ) {
    if (env.NODE_ENV === "production") {
      // Hard fail, not a warn-and-degrade: production runs multiple
      // instances behind a load balancer, so an upload accepted by
      // instance A is UNRESOLVABLE when the dispatch lands on
      // instance B — the rep's photo appears to save and then
      // vanishes. A missing bucket must stop the boot, exactly like
      // a missing DATABASE_URL would.
      throw new Error(
        "Refusing to boot in production without S3 package-photo storage: " +
          "set S3_PACKAGE_PHOTOS_BUCKET and S3_PACKAGE_PHOTOS_KMS_KEY_ID. " +
          "In-memory storage is per-instance and loses captures across instances/redeploys."
      );
    }
    return {
      storage: new InMemoryPackagePhotoStorage(),
      adapterName: "InMemoryPackagePhotoStorage",
    };
  }
  const region = env.AWS_REGION;
  if (typeof region !== "string" || region.length === 0) {
    throw new Error(
      "S3_PACKAGE_PHOTOS_BUCKET is set but AWS_REGION is missing. Set both to use S3 package-photo storage."
    );
  }
  // Dynamic import keeps the AWS SDK out of the dev cold-start path
  // for clones that don't use S3 (mirrors buildReportArchive).
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region });
  return {
    adapterName: "S3PackagePhotoStorage",
    storage: new S3PackagePhotoStorage({
      prisma,
      bucket,
      kmsKeyId,
      s3: {
        async putObject(input) {
          const result = await client.send(
            new PutObjectCommand({
              Bucket: input.Bucket,
              Key: input.Key,
              Body: input.Body,
              ContentType: input.ContentType,
              ContentLength: input.ContentLength,
              ChecksumSHA256: input.ChecksumSHA256,
              ServerSideEncryption: input.ServerSideEncryption,
              SSEKMSKeyId: input.SSEKMSKeyId,
              Metadata: { ...input.Metadata },
            })
          );
          return {
            ...(result.ETag !== undefined ? { ETag: result.ETag } : {}),
            ...(result.VersionId !== undefined ? { VersionId: result.VersionId } : {}),
          };
        },
        async getObject(input) {
          // Map a missing object to `null` (the image route 404s);
          // re-throw anything else so a perms/network fault surfaces
          // as a 5xx instead of a misleading "not found".
          try {
            const response = await client.send(
              new GetObjectCommand({ Bucket: input.Bucket, Key: input.Key })
            );
            const body = response.Body;
            if (body === undefined || body === null) return null;
            const chunks: Buffer[] = [];
            const stream = body as NodeJS.ReadableStream;
            for await (const chunk of stream) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
            }
            const buf = Buffer.concat(chunks);
            return {
              Body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
              ...(response.ContentType !== undefined ? { ContentType: response.ContentType } : {}),
            };
          } catch (cause) {
            if (isS3NotFound(cause)) return null;
            throw cause;
          }
        },
      },
    }),
  };
}

/**
 * True when an AWS SDK error represents a missing object. The v3
 * SDK throws a `NoSuchKey` (named error) for a GET on a key that
 * doesn't exist; some endpoints surface it as a 404 in
 * `$metadata.httpStatusCode`. Match both so a swept/never-written
 * object resolves to a 404 rather than a 5xx.
 */
function isS3NotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const name = (cause as { name?: unknown }).name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  const status = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * Idempotent async boot. Safe to call multiple times — concurrent
 * callers receive the same in-flight Promise. Designed to be awaited
 * once from `instrumentation.ts`.
 *
 * Order matters:
 *   1. Sentry FIRST — so any exception thrown by later boot steps
 *      (e.g. KMS misconfig) reaches Sentry instead of dying silently.
 *   2. Crypto / KMS — required before any PHI read or write. In
 *      production this is `AwsKmsAdapter` and we call `validate()`
 *      so an IAM misconfig surfaces at boot, not at first PHI access.
 *   3. RBAC + command-bus — required for operator-driven routes.
 */
export function bootstrap(): Promise<void> {
  if (bootPromise === null) {
    bootPromise = doBootstrap();
  }
  return bootPromise;
}

let telemetryHandle: TelemetryHandle | null = null;

/**
 * Exposed for graceful-shutdown call sites (worker / print-agent
 * have an explicit signal-handling phase; the web tier does not,
 * but a future ECS pre-stop hook can flush by calling this).
 */
export function getWebTelemetryHandle(): TelemetryHandle | null {
  return telemetryHandle;
}

async function doBootstrap(): Promise<void> {
  // -1. Identity-layer config gate (ADR-0030, in-house engine).
  //
  // SUPPORT_EMAIL is required in production so the invitation-only
  // sign-up surface renders a real mailto link. The password pepper
  // and session policy are wired in step 6 below (warns, not
  // hard-fails, when the pepper is unset so a partial rollout still
  // boots while the secret is provisioned).
  enforceIdentityProductionConfig();

  // 0. OpenTelemetry FIRST.
  //
  // The Node auto-instrumentations work by monkey-patching module
  // prototypes (http, pg, aws-sdk, ...). They install hooks at
  // require-time / import-time. Calling initTelemetry() before
  // any subsequent imports in `doBootstrap` ensures the hooks see
  // those modules. We tolerate failure: telemetry is observability,
  // not safety — a broken collector must NEVER block the app from
  // booting and serving requests. `initTelemetry` already returns a
  // no-op handle on any error and logs the diagnostic.
  const telemetryConfig = resolveTelemetryConfigFromEnv({
    serviceName: "pharmacy-web",
    nodeEnv: env.NODE_ENV,
  });
  telemetryHandle = await initTelemetry({
    config: telemetryConfig,
    onBootDiagnostic: (level, event, details) => {
      logger[level](event, details);
    },
  });
  if (env.NODE_ENV === "production" && !telemetryHandle.enabled) {
    logger.warn("apps/web booted in production without OpenTelemetry", {
      reason: "OTEL_ENABLED is not truthy or SDK init failed",
    });
  }

  // 1. Sentry. No-ops when SENTRY_DSN is unset; emits a warning when
  // we're in production without a DSN so prod misconfig is loud.
  const sentryReady = initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE,
  });

  if (env.NODE_ENV === "production" && !sentryReady) {
    logger.warn("apps/web booted in production without Sentry", {
      reason: "SENTRY_DSN not configured",
    });
  }

  // 2. @pharmax/crypto — wire the KMS adapter.
  //
  // Production: AwsKmsAdapter against customer-managed KMS keys
  // provisioned by Terraform (see infra/terraform/modules/kms). The
  // ECS task role grants the runtime IAM principal access to:
  //   - kms:GenerateDataKey + kms:Decrypt on the ENCRYPT_DECRYPT key
  //   - kms:GenerateMac on the GENERATE_VERIFY_MAC (HMAC_256) key
  //   - kms:DescribeKey on both (for the boot-time validate())
  //
  // Dev / test: LocalKmsAdapter with a static seed. The two paths
  // are mutually exclusive — production refuses LocalKmsAdapter,
  // dev refuses to silently fall back to AwsKmsAdapter if AWS env
  // is partially configured (we'd rather fail loud).
  const { kms, adapterName } = await buildKmsAdapterFromEnv({
    env,
    logger,
    processName: "apps/web",
  });
  configureCrypto({ kms });

  // 3. @pharmax/shipping — register one factory per supported
  // carrier. Per-org credentials live in `carrier_credential`
  // (envelope-encrypted via @pharmax/crypto); the factories above
  // get invoked at call time inside `resolveShippingAdapter` with
  // the decrypted credential context. Registering all three at
  // boot makes "add a fourth carrier" a one-line change here, and
  // means an unconfigured-provider call fails with a clear
  // `SHIPPING_PROVIDER_NOT_REGISTERED` instead of going through
  // the wrong adapter. Crypto MUST be wired first (above) — the
  // factories themselves do not touch crypto, but
  // `resolveShippingAdapter` will the moment a request reaches it.
  configureShipping({
    factories: {
      EASYPOST: createEasyPostFactory(),
      FEDEX: createFedExFactory(),
      UPS: createUpsFactory(),
    },
  });

  // 3.1 @pharmax/package-capture — wire the package-photo storage
  // adapter that backs `CapturePackagePhoto`'s upload-token resolver
  // and the multipart `beginUpload` HTTP route (used by both the
  // dock-capture orchestrator and the JSON upload route).
  //
  // Production: `S3PackagePhotoStorage` (when S3_PACKAGE_PHOTOS_BUCKET
  // + S3_PACKAGE_PHOTOS_KMS_KEY_ID + AWS_REGION are set) writes bytes
  // to S3 under SSE-KMS and persists the opaque upload-token row to
  // Postgres so the upload and dispatch steps resolve across web-tier
  // instances.
  //
  // Dev / staging (or prod without the env vars): the in-memory
  // adapter keeps bytes in process memory keyed by
  // `(organizationId, sha256)`. A redeploy drops every in-flight
  // capture — acceptable for non-prod, loud-warned in prod (see
  // buildPackagePhotoStorage). Crypto MUST be wired first (above):
  // the S3 adapter relies on the SSE-KMS key referenced by
  // S3_PACKAGE_PHOTOS_KMS_KEY_ID, which is the same KMS surface the
  // rest of the app uses.
  const packagePhotoStorage = await buildPackagePhotoStorage();
  configurePackagePhotoStorage({ storage: packagePhotoStorage.storage });

  // 3.2 @pharmax/reporting CSV archive. Web tier needs READ access
  // (the `/api/ops/reports/runs/[id]/download` route streams the
  // CSV from the archive to the browser) and may eventually need
  // WRITE access for an "operator-initiated runs also persist"
  // checkbox. When the S3 bucket + KMS key are configured, wire
  // the production adapter; otherwise fall back to in-memory
  // (matches the worker's fallback so a single-process dev setup
  // stays consistent).
  const reportArchive: ReportRunArchivePort = await buildReportArchive();
  configureReportRunArchive({ archive: reportArchive });

  // Route report READS to the reporting replica (when
  // REPORTING_DATABASE_URL is set) so heavy analytical scans don't
  // burden the OLTP primary. The report_run write + audit + outbox
  // stay on the primary command tx. No replica configured →
  // `reportingPrisma` is the primary and reads run there (the
  // pre-replica behavior); we still wire the scope so the read
  // runs on its own tenant-scoped read tx rather than the command
  // write tx.
  configureReportReadScope({
    usingReplica: reportingClientIsReplica,
    read: (organizationId, fn) => readReportingInOrgScope(organizationId, (tx) => fn(tx)),
  });
  if (reportingClientIsReplica) {
    logger.info("apps/web reporting reads routed to replica", {
      event: "reporting.replica.enabled",
    });
  }

  // 4. @pharmax/billing — wire the Stripe refund port so the
  // operator-driven `IssueRefund` command can reach Stripe from
  // the web tier (it runs synchronously on operator click; the
  // ~500ms Stripe roundtrip is acceptable click latency). The
  // refund port is `null` when STRIPE_SECRET_KEY is unset; the
  // command surfaces `BILLING_REFUND_NOT_CONFIGURED` with a clear
  // operator-facing message in that case.
  const stripeRefundPort = buildStripeRefundPortFromEnv();
  configureBilling({ stripeRefundPort });

  // 5. @pharmax/rbac + @pharmax/command-bus — required for any
  // operator-driven HTTP route that dispatches a domain command
  // (e.g. /api/ops/orders/:id/resolve-escalation). The RBAC
  // loader resolves the operator's effective permission set
  // against `user_role` + `role_permission` rows; the command
  // bus binds Prisma + clock + logger so `executeCommand` can run
  // inside the route handler with the same audit/outbox/CAS
  // guarantees as the worker drains.
  configureRbac({ loader: new PrismaPermissionLoader(prisma) });
  configureCommandBus({
    prisma,
    clock: clock.systemClock,
    logger: logger.child({ component: "command-bus" }),
  });

  // 6. @pharmax/auth — the in-house identity engine (ADR-0030).
  //
  // The Argon2id hasher is wired with a KMS/Secrets-Manager-sourced
  // pepper (AUTH_PASSWORD_PEPPER, base64). Unlike the per-hash salt,
  // the pepper is never stored with the hash, so a DB-only breach
  // cannot verify passwords. Dev/test may run without a pepper; we
  // warn (not hard-fail) in production so a partial rollout still
  // boots while the secret is provisioned.
  const pepper =
    typeof env.AUTH_PASSWORD_PEPPER === "string" && env.AUTH_PASSWORD_PEPPER.length > 0
      ? new Uint8Array(Buffer.from(env.AUTH_PASSWORD_PEPPER, "base64"))
      : null;
  if (pepper === null && env.NODE_ENV === "production") {
    logger.warn("apps/web booted without AUTH_PASSWORD_PEPPER", {
      reason: "password hashing runs without a pepper; provision via Secrets Manager.",
    });
  }
  configureAuth(
    buildAuthConfiguration({
      clock: clock.systemClock,
      hasher: createArgon2idHasher({ pepper }),
      // Credential-setup link delivery (invite + reset). Dev logs the
      // link; production email send over the notifications channel is
      // the remaining notifications-slice wiring.
      passwordResetMailer: notificationPasswordResetMailer,
    })
  );

  logger.info("apps/web bootstrap complete", {
    nodeEnv: env.NODE_ENV,
    cryptoAdapter: adapterName,
    shippingProviders: ["EASYPOST", "FEDEX", "UPS"],
    packagePhotoStorage: packagePhotoStorage.adapterName,
    stripeRefundReady: stripeRefundPort !== null,
    sentryReady,
    telemetryReady: telemetryHandle?.enabled === true,
  });
}

/**
 * Hard-fail the boot when production is missing `SUPPORT_EMAIL`.
 *
 * The in-house identity engine (ADR-0030) has no external identity
 * provider to configure — password/session/MFA are owned in-process
 * and wired in step 6. `SUPPORT_EMAIL` is required so the
 * invitation-only sign-up surface renders a real mailto contact
 * instead of a placeholder. Dev / test bypass the gate.
 */
function enforceIdentityProductionConfig(): void {
  if (env.NODE_ENV !== "production") return;
  if (env.SUPPORT_EMAIL) return;
  throw new Error(
    "Refusing to boot apps/web in production: SUPPORT_EMAIL is unset. " +
      "Provision it via Secrets Manager so the invitation-only sign-up surface " +
      "renders a support contact."
  );
}
