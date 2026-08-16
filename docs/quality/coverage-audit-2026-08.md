# Coverage-Gap Audit — August 2026

**Run:** `pnpm test:coverage` (the same invocation CI's "Unit tests + coverage" job
runs), 457 test files / 5,434 tests, all green.
**Overall:** 82.7% statements/lines, 86.9% branches, 84.9% functions
(v8 provider; lines ≡ statements).
**Scope:** unit suite only. `packages/integration-tests` runs under its own
DB-bound config and is excluded from this analysis (its 0% here is expected).
Bootstrap files (`main.ts`, `bootstrap.ts`), generated code, `index.ts`
barrels, and type-only modules are excluded by the coverage config; env/Sentry
init files are treated as config and excluded from the rankings below.

## Method

Per-file line/branch data parsed from `coverage/lcov.info`. "Weakest files
that matter" ranks by **missed lines** (not raw percentage) so a 200-line
untested adapter outranks a 10-line helper, filtered to files ≥ 30 lines with
< 80% line coverage, then hand-filtered to exclude test infra and config.

## Per-package coverage (rank-ordered, weakest first)

| Package                                     | Files | Lines | Branches | Missed lines |
| ------------------------------------------- | ----: | ----: | -------: | -----------: |
| apps/web                                    |    93 | 43.6% |    94.0% |        3,542 |
| apps/print-agent                            |     9 | 47.6% |    86.8% |          389 |
| packages/telemetry                          |     4 | 52.5% |    84.3% |          104 |
| packages/drug-knowledge                     |     7 | 55.8% |    80.9% |          277 |
| apps/worker                                 |    73 | 68.5% |    78.6% |        2,512 |
| packages/compliance                         |    16 | 70.8% |    83.6% |          346 |
| packages/scan                               |     3 | 73.0% |    69.9% |          102 |
| packages/database                           |     6 | 76.7% |    77.8% |           59 |
| packages/composition                        |    11 | 78.4% |    87.8% |           79 |
| packages/workflow                           |    10 | 79.8% |    91.5% |          208 |
| packages/auth                               |    38 | 83.7% |    91.6% |          395 |
| packages/shipping                           |    42 | 86.1% |    78.2% |          626 |
| packages/security                           |    14 | 86.2% |    84.6% |          223 |
| packages/patients                           |    13 | 87.0% |    92.3% |          212 |
| packages/fill                               |     8 | 89.3% |    79.9% |          152 |
| packages/verification                       |    25 | 89.3% |    79.5% |          357 |
| packages/providers                          |    22 | 89.8% |    90.2% |          288 |
| packages/orders                             |    12 | 90.2% |    83.9% |          205 |
| packages/command-bus                        |    11 | 93.2% |    91.3% |           81 |
| packages/orgs                               |    14 | 93.9% |    89.8% |          118 |
| _(remaining 20 packages all ≥ 93.6% lines)_ |       |       |          |              |

Security-critical packages held to the 85% CI floor (`crypto`, `audit`,
`command-bus`, `tenancy`, `rbac`, `sla`) are all comfortably above it
(93.2–100%).

The big two by missed-line volume are **apps/web server helpers** (the
`src/server/ops` and `src/server/compliance` read-model layer is almost
entirely untested) and **apps/worker drains/loops** (several outbox handlers
have zero coverage). Both sit outside the command-handler core — which is well
covered — but they are exactly where I/O, retries, and third-party error
handling live.

## The 15 weakest files that matter

Ranked by missed lines. Test infra (`packages/integration-tests/**`) and
env/Sentry bootstrap excluded.

