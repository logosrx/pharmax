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
  `SecurityDigest` via the probes in `./digest-probes.ts` and renders
  it. The default publisher is the in-memory one + an INFO log line;
  swap in a Resend/SES `DigestPublisher` when that lands.

- **`daily-utc-scheduler.ts`** — minimal once-per-day-at-UTC-HH:MM
  scheduler (~80 lines). Used by both loops above. We did NOT reuse
  `createPollLoop` because that fires at a fixed _interval_, not at
  a specific clock time.

- **`digest-probes.ts`** — worker-process adapter that bridges the
  digest probes to Prisma / withSystemContext.

## Wiring in `apps/worker/src/main.ts`

The Merkle loop is wired during boot via
`createNightlyMerkleRootLoopFromEnv` — that variant resolves the
signer and publisher from env (dynamically importing
`@aws-sdk/client-kms` and `@aws-sdk/client-s3` only when the
production env vars are set), then returns the standard loop
handle. The digest loop is NOT yet wired into main.ts — see the
"Open items" list below.

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

## Open items (not in this lane's scope)

- `nightly-security-digest-loop.ts` wiring into `main.ts`.
- Real `DigestPublisher` (Resend / SES) — replace `InMemoryDigestPublisher`.
- `break_glass_session` Prisma model + migration per
  `packages/security/src/break-glass/SCHEMA.md`. Until then, the
  break-glass probe in `digest-probes.ts` returns an empty list.
