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
import { billing, clock } from "@pharmax/platform-core";
import { billing as databaseBilling, prisma } from "@pharmax/database";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
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
import { createEasyPostWebhookDrainer } from "./drains/easypost-webhook-event-drainer.js";
import { createOutboxDrainer } from "./drains/event-outbox-drainer.js";
import { createFedExTrackingPoller } from "./drains/fedex-tracking-poller.js";
import { createOutboxHandlers } from "./drains/outbox-handlers.js";
import { createEasyPostTargetResolver } from "./drains/shipping-lookups.js";
import { createUpsTrackingPoller } from "./drains/ups-tracking-poller.js";
import { createStripeWebhookDrainer } from "./drains/stripe-webhook-event-drainer.js";
import { createStripeEventHandlers } from "./drains/stripe-handlers.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { flushSentry, initSentry } from "./observability/sentry-init.js";
import { createPollLoop } from "./runtime/poll-loop.js";
import { createNightlyMerkleRootLoopFromEnv } from "./security/daily-merkle-root-loop.js";

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
    shippingProviders: ["EASYPOST", "FEDEX", "UPS"],
    merkleRootJob: {
      utcHour: env.DAILY_MERKLE_ROOT_HOUR_UTC,
      utcMinute: env.DAILY_MERKLE_ROOT_MINUTE_UTC,
      auditArchiveConfigured: typeof env.AUDIT_ARCHIVE_S3_BUCKET === "string",
      kmsSignerConfigured: typeof env.MERKLE_SIGNER_KMS_KEY_ID === "string",
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
      handlers: createOutboxHandlers({ client: prisma, prisma, stripePort }),
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

  stripeLoop.start();
  outboxLoop.start();
  easyPostLoop.start();
  fedexTrackingLoop.start();
  upsTrackingLoop.start();
  merkleRootLoop.start();

  await waitForShutdown();

  logger.info("worker.shutdown.start");
  const shutdownTimer = setTimeout(() => {
    logger.error("worker.shutdown.timeout", { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref();

  await Promise.all([
    stripeLoop.stop(),
    outboxLoop.stop(),
    easyPostLoop.stop(),
    fedexTrackingLoop.stop(),
    upsTrackingLoop.stop(),
    merkleRootLoop.stop(),
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
    });
    await kms.validate();
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  if (allAwsPresent) {
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
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
