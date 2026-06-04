// Worker entry point.
//
// Boots two long-lived poll loops (Stripe webhook drain, event outbox
// drain) against the singleton Prisma client, then waits for SIGINT/
// SIGTERM. On signal:
//   1. Stop accepting new ticks.
//   2. Wait for any in-flight tick to finish (with a hard ceiling
//      from SHUTDOWN_TIMEOUT_MS).
//   3. Disconnect Prisma.
//   4. Exit 0 on clean shutdown, 1 on shutdown timeout.
//
// Any uncaught throw at startup exits 1 immediately (no Prisma
// disconnect needed since the connection wasn't used yet).

import { configureBilling, type StripeInvoicePort } from "@pharmax/billing";
import { configureCommandBus } from "@pharmax/command-bus";
import {
  AwsKmsAdapter,
  configureCrypto,
  createAwsKmsClient,
  LocalKmsAdapter,
  type KmsAdapter,
} from "@pharmax/crypto";
import {
  configureNotifications,
  InMemoryNotificationChannel,
  PersistentNotificationChannel,
  type NotificationChannel,
} from "@pharmax/notifications";
import { billing, clock } from "@pharmax/platform-core";
import {
  billing as databaseBilling,
  prisma,
  readReportingInOrgScope,
  reportingClientIsReplica,
} from "@pharmax/database";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import {
  configureReportReadScope,
  configureReportRunArchive,
  InMemoryReportRunArchive,
  S3ReportRunArchive,
  type ReportRunArchivePort,
  type S3ReportRunArchiveSurface,
} from "@pharmax/reporting";
import { CmsNppesClient } from "@pharmax/providers";
import {
  configureShipping,
  createEasyPostFactory,
  createFedExFactory,
  createUpsFactory,
  PrismaEasyPostWebhookEventStore,
} from "@pharmax/shipping";
import {
  initTelemetry,
  resolveTelemetryConfigFromEnv,
  type TelemetryHandle,
} from "@pharmax/telemetry";
import Stripe from "stripe";

import { createStripeInvoiceAdapter } from "./billing/stripe-invoice-adapter.js";
import { createStripeRefundAdapter } from "./billing/stripe-refund-adapter.js";
import {
  createQuarterlyAccessReviewLoop,
  FilesystemEvidencePublisher,
} from "./compliance/access-review-job.js";
import { PrismaNotificationDeliveryStore } from "./notifications/prisma-notification-delivery-store.js";
import { ResendNotificationChannel } from "./notifications/resend-notification-channel.js";
import { createEasyPostWebhookDrainer } from "./drains/easypost-webhook-event-drainer.js";
import { createOutboxDrainer } from "./drains/event-outbox-drainer.js";
import { createFedExTrackingPoller } from "./drains/fedex-tracking-poller.js";
import { createNpiSyncScheduler } from "./drains/npi-sync-scheduler.js";
import { createOutboxHandlers } from "./drains/outbox-handlers.js";
import { createExpiredPackagePhotoUploadTokenReaper } from "./drains/reap-expired-package-photo-upload-tokens.js";
import {
  createOrphanPackagePhotoObjectSweeper,
  type PackagePhotoObjectStore,
} from "./drains/sweep-orphan-package-photo-objects.js";
import { createStuckNpiSyncRunReaper } from "./drains/reap-stuck-npi-sync-runs.js";
import { createReportScheduler } from "./drains/report-scheduler.js";
import { createSlaBreachEvaluator } from "./drains/sla-breach-evaluator.js";
import { createEasyPostTargetResolver } from "./drains/shipping-lookups.js";
import { createUpsTrackingPoller } from "./drains/ups-tracking-poller.js";
import { createStripeWebhookDrainer } from "./drains/stripe-webhook-event-drainer.js";
import { createStripeEventHandlers } from "./drains/stripe-handlers.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { createWorkflowBucketScraper } from "./metrics/workflow-bucket-scraper.js";
import { flushSentry, initSentry } from "./observability/sentry-init.js";
import { createLivenessHeartbeat } from "./runtime/liveness.js";
import { createPollLoop } from "./runtime/poll-loop.js";
import { createDailyAuditChainVerifierLoop } from "./security/audit-chain-verifier-loop.js";
import { createNightlyMerkleRootLoopFromEnv } from "./security/daily-merkle-root-loop.js";
import { createNightlySecurityDigestLoop } from "./security/nightly-security-digest-loop.js";
import { NotificationChannelDigestPublisher } from "./security/notification-channel-digest-publisher.js";

let workerTelemetryHandle: TelemetryHandle | null = null;

