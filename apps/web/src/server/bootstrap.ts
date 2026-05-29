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

import { configureBilling } from "@pharmax/billing";
import { configureCommandBus } from "@pharmax/command-bus";
import {
  AwsKmsAdapter,
  configureCrypto,
  createAwsKmsClient,
  LocalKmsAdapter,
  type KmsAdapter,
} from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { clock } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import {
  configurePackagePhotoStorage,
  InMemoryPackagePhotoStorage,
} from "@pharmax/package-capture";
import {
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
  // -1. Identity-layer config gate.
  //
  // Clerk is the source of truth for "is this a real human?". A
  // production deployment that boots without `CLERK_SECRET_KEY`,
  // `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, or `CLERK_WEBHOOK_SECRET`
  // is degraded by definition: sign-in is broken, off-boarding
  // (user.deleted webhook) doesn't fire, and operators with stale
  // sessions stay alive past their Clerk-side termination. We
  // refuse to boot rather than serve in that state.
  //
  // SUPPORT_EMAIL is required so the production sign-up "closed"
  // page renders a real mailto link instead of a placeholder.
  //
  // Same hard-fail shape as the AWS KMS gate (see `buildKmsAdapter`).
  enforceClerkProductionConfig();

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
  const { kms, adapterName } = await buildKmsAdapter();
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
  // and the multipart `beginUpload` HTTP route.
  //
  // Today (Phase 5 backend slice) we wire the in-memory adapter
  // unconditionally: the operator UI is JS-driven and posts photos
  // to the web tier, which forwards them to the configured adapter;
  // the in-memory adapter keeps bytes in process memory keyed by
  // `(organizationId, sha256)`. That's deliberately a no-op for
  // production durability — the production `S3PackagePhotoStorage`
  // adapter is a follow-up that wires SSE-KMS encryption + the
  // pre-signed-URL variant for client-direct uploads. A misconfig
  // there will surface here as `PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED`
  // on first dispatch, NOT as a silent fallback.
  //
  // Process-memory storage means a Next.js redeploy drops every
  // captured photo that hasn't been flushed downstream — acceptable
  // for the dev / staging slice; the S3 adapter closes that loop in
  // the same PR as the dock-side capture UI lands.
  configurePackagePhotoStorage({
    storage: new InMemoryPackagePhotoStorage(),
  });

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

  logger.info("apps/web bootstrap complete", {
    nodeEnv: env.NODE_ENV,
    cryptoAdapter: adapterName,
    shippingProviders: ["EASYPOST", "FEDEX", "UPS"],
    packagePhotoStorage: "InMemoryPackagePhotoStorage",
    stripeRefundReady: stripeRefundPort !== null,
    sentryReady,
    telemetryReady: telemetryHandle?.enabled === true,
  });
}

/**
 * Build and validate the KMS adapter for this process. The decision
 * tree:
 *
 *   NODE_ENV=production
 *     ALL FOUR of AWS_REGION / AWS_KMS_DATA_KEY_ID / AWS_KMS_SEARCH_KEY_ID
 *       (the fourth, AWS_KMS_KEY_LABEL, has a default) are required.
 *     If any is missing → throw a clear hard-fail (refuse to boot).
 *     If all present → `new AwsKmsAdapter(...)` + `validate()`.
 *
 *   NODE_ENV=development | test
 *     If AWS_KMS_DATA_KEY_ID is set → use AwsKmsAdapter (engineer is
 *       explicitly testing against AWS). PHARMAX_LOCAL_KMS_SEED is
 *       ignored.
 *     Otherwise → LocalKmsAdapter against PHARMAX_LOCAL_KMS_SEED
 *       (which the env schema requires when present, so we'll error
 *       at env-validation time if both are unset and we're not in
 *       production).
 */
async function buildKmsAdapter(): Promise<{
  readonly kms: KmsAdapter;
  readonly adapterName: "AwsKmsAdapter" | "LocalKmsAdapter";
}> {
  const region = env.AWS_REGION;
  const dataKeyId = env.AWS_KMS_DATA_KEY_ID;
  const searchKeyId = env.AWS_KMS_SEARCH_KEY_ID;
  const label = env.AWS_KMS_KEY_LABEL ?? "app-phi";

  const allAwsPresent =
    typeof region === "string" &&
    region.length > 0 &&
    typeof dataKeyId === "string" &&
    dataKeyId.length > 0 &&
    typeof searchKeyId === "string" &&
    searchKeyId.length > 0;

  if (env.NODE_ENV === "production") {
    if (!allAwsPresent) {
      throw new Error(
        "Refusing to boot apps/web in production: AWS_REGION, AWS_KMS_DATA_KEY_ID, and AWS_KMS_SEARCH_KEY_ID must all be set. " +
          "Provision the KMS keys via infra/terraform/modules/kms and inject the ARNs through Secrets Manager."
      );
    }
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
    });
    // Round-trip the IAM contract once at boot. If the task role
    // is missing kms:DescribeKey we want to know now, not at the
    // first PHI write.
    await kms.validate();
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  // dev / test
  if (allAwsPresent) {
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
    });
    await kms.validate();
    logger.warn("apps/web wired AwsKmsAdapter under NODE_ENV != production", {
      reason: "AWS_KMS_* env present in non-prod environment",
    });
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  const seed = env.PHARMAX_LOCAL_KMS_SEED;
  if (typeof seed !== "string" || seed.length < 32) {
    throw new Error(
      "Refusing to boot apps/web: neither AWS KMS config nor PHARMAX_LOCAL_KMS_SEED is present. " +
        "Set PHARMAX_LOCAL_KMS_SEED (>=32 chars) for local dev, or wire AWS_KMS_DATA_KEY_ID / AWS_KMS_SEARCH_KEY_ID."
    );
  }
  return {
    kms: new LocalKmsAdapter({ seed }),
    adapterName: "LocalKmsAdapter",
  };
}

/**
 * Hard-fail the boot when production is missing any Clerk identity
 * variable or `SUPPORT_EMAIL`.
 *
 * Why hard-fail rather than warn:
 *
 *   - `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` —
 *     missing either makes sign-in non-functional. The app would
 *     boot but every operator request would 401.
 *   - `CLERK_WEBHOOK_SECRET` — missing means
 *     `/api/webhooks/clerk` returns 503 forever, so off-boarding
 *     (user.deleted) never fires, leaving terminated operators
 *     with live Pharmax rows.
 *   - `SUPPORT_EMAIL` — missing means the production sign-up
 *     "closed" page renders without a contact link. That's a UX
 *     bug, not a security bug, but it's the kind of bug we'd
 *     rather catch at boot than after a customer hits it.
 *
 * Dev / test boots without any of these and bypasses the gate
 * entirely (Clerk Keyless dev mode auto-generates keys; the
 * webhook route returns 503 explicitly).
 */
function enforceClerkProductionConfig(): void {
  if (env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) missing.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  if (!env.CLERK_SECRET_KEY) missing.push("CLERK_SECRET_KEY");
  if (!env.CLERK_WEBHOOK_SECRET) missing.push("CLERK_WEBHOOK_SECRET");
  if (!env.SUPPORT_EMAIL) missing.push("SUPPORT_EMAIL");

  if (missing.length === 0) return;

  throw new Error(
    "Refusing to boot apps/web in production: required identity-layer env vars are unset: " +
      missing.join(", ") +
      ". Provision these via Secrets Manager (Clerk dashboard → Webhooks for the webhook secret). " +
      "See docs/RUNBOOK.md → 'Rotating CLERK_WEBHOOK_SECRET'."
  );
}