| #   | File                                                                        | Lines | Branches | Missed | What's untested / risk                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------- | ----: | -------: | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/worker/src/drains/webhook-delivery-drainer.ts`                        |    0% |        — |    208 | Entire outbound partner-webhook drain: lease/claim, secret decrypt, signing, retry/backoff, dead-letter on disabled subscription. A regression silently stops or duplicates all partner egress.                  |
| 2   | `apps/web/src/server/ops/resolve-purchase-context.ts`                       |    0% |        — |    203 | Label-purchase input assembly, incl. decryption of 7 PHI address columns and parcel defaults. Bad fallback ships to a wrong/blank address.                                                                       |
| 3   | `apps/worker/src/drains/provider-onboarding-prover.ts`                      |    0% |        — |    182 | NPPES proofing drain: claim, machine-user resolution, registry 429/5xx handling, verdict dispatch. Failure mode is providers stuck in SUBMITTED forever.                                                         |
| 4   | `packages/drug-knowledge/src/rxnorm/ingest.ts`                              |  9.8% |       0% |    174 | Versioned RxNorm release load: checksum, STAGED→LIVE atomic swap, retirement of previous LIVE. The "screening never sees a half-loaded release" invariant is enforced here and has zero branch coverage.         |
| 5   | `apps/worker/src/drains/notify-on-order-escalated.ts`                       |  6.1% |        — |    138 | Emergency-bucket escalation notifications (SLA breach + shipment exception). This is the "alert silently never fired" failure the file's own header warns about — the worst failure mode for an emergency queue. |
| 6   | `packages/workflow/src/policy-lifecycle.ts`                                 | 38.5% |        — |    123 | Policy version register/activate/deactivate validation and `pickPolicyForCreate` selection (ADR-0017). Untested rules could let a draft/superseded policy be stamped onto new orders.                            |
| 7   | `apps/worker/src/drains/shipping-lookups.ts`                                |    0% |        — |    108 | EasyPost webhook → tenant resolution (system-context RLS bypass). A bug here either drops carrier tracking updates or attributes them to the wrong tenant.                                                       |
| 8   | `apps/worker/src/compliance/access-review-job.ts`                           | 73.7% |    71.4% |    104 | Error/edge branches of the quarterly access-review job — silent skips undermine a SOC-2 control that claims to run unattended.                                                                                   |
| 9   | `apps/worker/src/notifications/resend-notification-channel.ts`              | 50.2% |    42.3% |    103 | Resend API error paths: rate-limit, hard-bounce, retryable-vs-permanent classification. Misclassification silently drops patient/ops notifications.                                                              |
| 10  | `apps/web/src/server/ops/decrypt-patient.ts`                                |    0% |        — |    102 | Per-field PHI `tryDecrypt` with partial-failure flags. Untested failure path could 500 the whole record view — or worse, render without flagging decrypt errors.                                                 |
| 11  | `packages/shipping/src/webhooks/prisma-event-store.ts` (+ FedEx twin, 8.7%) |  8.3% |        — |    100 | Webhook idempotency store: P2002 race-on-insert catch-and-refetch, claim/lease semantics. The dedupe layer that makes carrier webhooks idempotent is effectively untested against races.                         |
| 12  | `apps/web/src/server/auth/resolve-tenancy.ts`                               |    0% |        — |     99 | Session → `TenancyContext` bridge (ADR-0030) — the single entry point for operator identity + tenant scope. Any gap here is a cross-tenant-isolation risk, the repo's declared critical incident class.          |
| 13  | `apps/print-agent/src/printer/send-zpl.ts`                                  | 22.0% |        — |     92 | ZPL TCP transport + `~HS` post-send status parse (paper-out/paused/head-up detection). This file exists to enforce "no silent printer failures" and its fault-flag parsing is untested.                          |
| 14  | `packages/security/src/merkle/s3-object-lock-client.ts`                     |  1.2% |        — |     82 | S3 Object Lock port for audit-manifest publishing; the refuse-to-overwrite behavior backing audit-chain immutability is untested (companion `chain-head-consistency.ts` check is at 14%).                        |
| 15  | `apps/worker/src/billing/stripe-invoice-adapter.ts`                         |    0% |        — |     76 | Stripe invoiceItems/invoices/finalize call sequence with per-line idempotency keys. Untested idempotency-key construction risks double-billed lines or silently unfinalized invoices on retry.                   |