async function main(): Promise<void> {
  // 0. OpenTelemetry. Must run before subsequent imports load any
  // instrumented module surface (http / pg / aws-sdk). The drainers
  // perform Prisma + outbound HTTP + AWS calls every tick, so OTel
  // hooks must be active before the first drainer is constructed.
  // Failure is non-fatal — observability never blocks safety.
  const telemetryConfig = resolveTelemetryConfigFromEnv({
    serviceName: "pharmacy-worker",
    nodeEnv: env.NODE_ENV,
  });
  workerTelemetryHandle = await initTelemetry({
    config: telemetryConfig,
    onBootDiagnostic: (level, event, details) => {
      logger[level](event, details);
    },
  });
  if (env.NODE_ENV === "production" && !workerTelemetryHandle.enabled) {
    logger.warn("worker.booted_without_telemetry", {
      reason: "OTEL_ENABLED is not truthy or SDK init failed",
    });
  }

  // 1. Sentry — uncaughtException / unhandledRejection hooks
  // are registered as a side effect, so a misconfig in subsequent
  // init steps still surfaces as a reported error.
  const sentryReady = initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    serverName: "pharmacy-worker",
  });
  if (env.NODE_ENV === "production" && !sentryReady) {
    logger.warn("worker.booted_without_sentry", { reason: "SENTRY_DSN not configured" });
  }

  // 2. Configure process-wide singletons BEFORE any drainer can run.
  // The outbox drainer dispatches handlers that may decrypt PHI
  // fields; @pharmax/crypto MUST be wired before the first tick.
  //
  // Production: AwsKmsAdapter against customer-managed KMS keys.
  // The worker calls `kms.validate()` at boot to surface IAM
  // misconfig (most common: ECS task role missing kms:DescribeKey)
  // BEFORE the first drain tick, not as a per-tick failure
  // cascade.
  //
  // Dev / test: LocalKmsAdapter. MUST share the same
  // PHARMAX_LOCAL_KMS_SEED as apps/web, or rows wrapped by one
  // process are undecryptable by the other.
  const { kms, adapterName } = await buildWorkerKmsAdapter();
  configureCrypto({ kms });

  // The EasyPost webhook drain executes `RecordShipmentTrackingEvent`
  // through the standard command bus inside per-org tenancy. Wire
  // RBAC + command-bus once at boot so the drain can call
  // `executeCommand` directly without per-tick configuration.
  configureRbac({ loader: new PrismaPermissionLoader(prisma) });
  configureCommandBus({
    prisma,
    clock: clock.systemClock,
    logger: logger.child({ component: "command-bus" }),
  });

  // Report CSV archive. When both env vars are set, wire the S3
  // adapter; otherwise fall back to an in-memory archive so dev
  // environments still work without S3. The `RunReport` handler
  // soft-skips persistence when no archive is configured —
  // `configureReportRunArchive` always sets ONE so the singleton
  // never returns null in production.
  const reportArchive: ReportRunArchivePort =
    typeof env.REPORT_ARCHIVE_S3_BUCKET === "string" &&
    env.REPORT_ARCHIVE_S3_BUCKET.length > 0 &&
    typeof env.REPORT_ARCHIVE_S3_KMS_KEY_ID === "string" &&
    env.REPORT_ARCHIVE_S3_KMS_KEY_ID.length > 0
      ? new S3ReportRunArchive({
          s3: await buildS3ReportArchiveSurface(env.AWS_REGION),
          bucket: env.REPORT_ARCHIVE_S3_BUCKET,
          kmsKeyId: env.REPORT_ARCHIVE_S3_KMS_KEY_ID,
        })
      : new InMemoryReportRunArchive();
  configureReportRunArchive({ archive: reportArchive });

  // Route scheduled-report READS to the reporting replica (when
  // REPORTING_DATABASE_URL is set) so the worker's analytical
  // scans don't burden the OLTP primary. report_run + audit +
  // outbox stay on the primary command tx.
  configureReportReadScope({
    usingReplica: reportingClientIsReplica,
    read: (organizationId, fn) => readReportingInOrgScope(organizationId, (tx) => fn(tx)),
  });
  if (reportingClientIsReplica) {
    logger.info("worker.reporting.replica_enabled", {
      event: "reporting.replica.enabled",
    });
  }

  if (env.NODE_ENV === "production" && !(reportArchive instanceof S3ReportRunArchive)) {
    logger.warn("worker.booted_without_report_archive_s3", {
      reason:
        "REPORT_ARCHIVE_S3_BUCKET or REPORT_ARCHIVE_S3_KMS_KEY_ID unset; scheduled-run CSVs persisted in-memory only.",
    });
  }

  // Notifications. The scheduled-report outbox handler resolves
  // the configured channel at dispatch time via
  // `getNotificationChannel()`; we wire either the production
  // Resend channel (when RESEND_API_KEY + NOTIFICATION_FROM_EMAIL
  // are present) or an in-memory channel for dev/test. Production
  // boots without these set still works — the handler logs +
  // skips when the channel isn't configured, so a missed env var
  // doesn't keep the worker from running every other drain.
  const baseNotificationChannel: NotificationChannel =
    typeof env.RESEND_API_KEY === "string" &&
    env.RESEND_API_KEY.length > 0 &&
    typeof env.NOTIFICATION_FROM_EMAIL === "string" &&
    env.NOTIFICATION_FROM_EMAIL.length > 0
      ? new ResendNotificationChannel({
          apiKey: env.RESEND_API_KEY,
          fromAddress: env.NOTIFICATION_FROM_EMAIL,
        })
      : new InMemoryNotificationChannel({ supportedRecipientKinds: ["email"] });
  // Wrap the transport in the persistence decorator so every
  // tenant-scoped send writes a `notification_delivery` row
  // (QUEUED → SENT/FAILED). The Resend delivery webhook later
  // advances the row to DELIVERED/BOUNCED/etc. Store-write
  // failures are non-fatal (logged via onStoreError) — a delivery
  // ledger hiccup must never turn a sent email into a failed
  // outbox row that would trigger a duplicate resend.
  const notificationChannel: NotificationChannel = new PersistentNotificationChannel({
    inner: baseNotificationChannel,
    store: new PrismaNotificationDeliveryStore({ prisma }),
    onStoreError: (stage, cause) => {
      logger.warn("worker.notification_delivery.store_error", {
        stage,
        error: cause,
      });
    },
  });
  configureNotifications({ channel: notificationChannel });
  if (env.NODE_ENV === "production" && notificationChannel.metadata.name !== "resend-email") {
    logger.warn("worker.booted_without_resend", {
      reason:
        "RESEND_API_KEY or NOTIFICATION_FROM_EMAIL unset; scheduled-report emails will be skipped.",
    });
  }

  // Nightly security digest publisher selection — computed here so
  // the boot-log dump + the loop construction both reference the
  // same source of truth.
  //
  // When NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL is set AND the
  // worker's Resend channel is wired, we deliver the digest as an
  // email via NotificationChannelDigestPublisher → the existing
  // SECURITY_DIGEST_DAILY_V1 template → Resend → operator. Otherwise
  // the loop falls back to the in-memory publisher and the
  // structured `digest.published` log line remains the SOC 2
  // evidence.
  //
  // The PHI sentinel gate on the template is `phiAllowed: false`
  // by intent — the digest is non-PHI by construction; a future
  // regression that accidentally embedded a `patientName` key in
  // the context payload would fail closed at the channel boundary
  // before any bytes leave the process.
  const digestRecipient = env.NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL;
  const digestRecipientConfigured =
    typeof digestRecipient === "string" && digestRecipient.length > 0;
  const resendChannelWired = notificationChannel.metadata.name === "resend-email";
  const securityDigestPublisher =
    digestRecipientConfigured && resendChannelWired
      ? new NotificationChannelDigestPublisher({
          channel: notificationChannel,
          recipientEmail: digestRecipient as string,
        })
      : undefined;

  // @pharmax/shipping factory registry. The FedEx + UPS tracking
  // pollers instantiate clients directly (they decrypt the
  // credential then build a typed client), but `PurchaseShipmentLabel`
  // and `RecordShipmentTrackingEvent` reach for `getShippingAdapterFactory`
  // and would throw `SHIPPING_NOT_CONFIGURED` without this call.
  // Listing all three providers here keeps factory registration as
  // the single source of truth — adding a fourth carrier means one
  // line here, not a hunt across packages.
  configureShipping({
    factories: {
      EASYPOST: createEasyPostFactory(),
      FEDEX: createFedExFactory(),
      UPS: createUpsFactory(),
    },
  });

  logger.info("worker.boot", {
    nodeEnv: env.NODE_ENV,
    pid: process.pid,
    cryptoAdapter: adapterName,
    stripeDrain: {
      batchSize: env.STRIPE_DRAIN_BATCH_SIZE,
      intervalMs: env.STRIPE_DRAIN_INTERVAL_MS,
      leaseMs: env.STRIPE_DRAIN_LEASE_MS,
    },
    outboxDrain: {
      batchSize: env.OUTBOX_DRAIN_BATCH_SIZE,
      intervalMs: env.OUTBOX_DRAIN_INTERVAL_MS,
      leaseMs: env.OUTBOX_DRAIN_LEASE_MS,
      maxAttempts: env.OUTBOX_DRAIN_MAX_ATTEMPTS,
    },
    easyPostDrain: {
      batchSize: env.EASYPOST_DRAIN_BATCH_SIZE,
      intervalMs: env.EASYPOST_DRAIN_INTERVAL_MS,
      leaseMs: env.EASYPOST_DRAIN_LEASE_MS,
    },
    fedexTrackingPoll: {
      batchSize: env.FEDEX_TRACKING_POLL_BATCH_SIZE,
      intervalMs: env.FEDEX_TRACKING_POLL_INTERVAL_MS,
      staleThresholdMs: env.FEDEX_TRACKING_POLL_STALE_THRESHOLD_MS,
    },
    upsTrackingPoll: {
      batchSize: env.UPS_TRACKING_POLL_BATCH_SIZE,
      intervalMs: env.UPS_TRACKING_POLL_INTERVAL_MS,
      staleThresholdMs: env.UPS_TRACKING_POLL_STALE_THRESHOLD_MS,
    },
    reportScheduler: {
      batchSize: env.REPORT_SCHEDULER_BATCH_SIZE,
      intervalMs: env.REPORT_SCHEDULER_INTERVAL_MS,
    },
    slaBreachEvaluator: {
      batchSize: env.SLA_BREACH_EVAL_BATCH_SIZE,
      intervalMs: env.SLA_BREACH_EVAL_INTERVAL_MS,
    },
    npiSyncScheduler: {
      batchSize: env.NPI_SYNC_SCHEDULER_BATCH_SIZE,
      intervalMs: env.NPI_SYNC_SCHEDULER_INTERVAL_MS,
      cadenceMs: env.NPI_SYNC_CADENCE_MS,
      cmsFetchBatchSize: env.NPI_SYNC_CMS_FETCH_BATCH_SIZE,
      maxProvidersPerOrg: env.NPI_SYNC_MAX_PROVIDERS_PER_ORG ?? null,
    },
    npiSyncReaper: {
      intervalMs: env.NPI_SYNC_REAPER_INTERVAL_MS,
      runtimeCeilingMs: env.NPI_SYNC_RUNTIME_CEILING_MS,
    },
    packagePhotoTokenReaper: {
      intervalMs: env.PACKAGE_PHOTO_TOKEN_REAPER_INTERVAL_MS,
      batchSize: env.PACKAGE_PHOTO_TOKEN_REAPER_BATCH_SIZE,
    },
    packagePhotoOrphanSweep: {
      enabled:
        typeof env.S3_PACKAGE_PHOTOS_BUCKET === "string" && env.S3_PACKAGE_PHOTOS_BUCKET.length > 0,
      intervalMs: env.PACKAGE_PHOTO_ORPHAN_SWEEP_INTERVAL_MS,
      safetyWindowMs: env.PACKAGE_PHOTO_ORPHAN_SWEEP_SAFETY_WINDOW_MS,
      maxKeysPerTick: env.PACKAGE_PHOTO_ORPHAN_SWEEP_MAX_KEYS_PER_TICK,
    },
    notifications: {
      channel: notificationChannel.metadata.name,
      phiCapable: notificationChannel.metadata.phiCapable,
    },
    reportArchive: {
      adapter: reportArchive instanceof S3ReportRunArchive ? "s3" : "in-memory",
      bucket:
        reportArchive instanceof S3ReportRunArchive ? env.REPORT_ARCHIVE_S3_BUCKET : "in-memory",
    },
    shippingProviders: ["EASYPOST", "FEDEX", "UPS"],
    merkleRootJob: {
      utcHour: env.DAILY_MERKLE_ROOT_HOUR_UTC,
      utcMinute: env.DAILY_MERKLE_ROOT_MINUTE_UTC,
      auditArchiveConfigured: typeof env.AUDIT_ARCHIVE_S3_BUCKET === "string",
      kmsSignerConfigured: typeof env.MERKLE_SIGNER_KMS_KEY_ID === "string",
    },
    quarterlyAccessReview: {
      enabled: env.QUARTERLY_ACCESS_REVIEW_ENABLED,
      utcHour: env.QUARTERLY_ACCESS_REVIEW_HOUR_UTC,
      utcMinute: env.QUARTERLY_ACCESS_REVIEW_MINUTE_UTC,
      lookbackDays: env.QUARTERLY_ACCESS_REVIEW_LOOKBACK_DAYS,
      evidenceRoot: env.QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT,
    },
    auditChainVerifier: {
      enabled: env.DAILY_AUDIT_CHAIN_VERIFIER_ENABLED,
      utcHour: env.DAILY_AUDIT_CHAIN_VERIFIER_HOUR_UTC,
      utcMinute: env.DAILY_AUDIT_CHAIN_VERIFIER_MINUTE_UTC,
    },
    nightlySecurityDigest: {
      enabled: env.NIGHTLY_SECURITY_DIGEST_ENABLED,
      utcHour: env.NIGHTLY_SECURITY_DIGEST_HOUR_UTC,
      utcMinute: env.NIGHTLY_SECURITY_DIGEST_MINUTE_UTC,
      windowHours: env.NIGHTLY_SECURITY_DIGEST_WINDOW_HOURS,
      publisher: securityDigestPublisher !== undefined ? "notification-channel" : "in-memory",
      recipientConfigured: digestRecipientConfigured,
    },
  });

  // Construct the dispatcher with whatever handlers are currently
  // registered. The handler map is intentionally empty in Phase 1; the
  // dispatcher gracefully no-ops unknown event types.
  const stripeEventStore = new databaseBilling.PrismaStripeWebhookEventStore(prisma);
  const stripeDispatcher = billing.createStripeWebhookEventDispatcher({
    handlers: createStripeEventHandlers({ client: prisma }),
  });

  const stripeDrainer = createStripeWebhookDrainer(
    {
      client: prisma,
      eventStore: stripeEventStore,
      dispatcher: stripeDispatcher,
      logger,
    },
    {
      batchSize: env.STRIPE_DRAIN_BATCH_SIZE,
      leaseMs: env.STRIPE_DRAIN_LEASE_MS,
    }
  );

  // Stripe SDK construction is lazy + optional: when
  // STRIPE_SECRET_KEY is unset, we hand the outbox handler a null
  // port so it logs-and-no-ops instead of producing per-event
  // retries against an unconfigured Stripe. The SAME SDK instance
  // powers both the invoice-push port (worker-side outbox handler)
  // and the refund port (configureBilling, used by the
  // RecordRefundReceived reconciliation path that may run inside
  // a chained system command).
  const stripeSdk =
    typeof env.STRIPE_SECRET_KEY === "string" && env.STRIPE_SECRET_KEY.length > 0
      ? new Stripe(env.STRIPE_SECRET_KEY, {
          typescript: true,
          appInfo: { name: "pharmacy-worker", version: "0.1.0" },
        })
      : null;
  const stripePort: StripeInvoicePort | null =
    stripeSdk !== null ? createStripeInvoiceAdapter({ stripe: stripeSdk }) : null;
  configureBilling({
    stripeRefundPort: stripeSdk !== null ? createStripeRefundAdapter({ stripe: stripeSdk }) : null,
  });

  const outboxDrainer = createOutboxDrainer(
    {
      client: prisma,
      logger,
      maxAttempts: env.OUTBOX_DRAIN_MAX_ATTEMPTS,
      handlers: createOutboxHandlers({
        client: prisma,
        prisma,
        stripePort,
        opsConsoleBaseUrl: env.OPS_CONSOLE_BASE_URL,
      }),
    },
    {
      batchSize: env.OUTBOX_DRAIN_BATCH_SIZE,
      leaseMs: env.OUTBOX_DRAIN_LEASE_MS,
    }
  );

  const easyPostEventStore = new PrismaEasyPostWebhookEventStore(prisma);
  const easyPostDrainer = createEasyPostWebhookDrainer(
    {
      client: prisma,
      eventStore: easyPostEventStore,
      targetResolver: createEasyPostTargetResolver({ client: prisma }),
      logger,
    },
    {
      batchSize: env.EASYPOST_DRAIN_BATCH_SIZE,
      leaseMs: env.EASYPOST_DRAIN_LEASE_MS,
    }
  );

  const fedexTrackingPoller = createFedExTrackingPoller(
    { client: prisma, logger },
    {
      batchSize: env.FEDEX_TRACKING_POLL_BATCH_SIZE,
      staleThresholdMs: env.FEDEX_TRACKING_POLL_STALE_THRESHOLD_MS,
    }
  );

  const upsTrackingPoller = createUpsTrackingPoller(
    { client: prisma, logger },
    {
      batchSize: env.UPS_TRACKING_POLL_BATCH_SIZE,
      staleThresholdMs: env.UPS_TRACKING_POLL_STALE_THRESHOLD_MS,
    }
  );

  const reportScheduler = createReportScheduler(
    { client: prisma, logger },
    { batchSize: env.REPORT_SCHEDULER_BATCH_SIZE }
  );

  const slaBreachEvaluator = createSlaBreachEvaluator(
    { client: prisma, logger },
    { batchSize: env.SLA_BREACH_EVAL_BATCH_SIZE }
  );

  // NPI Registry sync scheduler + reaper. Two loops:
  //   - scheduler: tick → claim orgs due for a sync → enter per-org
  //     tenancy → runNpiSyncForOrg.
  //   - reaper: tick → updateMany rows stuck in IN_PROGRESS past
  //     `NPI_SYNC_RUNTIME_CEILING_MS` to FAILED.
  // The CMS client is shared across orgs in this process so the
  // 8 req/s rate gate is process-wide (not per-org). User-Agent
  // is required by CMS courtesy.
  const npiSyncCmsClient = new CmsNppesClient({
    userAgent: `pharmacy-worker/0.1.0 (${env.NODE_ENV})`,
  });
  // PrismaClient satisfies the scheduler's narrow surface at
  // runtime — the JSON columns (`errorMetadata`, `cmsSnapshot`,
  // `localSnapshot`) accept any JSON-serializable value at runtime
  // but Prisma's static input typing is stricter than the worker's
  // narrow `Record<string, unknown>` contract. The `unknown` cast
  // is the standard adaptor pattern between a typed narrow
  // interface (worker-internal) and Prisma's generated wide types.
  // The worker's own unit tests run against the narrow surface
  // directly, so the contract is fully test-anchored.
  const npiSyncSchedulerPrisma = prisma as unknown as Parameters<
    typeof createNpiSyncScheduler
  >[0]["client"];
  const npiSyncScheduler = createNpiSyncScheduler(
    {
      client: npiSyncSchedulerPrisma,
      logger,
      clock: clock.systemClock,
      cmsClient: npiSyncCmsClient,
      ...(env.NPI_SYNC_ACTOR_EMAIL_LOCAL_PART !== undefined
        ? { actorEmailLocalPart: env.NPI_SYNC_ACTOR_EMAIL_LOCAL_PART }
        : {}),
    },
    {
      batchSize: env.NPI_SYNC_SCHEDULER_BATCH_SIZE,
      cadenceMs: env.NPI_SYNC_CADENCE_MS,
      // 0 → null = unlimited; positive → cap.
      maxProvidersPerOrg:
        env.NPI_SYNC_MAX_PROVIDERS_PER_ORG !== undefined && env.NPI_SYNC_MAX_PROVIDERS_PER_ORG > 0
          ? env.NPI_SYNC_MAX_PROVIDERS_PER_ORG
          : null,
      cmsFetchBatchSize: env.NPI_SYNC_CMS_FETCH_BATCH_SIZE,
    }
  );
  const npiSyncReaper = createStuckNpiSyncRunReaper(
    { client: prisma, logger, clock: clock.systemClock },
    { runtimeCeilingMs: env.NPI_SYNC_RUNTIME_CEILING_MS }
  );

  // Package-photo upload-token reaper. Sweeps expired
  // `package_photo_upload_token` rows (DB rows only — the durable
  // photo bytes referenced by `package_photo.storageKey` are never
  // touched). Runs cross-org in system context.
  const packagePhotoTokenReaper = createExpiredPackagePhotoUploadTokenReaper(
    { client: prisma, logger, clock: clock.systemClock },
    { batchSize: env.PACKAGE_PHOTO_TOKEN_REAPER_BATCH_SIZE }
  );

  // Package-photo orphan S3 object sweeper (janitor part 2). Only
  // runs when the dedicated S3 bucket is configured — in-memory dev
  // storage has no persistent orphans (a redeploy clears it). Lists
  // `org/*/photo/upload/*` and deletes objects with no backing
  // `package_photo` row older than the safety window.
  const packagePhotoObjectSweeper =
    typeof env.S3_PACKAGE_PHOTOS_BUCKET === "string" && env.S3_PACKAGE_PHOTOS_BUCKET.length > 0
      ? createOrphanPackagePhotoObjectSweeper(
          {
            store: await buildPackagePhotoObjectStore({
              bucket: env.S3_PACKAGE_PHOTOS_BUCKET,
              region: env.AWS_REGION,
            }),
            prisma,
            logger,
            clock: clock.systemClock,
          },
          {
            safetyWindowMs: env.PACKAGE_PHOTO_ORPHAN_SWEEP_SAFETY_WINDOW_MS,
            maxKeysPerTick: env.PACKAGE_PHOTO_ORPHAN_SWEEP_MAX_KEYS_PER_TICK,
          }
        )
      : null;
  if (env.NODE_ENV === "production" && packagePhotoObjectSweeper === null) {
    logger.warn("worker.booted_without_package_photo_orphan_sweep", {
      reason:
        "S3_PACKAGE_PHOTOS_BUCKET unset; orphaned package-photo S3 objects (abandoned uploads, failed token inserts) will not be reclaimed.",
    });
  }

  // Daily Merkle root signing loop (ADR-0024). Resolves the signer +
  // publisher from env via dynamic AWS SDK imports. In production
  // the env validation in env.ts + the hard-fail inside the
  // factories guarantees both KMS keys + the audit-archive bucket
  // are configured before the first run fires.
  const merkleRootLoop = await createNightlyMerkleRootLoopFromEnv({
    prisma,
    logger,
    utcHour: env.DAILY_MERKLE_ROOT_HOUR_UTC,
    utcMinute: env.DAILY_MERKLE_ROOT_MINUTE_UTC,
    env: {
      NODE_ENV: env.NODE_ENV,
      AWS_REGION: env.AWS_REGION,
      AUDIT_ARCHIVE_S3_BUCKET: env.AUDIT_ARCHIVE_S3_BUCKET,
      AUDIT_ARCHIVE_S3_KMS_KEY_ID: env.AUDIT_ARCHIVE_S3_KMS_KEY_ID,
      AUDIT_ARCHIVE_RETENTION_YEARS: env.AUDIT_ARCHIVE_RETENTION_YEARS,
      MERKLE_SIGNER_KMS_KEY_ID: env.MERKLE_SIGNER_KMS_KEY_ID,
    },
  });

  // Quarterly access-review loop (SOC 2 CC6.2 + HIPAA § 164.308(a)(4)).
  // Fires daily at 03:00 UTC, but the loop self-guards on
  // `isFirstDayOfQuarter`, so 363 days/year this is a no-op tick.
  // On Apr 1 / Jul 1 / Oct 1 / Jan 1 03:00 UTC it walks every org,
  // generates the access-review report, aggregates command_log +
  // audit_log activity, detects anomalies, and writes a JSONL +
  // markdown evidence pack plus a per-org notification.
  //
  // Design note: this loop produces the EVIDENCE PACK only. The
  // `RecordAccessReviewSnapshot` tenant command (which writes the
  // tamper-evident `access_review_snapshot` row) is intentionally
  // human-driven — the OrgAdmin reads the notification, walks the
  // report, and dispatches the command via the CLI under THEIR
  // identity. That preserves the SOC 2 model where each snapshot
  // row carries a verifiable human attestation.
  //
  // The default `FilesystemEvidencePublisher` writes under
  // `QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT`. Production deployments
  // SHOULD swap this for an S3 Object Lock publisher — tracked
  // under the Terraform / Lane 2 work; until that lands, the worker
  // emits the production warning below so operators see the gap.
  const evidencePublisher = new FilesystemEvidencePublisher({
    rootDir: env.QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT,
  });
  const quarterlyAccessReviewLoop = env.QUARTERLY_ACCESS_REVIEW_ENABLED
    ? createQuarterlyAccessReviewLoop({
        prisma,
        logger,
        utcHour: env.QUARTERLY_ACCESS_REVIEW_HOUR_UTC,
        utcMinute: env.QUARTERLY_ACCESS_REVIEW_MINUTE_UTC,
        evidencePublisher,
        lookbackDays: env.QUARTERLY_ACCESS_REVIEW_LOOKBACK_DAYS,
      })
    : null;
  if (env.NODE_ENV === "production" && quarterlyAccessReviewLoop !== null) {
    logger.warn("worker.quarterly_access_review.filesystem_publisher", {
      reason:
        "Quarterly access-review evidence pack is being written to the local filesystem. " +
        "Production SHOULD use an S3 Object Lock publisher; see " +
        "apps/worker/src/compliance/evidence-publisher.ts and the Terraform slice.",
      evidenceRoot: env.QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT,
    });
  }
  if (env.NODE_ENV === "production" && quarterlyAccessReviewLoop === null) {
    logger.warn("worker.quarterly_access_review.disabled", {
      reason:
        "QUARTERLY_ACCESS_REVIEW_ENABLED=false in production. No scheduled access-review evidence packs will be produced. " +
        "Disable only if a separate scheduler is producing the evidence pack.",
    });
  }

  // Daily audit-chain verifier loop (ADR-0006 + SOC 2 CC7.2). Fires
  // at 01:30 UTC, BEFORE the 02:00 UTC Merkle signing job, so a
  // tamper is caught and paged on BEFORE the day's manifest is
  // signed into the Object Lock bucket. Each per-org outcome is
  // logged + counted via `pharmax_audit_chain_verifier_runs_total`;
  // a per-row break increments `pharmax_audit_verifier_failures_total`
  // (declared inside @pharmax/audit) which is the SEV1 alert source.
  //
  // The same chain replay is exposed as a CLI
  // (`scripts/security/verify-audit-chain-all-orgs.ts`) for on-call
  // use; the worker loop is the always-on scheduled component
  // SOC 2 CC7.2 evidence pulls require.
  const auditChainVerifierLoop = env.DAILY_AUDIT_CHAIN_VERIFIER_ENABLED
    ? createDailyAuditChainVerifierLoop({
        prisma,
        logger,
        utcHour: env.DAILY_AUDIT_CHAIN_VERIFIER_HOUR_UTC,
        utcMinute: env.DAILY_AUDIT_CHAIN_VERIFIER_MINUTE_UTC,
      })
    : null;
  if (env.NODE_ENV === "production" && auditChainVerifierLoop === null) {
    logger.warn("worker.audit_chain_verifier.disabled", {
      reason:
        "DAILY_AUDIT_CHAIN_VERIFIER_ENABLED=false in production. No scheduled audit-chain verification will run. " +
        "Disable only if a separate scheduler is invoking the CLI verifier.",
    });
  }

  // Nightly security digest loop (SOC 2 CC4.2 + CC7.2). Fires at
  // 02:30 UTC, AFTER the Merkle signing job, so today's digest
  // reports yesterday's signed-manifest URI alongside the
  // audit-chain status, break-glass session, outbox, Sentry, and
  // access-review-calendar probes. The publisher selection happened
  // upstream — `securityDigestPublisher` is undefined when we fall
  // back to the in-memory + INFO-log path.
  const nightlySecurityDigestLoop = env.NIGHTLY_SECURITY_DIGEST_ENABLED
    ? createNightlySecurityDigestLoop({
        prisma,
        logger,
        utcHour: env.NIGHTLY_SECURITY_DIGEST_HOUR_UTC,
        utcMinute: env.NIGHTLY_SECURITY_DIGEST_MINUTE_UTC,
        windowHours: env.NIGHTLY_SECURITY_DIGEST_WINDOW_HOURS,
        ...(securityDigestPublisher !== undefined ? { publisher: securityDigestPublisher } : {}),
      })
    : null;
  if (
    env.NODE_ENV === "production" &&
    nightlySecurityDigestLoop !== null &&
    securityDigestPublisher === undefined
  ) {
    // Document exactly WHICH precondition is missing so the operator
    // can fix the right env var without guessing.
    const reason = !digestRecipientConfigured
      ? "NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL is unset; the digest will be logged at INFO only and operators will not receive a daily email."
      : "RESEND_API_KEY or NOTIFICATION_FROM_EMAIL is unset; the worker's notification channel is the in-memory fallback, so the digest will be logged at INFO only.";
    logger.warn("worker.nightly_security_digest.log_only_publisher", { reason });
  }
  if (env.NODE_ENV === "production" && nightlySecurityDigestLoop === null) {
    logger.warn("worker.nightly_security_digest.disabled", {
      reason:
        "NIGHTLY_SECURITY_DIGEST_ENABLED=false in production. No daily security digest will be produced. " +
        "Disable only if a separate scheduler is invoking the CLI digest.",
    });
  }

  // Wrap each drainer's `tick` so its tally result is discarded — the
  // poll-loop contract is `() => Promise<void>` and TypeScript is
  // strict about it. Drainer results are already surfaced via
  // structured logs from inside `tick()`.
  const stripeLoop = createPollLoop({
    name: "stripe-webhook-drain",
    intervalMs: env.STRIPE_DRAIN_INTERVAL_MS,
    tick: async () => {
      await stripeDrainer.tick();
    },
    logger,
  });

  const outboxLoop = createPollLoop({
    name: "event-outbox-drain",
    intervalMs: env.OUTBOX_DRAIN_INTERVAL_MS,
    tick: async () => {
      await outboxDrainer.tick();
    },
    logger,
  });

  const easyPostLoop = createPollLoop({
    name: "easypost-webhook-drain",
    intervalMs: env.EASYPOST_DRAIN_INTERVAL_MS,
    tick: async () => {
      await easyPostDrainer.tick();
    },
    logger,
  });

  const fedexTrackingLoop = createPollLoop({
    name: "fedex-tracking-poll",
    intervalMs: env.FEDEX_TRACKING_POLL_INTERVAL_MS,
    tick: async () => {
      await fedexTrackingPoller.tick();
    },
    logger,
  });

  const upsTrackingLoop = createPollLoop({
    name: "ups-tracking-poll",
    intervalMs: env.UPS_TRACKING_POLL_INTERVAL_MS,
    tick: async () => {
      await upsTrackingPoller.tick();
    },
    logger,
  });

  const reportSchedulerLoop = createPollLoop({
    name: "report-scheduler",
    intervalMs: env.REPORT_SCHEDULER_INTERVAL_MS,
    tick: async () => {
      await reportScheduler.tick();
    },
    logger,
  });

  const slaBreachEvaluatorLoop = createPollLoop({
    name: "sla-breach-evaluator",
    intervalMs: env.SLA_BREACH_EVAL_INTERVAL_MS,
    tick: async () => {
      await slaBreachEvaluator.tick();
    },
    logger,
  });

  const npiSyncSchedulerLoop = createPollLoop({
    name: "npi-sync-scheduler",
    intervalMs: env.NPI_SYNC_SCHEDULER_INTERVAL_MS,
    tick: async () => {
      await npiSyncScheduler.tick();
    },
    logger,
  });

  const npiSyncReaperLoop = createPollLoop({
    name: "npi-sync-reaper",
    intervalMs: env.NPI_SYNC_REAPER_INTERVAL_MS,
    tick: async () => {
      await npiSyncReaper.tick();
    },
    logger,
  });

  const packagePhotoTokenReaperLoop = createPollLoop({
    name: "package-photo-token-reaper",
    intervalMs: env.PACKAGE_PHOTO_TOKEN_REAPER_INTERVAL_MS,
    tick: async () => {
      await packagePhotoTokenReaper.tick();
    },
    logger,
  });

  const packagePhotoObjectSweeperLoop =
    packagePhotoObjectSweeper !== null
      ? createPollLoop({
          name: "package-photo-orphan-sweeper",
          intervalMs: env.PACKAGE_PHOTO_ORPHAN_SWEEP_INTERVAL_MS,
          tick: async () => {
            await packagePhotoObjectSweeper.tick();
          },
          logger,
        })
      : null;

  // Workflow + bucket-size scraper. Refreshes the
  // `pharmax_workflow_queue_depth`, `pharmax_workflow_emergency_bucket_size`,
  // and `pharmax_shipping_bucket_size` gauges from a single
  // poll-loop tick. Default cadence matches the Prometheus scrape
  // interval so dashboards see fresh values without piling on DB
  // queries.
  const workflowBucketScraper = createWorkflowBucketScraper({
    client: prisma,
    logger,
  });
  const workflowBucketScraperLoop = createPollLoop({
    name: "workflow-bucket-scraper",
    intervalMs: env.WORKFLOW_BUCKET_SCRAPER_INTERVAL_MS,
    tick: async () => {
      await workflowBucketScraper.tick();
    },
    logger,
  });

  stripeLoop.start();
  outboxLoop.start();
  easyPostLoop.start();
  fedexTrackingLoop.start();
  upsTrackingLoop.start();
  reportSchedulerLoop.start();
  slaBreachEvaluatorLoop.start();
  npiSyncSchedulerLoop.start();
  npiSyncReaperLoop.start();
  packagePhotoTokenReaperLoop.start();
  if (packagePhotoObjectSweeperLoop !== null) {
    packagePhotoObjectSweeperLoop.start();
  }
  workflowBucketScraperLoop.start();
  if (auditChainVerifierLoop !== null) {
    auditChainVerifierLoop.start();
  }
  merkleRootLoop.start();
  if (nightlySecurityDigestLoop !== null) {
    nightlySecurityDigestLoop.start();
  }
  if (quarterlyAccessReviewLoop !== null) {
    quarterlyAccessReviewLoop.start();
  }

  // Liveness marker for the ECS/Fargate container health check
  // (`test -f /tmp/pharmax-worker-alive` in
  // infra/terraform/modules/ecs/main.tf). Started AFTER the drains are
  // running so the task only reports healthy once it has actually
  // booted; the marker is removed during shutdown below.
  const livenessHeartbeat = createLivenessHeartbeat({ logger });
  await livenessHeartbeat.start();

  await waitForShutdown();

  logger.info("worker.shutdown.start");
  const shutdownTimer = setTimeout(() => {
    logger.error("worker.shutdown.timeout", { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref();

  // Remove the liveness marker first so a draining task fails its ECS
  // health check immediately instead of being treated as healthy while
  // it winds down.
  await livenessHeartbeat.stop();

  await Promise.all([
    stripeLoop.stop(),
    outboxLoop.stop(),
    easyPostLoop.stop(),
    fedexTrackingLoop.stop(),
    upsTrackingLoop.stop(),
    reportSchedulerLoop.stop(),
    slaBreachEvaluatorLoop.stop(),
    npiSyncSchedulerLoop.stop(),
    npiSyncReaperLoop.stop(),
    packagePhotoTokenReaperLoop.stop(),
    ...(packagePhotoObjectSweeperLoop !== null ? [packagePhotoObjectSweeperLoop.stop()] : []),
    workflowBucketScraperLoop.stop(),
    ...(auditChainVerifierLoop !== null ? [auditChainVerifierLoop.stop()] : []),
    merkleRootLoop.stop(),
    ...(nightlySecurityDigestLoop !== null ? [nightlySecurityDigestLoop.stop()] : []),
    ...(quarterlyAccessReviewLoop !== null ? [quarterlyAccessReviewLoop.stop()] : []),
  ]);
  await prisma.$disconnect();

  // Flush any in-flight Sentry events before exit. Cap at 2s so a
  // Sentry outage cannot extend our shutdown beyond the operator's
  // expectations.
  await flushSentry(2_000);

  // Flush OTel exporters in parallel with the Sentry flush window.
  // `shutdown()` already swallows its own errors and logs them; we
  // just need to await before exit so spans actually leave.
  if (workerTelemetryHandle !== null) {
    await workerTelemetryHandle.shutdown();
  }

  clearTimeout(shutdownTimer);
  logger.info("worker.shutdown.complete");
  process.exit(0);
}

/**
 * Adapter from the real `@aws-sdk/client-s3` `S3Client` to the
 * narrow `S3ReportRunArchiveSurface` port. Same pattern the audit
 * archive uses — dynamic import keeps the SDK out of the cold-
 * start path for environments that aren't using S3.
 */
async function buildS3ReportArchiveSurface(
  region: string | undefined
): Promise<S3ReportRunArchiveSurface> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  if (region === undefined || region.length === 0) {
    throw new Error(
      "REPORT_ARCHIVE_S3_BUCKET is set but AWS_REGION is missing. Set both to use the S3 archive."
    );
  }
  const client = new S3Client({ region });
  return {
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
      // `Body` is a `Readable` stream in Node — accumulate to a
      // `Uint8Array`. CSV bodies are bounded by report row counts
      // so the buffer is small enough not to need streaming back
      // to the caller.
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
  };
}

/**
 * Adapter from a real `@aws-sdk/client-s3` `S3Client` to the narrow
 * `PackagePhotoObjectStore` the orphan sweeper needs (LIST + batch
 * DELETE). Dynamic import keeps the SDK off the cold-start path for
 * worker deployments that don't run the sweep.
 */
async function buildPackagePhotoObjectStore(input: {
  readonly bucket: string;
  readonly region: string | undefined;
}): Promise<PackagePhotoObjectStore> {
  if (input.region === undefined || input.region.length === 0) {
    throw new Error(
      "S3_PACKAGE_PHOTOS_BUCKET is set but AWS_REGION is missing. Set both to run the orphan-object sweep."
    );
  }
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } =
    await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: input.region });
  return {
    async listObjects(listInput) {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: input.bucket,
          Prefix: listInput.prefix,
          MaxKeys: listInput.maxKeys,
          ...(listInput.continuationToken !== undefined
            ? { ContinuationToken: listInput.continuationToken }
            : {}),
        })
      );
      const objects = (response.Contents ?? [])
        .filter(
          (c): c is { Key: string; LastModified: Date } =>
            typeof c.Key === "string" && c.LastModified instanceof Date
        )
        .map((c) => ({ key: c.Key, lastModified: c.LastModified }));
      return {
        objects,
        // ListObjectsV2 only returns a continuation token when
        // truncated; absence means the listing is exhausted.
        nextContinuationToken:
          response.IsTruncated === true ? response.NextContinuationToken : undefined,
      };
    },
    async deleteObjects(deleteInput) {
      if (deleteInput.keys.length === 0) return { deletedCount: 0 };
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: input.bucket,
          Delete: {
            Objects: deleteInput.keys.map((Key) => ({ Key })),
            // Quiet mode: only errors are returned in `Errors`;
            // successful deletes are not echoed back.
            Quiet: true,
          },
        })
      );
      const errorCount = response.Errors?.length ?? 0;
      return { deletedCount: deleteInput.keys.length - errorCount };
    },
  };
}

