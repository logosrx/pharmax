# Worker security loops

This folder contains the worker-side scaffolding for the Tier 3
security primitives delivered in `@pharmax/security`:

- **`daily-merkle-root-loop.ts`** — fires daily at
  `DAILY_MERKLE_ROOT_HOUR_UTC:DAILY_MERKLE_ROOT_MINUTE_UTC` (default
  02:00 UTC). For each organization, computes yesterday's audit-log
  Merkle root, signs it with the configured signer
  (`KmsAsymmetricSigner` when `MERKLE_SIGNER_KMS_KEY_ID` is set;
  otherwise an Ed25519 signer seeded from
  `PHARMAX_AUDIT_SIGNING_SEED` or an ephemeral keypair), and
  publishes the manifest via `S3ObjectLockPublisher` (when
  `AUDIT_ARCHIVE_S3_BUCKET` is set) or `InMemoryManifestPublisher`
  (dev). The loop emits a structured `merkle.run.complete` log line
  with per-error-code counters so the nightly digest can report
  "yesterday N orgs were skipped because of X." Per-org failures
  are isolated — one bad org never stops the day's run.

- **`nightly-security-digest-loop.ts`** — fires daily at 02:30 UTC
  (intentionally after the Merkle job). Composes the
  `SecurityDigest` via the probes in `./digest-probes.ts`, renders it
  via `renderDigestAsText`, and hands the pair to the configured
  `DigestPublisher`. Boot wires either `NotificationChannelDigestPublisher`
  (email via Resend → SECURITY_DIGEST_DAILY_V1 template) when
  `NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL` is set and the Resend
  channel is wired, or the in-memory publisher + an INFO log line
  otherwise.

- **`notification-channel-digest-publisher.ts`** — production
  `DigestPublisher` adapter that delegates to the worker's existing
  `NotificationChannel` (the same Resend-backed channel that powers
  scheduled-report emails). Composes the typed context payload from
  the digest aggregates, pins the recipient as the configured
  security distribution alias, and builds the per-digest idempotency
  key off `digest.generatedAt` so worker restarts inside the
  scheduler's debounce window cannot double-send.

- **`audit-chain-verifier-loop.ts`** — fires daily at 01:30 UTC,
  BEFORE the Merkle signing job, replaying each org's audit chain.
  A break increments `pharmax_audit_verifier_failures_total` and
  pages on-call via the standard alert path.

- **`daily-utc-scheduler.ts`** — minimal once-per-day-at-UTC-HH:MM
  scheduler (~80 lines). Used by all three loops above. We did NOT
  reuse `createPollLoop` because that fires at a fixed _interval_,
  not at a specific clock time.

- **`digest-probes.ts`** — worker-process adapter that bridges the
  digest probes to Prisma / withSystemContext.

## Wiring in `apps/worker/src/main.ts`

All three loops (Merkle signing, audit-chain verifier, nightly
security digest) are wired during boot. The Merkle loop uses
`createNightlyMerkleRootLoopFromEnv` to resolve its signer and
publisher from env (dynamically importing `@aws-sdk/client-kms`
and `@aws-sdk/client-s3` only when the production env vars are
set). The digest loop's publisher is selected at boot from the
combination of `NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL` +
`RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL`; the resolved choice
is surfaced under `nightlySecurityDigest.publisher` in the
`worker.boot` log line so an operator can confirm which path is
active without inspecting downstream logs.

## Env vars consumed by the Merkle loop

| Var                             | Required in prod | Notes                                                                 |
| ------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `MERKLE_SIGNER_KMS_KEY_ID`      | yes              | KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY)                       |
| `AUDIT_ARCHIVE_S3_BUCKET`       | yes              | Object Lock COMPLIANCE bucket                                         |
| `AUDIT_ARCHIVE_S3_KMS_KEY_ID`   | yes              | Customer KMS key for SSE-KMS on manifests                             |
| `AUDIT_ARCHIVE_RETENTION_YEARS` | no (default 7)   | Lock retention; matches HIPAA § 164.316(b)(2) + SOC 2 retention floor |
| `DAILY_MERKLE_ROOT_HOUR_UTC`    | no (default 2)   | UTC hour the scheduler fires                                          |
| `DAILY_MERKLE_ROOT_MINUTE_UTC`  | no (default 0)   | UTC minute the scheduler fires                                        |
| `PHARMAX_AUDIT_SIGNING_SEED`    | dev only         | Hex 32-byte seed for deterministic Ed25519 (no KMS dep)               |

`buildMerkleSigner` and `buildMerklePublisher` hard-fail when
production env is missing — boot stops before the first run.

## Env vars consumed by the digest loop

| Var                                       | Required in prod  | Notes                                                                                                         |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `NIGHTLY_SECURITY_DIGEST_ENABLED`         | no (default true) | When false, the loop is not started.                                                                          |
| `NIGHTLY_SECURITY_DIGEST_HOUR_UTC`        | no (default 2)    | UTC hour the digest fires.                                                                                    |
| `NIGHTLY_SECURITY_DIGEST_MINUTE_UTC`      | no (default 30)   | UTC minute the digest fires.                                                                                  |
| `NIGHTLY_SECURITY_DIGEST_WINDOW_HOURS`    | no (default 24)   | Look-back window for probes.                                                                                  |
| `NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL` | recommended       | When set + Resend channel wired → email delivery. When unset → INFO-log-only fallback + production-time warn. |

Use a group alias (e.g. `security@<operator-domain>`) for the
recipient. The notification channel is one-recipient-per-send by
design; multi-recipient fan-out belongs at the email-vendor /
Workspace / Google Groups layer so that Resend's per-send
`Idempotency-Key` correctly dedupes worker retries.

## Open items (not in this lane's scope)

- `break_glass_session` Prisma model + migration per
  `packages/security/src/break-glass/SCHEMA.md`. Until then, the
  break-glass probe in `digest-probes.ts` returns an empty list.
- Slack / Teams `DigestPublisher` adapters — sibling to
  `NotificationChannelDigestPublisher` for high-urgency operators
  who prefer paging.