Honorable mentions: `packages/auth/src/mfa/webauthn.ts` (10.5% — the
production `@simplewebauthn` adapter, only the fake is exercised),
`packages/patients/src/patient-allergy-profile.ts` (5.0% — allergy projection
incl. "was the patient ever asked?" state, clinical-safety adjacent),
`apps/web/src/server/auth/password-reset-mailer.ts` and
`apps/worker/src/portal-setup-mailer.ts` (0% — silent auth-mail loss),
`packages/telemetry/src/init-telemetry.ts` (15.4%), and the whole
`apps/web/src/server/compliance/*` read-model family (0% across ~600 lines).

## Prioritized backfill list (next wave's brief — top 10)

Effort: **S** ≤ ½ day, **M** ≈ 1 day, **L** ≥ 2 days. Ordered by
risk × reach, not by coverage delta.

1. **[M] `notify-on-order-escalated.ts`** — fake notification channel +
   recipient resolution; assert an escalation event always produces ≥ 1
   notification or a loud failure. Emergency-queue alerting must not be able
   to no-op silently.
2. **[M] `resolve-tenancy.ts`** — table-driven tests over session states
   (absent, expired, revoked, valid) × org/site membership shapes; assert no
   path yields a `TenancyContext` broader than the session. Tenant isolation
   entry point.
3. **[L] `webhook-delivery-drainer.ts`** — in-memory store + fake HTTP: lease
   expiry, backoff schedule, disabled-subscription dead-letter, signature
   header, duplicate-claim race.
4. **[M] `prisma-event-store.ts` + `prisma-fedex-event-store.ts`** — P2002
   race-on-insert, claim/lease contention, terminal-state transitions, using
   a mocked Prisma client (the in-memory twin already pins the contract —
   port those cases to the Prisma implementations).
5. **[M] `stripe-invoice-adapter.ts`** — fake Stripe SDK; assert idempotency
   keys are stable per line/invoice and error-mid-sequence resumes without
   duplicate invoice items. Direct money-loss/double-billing risk.
6. **[M] `send-zpl.ts` (`~HS` parsing)** — feed captured/synthetic `~HS`
   frames (paper out, paused, head open, ribbon out, all-clear, truncated
   frame); assert each fault maps to a FAILED print with reason. "No silent
   printer failures" is a workflow-safety rule.
7. **[M] `policy-lifecycle.ts`** — exhaust the register/activate/deactivate
   validation matrix and `pickPolicyForCreate` (draft vs active vs superseded
   candidates). Keeps the workflow package's ADR-0017 guarantees pinned.
8. **[L] `rxnorm/ingest.ts`** — in-memory Prisma double; checksum mismatch,
   duplicate release, mid-load crash → still STAGED, promote swaps exactly
   one LIVE. Screening correctness depends on the atomic-swap invariant.
9. **[S] `decrypt-patient.ts` + `resolve-purchase-context.ts` decrypt paths** —
   per-field decrypt failure → null + `phiDecryptErrors` flag, never a throw;
   purchase context refuses to build from a partially-decrypted address.
10. **[M] `resend-notification-channel.ts`** — error classification table
    (429 retry, 4xx permanent, 5xx retry, network) + suppression-list
    handling; assert no path drops a notification without recording why.

Not backfilled in this PR by design — this list is the scoped brief for the
next wave.

## Related change in this PR

`packages/workflow/src/workflow-properties.test.ts` adds seeded property-based
tests (fast-check) over the workflow engine, overlay merge, and bucket
routing. No invariant violations were found; one **trust boundary** is now
pinned by a test rather than only by a comment: the engine accepts ANY
non-terminal, non-`ON_HOLD` `releaseToState` on `RELEASE_HOLD` — the guarantee
that an order resumes where it was held relies on the command bus supplying
the recorded pre-hold state from the hold record (documented in `engine.ts`).