/**
 * Build and validate the KMS adapter for the worker process. Mirror
 * of the web equivalent in `apps/web/src/server/bootstrap.ts`. Kept
 * separate so the two boot paths can diverge later (e.g. if the
 * worker ever needs a different KMS profile from the request tier)
 * without back-references between the apps.
 */
async function buildWorkerKmsAdapter(): Promise<{
  readonly kms: KmsAdapter;
  readonly adapterName: "AwsKmsAdapter" | "LocalKmsAdapter";
}> {
  const region = env.AWS_REGION;
  const dataKeyId = env.AWS_KMS_DATA_KEY_ID;
  const searchKeyId = env.AWS_KMS_SEARCH_KEY_ID;
  const label = env.AWS_KMS_KEY_LABEL ?? "app-phi";
  const previousDataKeyKeyIds = parsePreviousDataKeyKeyIds(env.AWS_KMS_PREVIOUS_DATA_KEY_IDS);

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
        "Refusing to boot apps/worker in production: AWS_REGION, AWS_KMS_DATA_KEY_ID, and AWS_KMS_SEARCH_KEY_ID must all be set. " +
          "Provision the KMS keys via infra/terraform/modules/kms and inject the ARNs through Secrets Manager."
      );
    }
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
      ...(previousDataKeyKeyIds.length > 0 ? { previousDataKeyKeyIds } : {}),
    });
    await kms.validate();
    if (previousDataKeyKeyIds.length > 0) {
      logger.info("worker.kms_previous_data_keys_configured", {
        currentDataKeyId: dataKeyId,
        previousDataKeyCount: previousDataKeyKeyIds.length,
      });
    }
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  if (allAwsPresent) {
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
      ...(previousDataKeyKeyIds.length > 0 ? { previousDataKeyKeyIds } : {}),
    });
    await kms.validate();
    logger.warn("worker.aws_kms_in_non_production", {
      reason: "AWS_KMS_* env present in non-prod environment",
    });
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  const seed = env.PHARMAX_LOCAL_KMS_SEED;
  if (typeof seed !== "string" || seed.length < 32) {
    throw new Error(
      "Refusing to boot apps/worker: neither AWS KMS config nor PHARMAX_LOCAL_KMS_SEED is present. " +
        "Set PHARMAX_LOCAL_KMS_SEED (>=32 chars) for local dev, or wire AWS_KMS_DATA_KEY_ID / AWS_KMS_SEARCH_KEY_ID."
    );
  }
  return {
    kms: new LocalKmsAdapter({ seed }),
    adapterName: "LocalKmsAdapter",
  };
}

/**
 * Parse the worker's `AWS_KMS_PREVIOUS_DATA_KEY_IDS` env var into a
 * clean string array. Mirrors `apps/web/src/server/bootstrap.ts`'s
 * helper — both processes MUST agree on the historical-key chain
 * during a manual CMK identity rotation, so the parsing rules must
 * be byte-identical here.
 *
 * Returns an empty array for the steady-state case (env unset or
 * empty after trimming) so callers can short-circuit.
 */
function parsePreviousDataKeyKeyIds(raw: string | undefined): ReadonlyArray<string> {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function waitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      logger.info("worker.signal_received", { signal });
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

main().catch((cause: unknown) => {
  // Boot-time failures: env validation, initial Prisma connection.
  // Use console.error directly because the structured logger may not
  // be safe to call (env validation throws BEFORE logger imports
  // resolve in some failure modes).
  console.error("worker.boot.fatal", cause);
  process.exit(1);
});
