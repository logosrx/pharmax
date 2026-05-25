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

import { configureCommandBus } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { billing, clock } from "@pharmax/platform-core";
import { billing as databaseBilling, prisma } from "@pharmax/database";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import { PrismaEasyPostWebhookEventStore } from "@pharmax/shipping";

import { createEasyPostWebhookDrainer } from "./drains/easypost-webhook-event-drainer.js";
import { createOutboxDrainer } from "./drains/event-outbox-drainer.js";
import { createFedExTrackingPoller } from "./drains/fedex-tracking-poller.js";
import { createOutboxHandlers } from "./drains/outbox-handlers.js";
import { createEasyPostTargetResolver } from "./drains/shipping-lookups.js";
import { createUpsTrackingPoller } from "./drains/ups-tracking-poller.js";
import { createStripeWebhookDrainer } from "./drains/stripe-webhook-event-drainer.js";
import { stripeEventHandlers } from "./drains/stripe-handlers.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { flushSentry, initSentry } from "./observability/sentry-init.js";
import { createPollLoop } from "./runtime/poll-loop.js";

async function main(): Promise<void> {
  // 1. Sentry FIRST — uncaughtException / unhandledRejection hooks
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
  // Production refuses LocalKmsAdapter — same guard as apps/web.
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to boot apps/worker in production with LocalKmsAdapter. Implement and wire AwsKmsAdapter before promoting."
    );
  }
  configureCrypto({
    kms: new LocalKmsAdapter({ seed: env.PHARMAX_LOCAL_KMS_SEED }),
  });

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

  logger.info("worker.boot", {
    nodeEnv: env.NODE_ENV,
    pid: process.pid,
    cryptoAdapter: "LocalKmsAdapter",
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
  });

  // Construct the dispatcher with whatever handlers are currently
  // registered. The handler map is intentionally empty in Phase 1; the
  // dispatcher gracefully no-ops unknown event types.
  const stripeEventStore = new databaseBilling.PrismaStripeWebhookEventStore(prisma);
  const stripeDispatcher = billing.createStripeWebhookEventDispatcher({
    handlers: stripeEventHandlers,
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

  const outboxDrainer = createOutboxDrainer(
    {
      client: prisma,
      logger,
      maxAttempts: env.OUTBOX_DRAIN_MAX_ATTEMPTS,
      handlers: createOutboxHandlers({ client: prisma }),
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
  ]);
  await prisma.$disconnect();

  // Flush any in-flight Sentry events before exit. Cap at 2s so a
  // Sentry outage cannot extend our shutdown beyond the operator's
  // expectations.
  await flushSentry(2_000);

  clearTimeout(shutdownTimer);
  logger.info("worker.shutdown.complete");
  process.exit(0);
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
