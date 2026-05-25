// Worker process environment.
//
// Schema lives here; parse + freeze + fail-fast machinery lives in
// `@pharmax/platform-core/env`. Validation runs once on first import.
// All polling tunables are configurable so prod can dial them
// independently of dev. Defaults are conservative for local dev.

import { env as envNs } from "@pharmax/platform-core";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  // ---- Stripe webhook drain ---------------------------------------
  STRIPE_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  STRIPE_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  STRIPE_DRAIN_LEASE_MS: z.coerce.number().int().positive().default(60_000),

  // ---- Event outbox drain -----------------------------------------
  OUTBOX_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  OUTBOX_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  OUTBOX_DRAIN_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  OUTBOX_DRAIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  // ---- EasyPost webhook drain -------------------------------------
  EASYPOST_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  EASYPOST_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  EASYPOST_DRAIN_LEASE_MS: z.coerce.number().int().positive().default(60_000),

  // ---- FedEx tracking poller --------------------------------------
  // FedEx (unlike EasyPost) has no native push webhook, so the worker
  // polls active shipments on a schedule. Up to `batchSize` rows per
  // tick, re-poll only after `staleThresholdMs` since the last
  // applied tracking event (EONPRO defaults to 2 hours).
  FEDEX_TRACKING_POLL_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  FEDEX_TRACKING_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  FEDEX_TRACKING_POLL_STALE_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60_000),

  // ---- UPS tracking poller ----------------------------------------
  // Same polling pattern as FedEx. UPS Track API v1 is one tracking
  // number per call, so keep `batchSize` modest to avoid spiking
  // per-org QPS during a single tick.
  UPS_TRACKING_POLL_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  UPS_TRACKING_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  UPS_TRACKING_POLL_STALE_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60_000),

  // ---- Lifecycle ---------------------------------------------------
  // Maximum time the process waits for in-flight work after SIGTERM
  // before force-exiting. Should be larger than the longest expected
  // single-row processing time.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // ---- Crypto (PHI envelope encryption) ----------------------------
  // Master seed for the dev/test LocalKmsAdapter. MUST be:
  //   - Present in dev/test.
  //   - The SAME value across processes that share the database
  //     (apps/web + apps/worker), or rows encrypted by one process
  //     are undecryptable by the other.
  //   - REPLACED by `AWS_KMS_KEY_ARN` + an `AwsKmsAdapter` in
  //     production — `LocalKmsAdapter` is a dev convenience and
  //     MUST NOT run against production data.
  // Length-validated to reject obviously-too-short values that
  // would indicate a misconfigured environment.
  PHARMAX_LOCAL_KMS_SEED: z.string().min(32),

  // ---- Error tracking (Sentry) ------------------------------------
  // When SENTRY_DSN is unset the SDK no-ops and `Logger.error` only
  // hits stdout. In production these MUST be set.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export const env = envNs.defineEnv(schema, {
  contextLabel: "apps/worker environment",
});
export type Env = typeof env;
