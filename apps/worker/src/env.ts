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

  // ---- Stripe outbound (finalized invoice push) -------------------
  // OPTIONAL. When unset, the outbox handler for
  // `billing.invoice.finalized.v1` no-ops (logs that Stripe is not
  // configured) and the invoice stays in OPEN status without a
  // `stripeInvoiceId`. Wire this for environments that should
  // mirror invoices to Stripe.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),

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
  //   - Optional in production — the AwsKmsAdapter takes over and
  //     this value is ignored.
  // Length-validated to reject obviously-too-short values that
  // would indicate a misconfigured environment.
  PHARMAX_LOCAL_KMS_SEED: z.string().min(32).optional(),

  // ---- AWS KMS (production envelope encryption) -------------------
  // See apps/web/src/server/env.ts for the full rationale. Both
  // processes MUST point at the SAME pair of KMS keys; a wrap by
  // one and a decrypt by the other would otherwise fail. Optional
  // at the schema level so dev/test clones don't require AWS
  // credentials; bootstrap enforces presence under NODE_ENV=production.
  AWS_REGION: z.string().min(1).optional(),
  AWS_KMS_DATA_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_SEARCH_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_KEY_LABEL: z.string().min(1).optional(),

  // ---- Error tracking (Sentry) ------------------------------------
  // When SENTRY_DSN is unset the SDK no-ops and `Logger.error` only
  // hits stdout. In production these MUST be set.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // ---- Audit-archive Object Lock bucket (ADR-0024) ----------------
  // S3 bucket configured with Object Lock COMPLIANCE retention. The
  // worker writes one signed Merkle manifest per org per UTC day
  // under this bucket; the bucket's lock prevents any later edit or
  // delete inside the retention window. Required in production —
  // see bootstrap hard-fail in main.ts.
  AUDIT_ARCHIVE_S3_BUCKET: z.string().min(1).optional(),
  // KMS CMK ARN (or alias) used for SSE-KMS on the manifest object.
  // MUST be a customer-managed key so CloudTrail attributes every
  // read of an audit manifest back to a discrete principal.
  AUDIT_ARCHIVE_S3_KMS_KEY_ID: z.string().min(1).optional(),
  // Object Lock retention duration in years. COMPLIANCE-mode lock is
  // a one-way ratchet — values shorter than the regulator's
  // retention floor (HIPAA § 164.316(b)(2): 6 years) would silently
  // shrink the evidence horizon. Default 7y matches the SOC 2
  // retention policy.
  AUDIT_ARCHIVE_RETENTION_YEARS: z.coerce.number().int().min(1).max(100).default(7),

  // ---- Merkle root signing key (ADR-0024) -------------------------
  // KMS asymmetric key (KeySpec=ECC_NIST_P256, KeyUsage=SIGN_VERIFY)
  // used by `KmsAsymmetricSigner` to sign the daily Merkle root.
  // The worker's IAM role MUST hold `kms:Sign` + `kms:GetPublicKey`
  // on this ARN only. Required in production.
  MERKLE_SIGNER_KMS_KEY_ID: z.string().min(1).optional(),

  // ---- Daily Merkle scheduler -------------------------------------
  // UTC hour the daily-merkle-root job fires. 02:00 UTC sits after
  // the last possible audit_log row for yesterday's window and
  // before the morning's traffic warms up; override only for
  // staging where you want a faster reproduction cycle.
  DAILY_MERKLE_ROOT_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2),
  DAILY_MERKLE_ROOT_MINUTE_UTC: z.coerce.number().int().min(0).max(59).default(0),
});

export const env = envNs.defineEnv(schema, {
  contextLabel: "apps/worker environment",
});
export type Env = typeof env;
