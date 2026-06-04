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
  // Optional read-replica for heavy report scans (see
  // apps/web env + @pharmax/database/reporting-client.ts). Unset →
  // reports read the primary.
  REPORTING_DATABASE_URL: z.string().url().optional(),

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

  // ---- Scheduled report runner -----------------------------------
  // The tick claims up to `batchSize` due report_schedule rows per
  // interval (FOR UPDATE SKIP LOCKED). 30 s default keeps the
  // resolution of "cron fires at 09:00" within a tolerable window
  // while leaving room for the dispatcher's per-row work. Worker
  // replicas tick independently; the SKIP LOCKED claim ensures
  // disjoint subsets.
  REPORT_SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  REPORT_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // SLA breach evaluator — scans for orders past `slaDeadlineAt`
  // and routes them into EMERGENCY.
  SLA_BREACH_EVAL_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  SLA_BREACH_EVAL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // ---- NPI registry sync ------------------------------------------
  // Two loops:
  //   1. SCHEDULER — picks orgs whose last successful sync is older
  //      than `CADENCE_MS` (default 24h) and dispatches a per-org
  //      `runNpiSyncForOrg`. Tick interval defaults to 5 minutes;
  //      cadence is the binding throughput constraint (we don't
  //      want orgs syncing more than once a day), so the tick can
  //      be relatively coarse.
  //   2. REAPER — sweeps `provider_sync_run` rows stuck in
  //      IN_PROGRESS past `RUNTIME_CEILING_MS` to FAILED. Runs less
  //      frequently than the scheduler (default 10 min) because the
  //      reaper's job only matters when a previous sync crashed
  //      mid-flight.
  //
  // `MAX_PROVIDERS_PER_ORG` caps the per-run scan size; null/0 = unlimited.
  // Used during the initial deployment to ramp CMS pressure gradually.
  NPI_SYNC_SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  NPI_SYNC_SCHEDULER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  NPI_SYNC_CADENCE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60_000),
  NPI_SYNC_MAX_PROVIDERS_PER_ORG: z.coerce.number().int().nonnegative().optional(),
  NPI_SYNC_CMS_FETCH_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  NPI_SYNC_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  NPI_SYNC_RUNTIME_CEILING_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60_000), // 60 minutes
  // Optional override for the per-org service-user local-part. Production
  // deployments may want to pin a non-`.test` suffix; this knob lets ops
  // override without a code change. Defaults to `npi-sync`.
  NPI_SYNC_ACTOR_EMAIL_LOCAL_PART: z.string().min(1).optional(),

  // ---- Workflow + bucket size scraper ------------------------------
  // Cadence at which the worker refreshes the snapshot behind
  // `pharmax_workflow_queue_depth`, `pharmax_workflow_emergency_bucket_size`,
  // and `pharmax_shipping_bucket_size` gauges. Default 30s matches the
  // typical Prometheus scrape interval so dashboards see fresh values
  // without piling on extra DB load.
  WORKFLOW_BUCKET_SCRAPER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // ---- Package-photo upload-token reaper --------------------------
  // Sweeps expired `package_photo_upload_token` rows (the ephemeral
  // upload-resolution claim; the durable bytes + pointer live on the
  // `package_photo` row and are untouched). Cadence is generous —
  // the table grows at dock-capture rate and rows are tiny — and the
  // batch caps each tick so a first-run backlog doesn't issue one
  // huge DELETE.
  PACKAGE_PHOTO_TOKEN_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60_000), // 15 minutes
  PACKAGE_PHOTO_TOKEN_REAPER_BATCH_SIZE: z.coerce.number().int().positive().default(500),

  // ---- Package-photo orphan S3 object sweep -----------------------
  // The dedicated S3 bucket holding package-photo bytes. When set
  // (alongside AWS_REGION), the worker runs the orphan-object sweeper
  // — listing `org/*/photo/upload/*` objects and deleting those with
  // no backing `package_photo` row that are older than the safety
  // window. Unset → the sweeper is not started (dev/in-memory storage
  // has no persistent orphans; a redeploy clears it). MUST match the
  // web tier's `S3_PACKAGE_PHOTOS_BUCKET`.
  S3_PACKAGE_PHOTOS_BUCKET: z.string().min(1).optional(),
  // Minimum object age before it can be swept as an orphan. MUST be
  // >> the upload-token TTL (1h) so the upload→dispatch gap and the
  // PUT-then-INSERT race can never be false positives. Default 24h.
  PACKAGE_PHOTO_ORPHAN_SWEEP_SAFETY_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60_000), // 24 hours
  PACKAGE_PHOTO_ORPHAN_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60_000), // 1 hour
  PACKAGE_PHOTO_ORPHAN_SWEEP_MAX_KEYS_PER_TICK: z.coerce.number().int().positive().default(1_000),

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
  // processes MUST point at the SAME pair of KMS keys (including
  // the SAME historical-key chain during a manual CMK identity
  // rotation); a wrap by one and a decrypt by the other would
  // otherwise fail. Optional at the schema level so dev/test
  // clones don't require AWS credentials; bootstrap enforces
  // presence under NODE_ENV=production.
  AWS_REGION: z.string().min(1).optional(),
  AWS_KMS_DATA_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_SEARCH_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_KEY_LABEL: z.string().min(1).optional(),
  // Comma-separated list of historical CMK ARNs/aliases used during
  // a manual CMK identity rotation bake-in window. See
  // `AwsKmsAdapterOptions.previousDataKeyKeyIds` and the RUNBOOK
  // § "Rotating a KMS data key — Manual CMK rotation". MUST match
  // the apps/web value exactly during a rotation; otherwise an
  // envelope wrapped by one process becomes unrecoverable when read
  // by the other.
  AWS_KMS_PREVIOUS_DATA_KEY_IDS: z.string().min(1).optional(),

  // ---- Report CSV archive (scheduled-run persistence) ------------
  // When both are set, the worker wires `S3ReportRunArchive` and
  // every scheduled `RunReport` persists its CSV under
  // `s3://${REPORT_ARCHIVE_S3_BUCKET}/reports/{orgId}/{yyyy}/{mm}/{dd}/{runId}.csv`
  // wrapped under SSE-KMS with `REPORT_ARCHIVE_S3_KMS_KEY_ID`.
  // When EITHER is unset the worker falls back to an in-memory
  // archive (dev / test); the `RunReport` handler soft-skips
  // persistence when no archive is wired.
  //
  // Production: BOTH MUST be set + the bucket policy SHOULD deny
  // any PUT missing the SSE-KMS header (defense in depth).
  REPORT_ARCHIVE_S3_BUCKET: z.string().min(1).optional(),
  REPORT_ARCHIVE_S3_KMS_KEY_ID: z.string().min(1).optional(),

  // ---- Notifications (scheduled report fan-out + future paths) ---
  // When `RESEND_API_KEY` is set, the worker wires a
  // `ResendNotificationChannel` at boot; otherwise it falls back
  // to `InMemoryNotificationChannel` (dev / test) and the
  // scheduled-report outbox handler skips with a structured log
  // line. Production MUST set both.
  RESEND_API_KEY: z.string().min(1).optional(),
  NOTIFICATION_FROM_EMAIL: z.email().optional(),
  // When all three TWILIO_* values are set, the worker can wire a
  // `TwilioSmsNotificationChannel` for SMS-capable templates (today:
  // the emergency-bucket on-call page). Otherwise SMS-targeted sends
  // fall through to the in-memory/in-app path. SMS is NOT a
  // PHI-eligible transport in our posture (see the channel header) —
  // these knobs intentionally carry no patient context.
  // `TWILIO_AUTH_SID` is optional: set it to a scoped API-key SID
  // (`SK…`) to Basic-auth with an API key instead of the account
  // auth token (production SHOULD prefer this).
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_AUTH_SID: z.string().startsWith("SK").optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().startsWith("MG").optional(),
  // Base URL of the operator console — used to compose deep-link
  // buttons in scheduled-report email bodies. Defaults to
  // localhost for dev.
  OPS_CONSOLE_BASE_URL: z.string().url().default("http://localhost:3000"),

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

  // ---- Quarterly access-review scheduler (SOC 2 CC6.2) ------------
  // Produces the per-org access-review evidence pack (JSONL +
  // markdown) on Apr 1 / Jul 1 / Oct 1 / Jan 1 and emits a
  // notification asking the OrgAdmin to walk the report. The
  // notification is the human's cue to dispatch
  // `RecordAccessReviewSnapshot` under THEIR identity — the
  // attestation row remains human-signed.
  //
  // Fires daily; the loop self-guards on
  // `isFirstDayOfQuarter(now)`, so 363 days/year this is a no-op
  // tick. 03:00 UTC is intentionally LATER than the 02:00 UTC
  // Merkle job and the 02:30 UTC security digest so this morning's
  // evidence pack sees a finalized chain + digest.
  //
  // When `QUARTERLY_ACCESS_REVIEW_ENABLED=false`, the loop is not
  // started — useful for dev environments running on a clone with
  // no orgs, or for staging tests that want to control evidence
  // emission manually.
  //
  // `LOOKBACK_DAYS` is the activity-aggregation window length;
  // default 92 days covers one full quarter with a small spillover
  // so a job that runs late on Apr 2 still has a full Q1 window.
  //
  // `EVIDENCE_ROOT` controls where the FilesystemEvidencePublisher
  // writes — must be a path the worker process can write to, and
  // in production should be on a volume backed by a daily snapshot
  // (until the S3 Object-Lock publisher lands as part of the
  // Terraform slice).
  QUARTERLY_ACCESS_REVIEW_ENABLED: z.coerce.boolean().default(true),
  QUARTERLY_ACCESS_REVIEW_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
  QUARTERLY_ACCESS_REVIEW_MINUTE_UTC: z.coerce.number().int().min(0).max(59).default(0),
  QUARTERLY_ACCESS_REVIEW_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(366).default(92),
  QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: z.string().min(1).default("./evidence"),

  // ---- Nightly security digest (SOC 2 CC4.2 / CC7.2) --------------
  // Composes the per-day security digest (audit-chain status per org,
  // break-glass sessions, dead outbox rows, failed-login signal,
  // Sentry error volume, access-review calendar) and "publishes" it.
  // Today the default publisher logs the rendered body at INFO; a
  // future PR will swap in a NotificationChannelDigestPublisher that
  // emails the body via the existing Resend channel. The loop itself
  // is the SOC 2 evidence artifact — the structured `digest.published`
  // log line proves it ran.
  //
  // Schedule: 02:30 UTC, intentionally AFTER the 02:00 UTC Merkle
  // signing job so the digest sees the finalized chain + freshly-
  // signed manifest pointer.
  //
  // When `NIGHTLY_SECURITY_DIGEST_ENABLED=false`, the loop is not
  // started — useful for dev environments running on a clone with
  // no orgs, or for staging that wants to drive the script manually
  // via `pnpm tsx scripts/security/send-nightly-security-digest.ts`.
  NIGHTLY_SECURITY_DIGEST_ENABLED: z.coerce.boolean().default(true),
  NIGHTLY_SECURITY_DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2),
  NIGHTLY_SECURITY_DIGEST_MINUTE_UTC: z.coerce.number().int().min(0).max(59).default(30),
  NIGHTLY_SECURITY_DIGEST_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  // Recipient email for the nightly security digest delivery. When
  // set AND the worker's Resend channel is wired (RESEND_API_KEY +
  // NOTIFICATION_FROM_EMAIL both present), the loop swaps the
  // default in-memory publisher for a NotificationChannelDigestPublisher
  // that emails the digest body to this address via the same
  // Resend transport scheduled-report emails ride. When unset, or
  // when Resend isn't wired, the loop falls back to the in-memory
  // publisher + INFO log (the structured `digest.published` log
  // line remains the SOC 2 evidence either way).
  //
  // Use a group alias (`security@<operator-domain>`) at the email
  // vendor / Workspace / Google Groups layer to fan out to multiple
  // on-call recipients. Do NOT comma-separate addresses here — the
  // notification channel sends one recipient per call by design,
  // and Resend's per-send `Idempotency-Key` would double-bill if we
  // looped client-side.
  NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL: z.string().email().optional(),

  // ---- Daily audit-chain verifier (ADR-0006 + SOC 2 CC7.2) --------
  // Per-org chain replay (`verifyChain` from @pharmax/audit) that
  // re-derives each row's entryHash via the canonical encoder and
  // asserts (a) seq monotonicity, (b) prevHash linkage, (c) recomputed
  // entryHash byte-matches the stored one. A break throws
  // AUDIT_CHAIN_BROKEN with the offending seq and increments the
  // `pharmax_audit_verifier_failures_total` counter — paired with the
  // AuditChainVerifierFailing Prometheus alert.
  //
  // Schedule: 01:30 UTC, intentionally BEFORE the 02:00 UTC Merkle
  // signing job so a tamper is caught BEFORE the manifest is signed
  // and published into the Object Lock bucket. If the verifier finds
  // a break, the operator has the morning to investigate while the
  // signed manifest for that day reflects yesterday's tip — not a
  // signed tamper.
  //
  // The same logic is available as a CLI (`scripts/security/
  // verify-audit-chain-all-orgs.ts`) for on-call use; the worker
  // loop is the always-on scheduled component the SOC 2 CC7.2
  // evidence pull requires.
  DAILY_AUDIT_CHAIN_VERIFIER_ENABLED: z.coerce.boolean().default(true),
  DAILY_AUDIT_CHAIN_VERIFIER_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(1),
  DAILY_AUDIT_CHAIN_VERIFIER_MINUTE_UTC: z.coerce.number().int().min(0).max(59).default(30),
});

export const env = envNs.defineEnv(schema, {
  contextLabel: "apps/worker environment",
});
export type Env = typeof env;
