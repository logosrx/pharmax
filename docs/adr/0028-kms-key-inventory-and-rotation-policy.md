# 0028 — KMS key inventory and rotation policy

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** Platform team, Security
- **Tags:** `security`, `crypto`, `hipaa`, `soc2`, `runbook`

## Context

The Pharmax stack uses eight customer-managed AWS KMS keys (per
environment, per region) for distinct cryptographic purposes:
RDS storage, S3 documents, S3 audit archive, Secrets Manager,
PHI field envelope encryption (#5), blind-index HMAC (#6),
Merkle root signing (#7), and CloudWatch Logs. ADR-0023 covers
keys #5–#6 in detail; ADR-0024 covers key #7; the others were
provisioned alongside the rest of the AWS posture without a
dedicated ADR.

This created two SOC 2 evidence gaps:

1. **No single source of truth for the inventory.** A reader
   asking "what KMS keys does Pharmax use?" had to piece the
   answer together from `infra/terraform/modules/kms/main.tf`,
   ADR-0023, ADR-0024, `docs/security/encryption-overview.md`,
   and seven separate sections in `docs/RUNBOOK.md`. Auditors
   ask this question first; SOC 2 CC6.7 explicitly enumerates
   "the entity restricts the transmission, movement, and removal
   of information to authorized internal and external users and
   processes, and protects it during transmission, movement,
   or removal", which folds key inventory into the CC6.7
   evidence ask.

2. **No drill cadence for rotation.** Per-key rotation
   procedures existed in the runbook but had never been exercised
   end-to-end. SOC 2 evidence for CC6.7 needs to show that the
   procedure works, not that the procedure exists. A
   never-executed rotation runbook is the equivalent of an
   untested backup — it might work, it might not, and the
   auditor cannot tell either way.

A third smaller problem surfaced during the survey work: the
`AwsKmsAdapter.signRoot` / `verifyRoot` methods carried stale
"not yet wired" error messages from before `KmsAsymmetricSigner`
landed in `@pharmax/security`. The functionality moved to a
parallel slice (ADR-0024); the adapter stubs remained. The
intent is correct (asymmetric signing belongs on a separately
IAM-scoped port) but the error message was misleading.

## Decision

Three commitments:

1. **Maintain `docs/security/kms-key-inventory.md` as the single
   source of truth** for every customer-managed KMS key the
   production stack uses. Add, remove, or change a key in
   Terraform → update the inventory in the same PR. CI will
   eventually enforce this drift; until then the PR review
   checklist is the gate. Track as `kms3` follow-up.

2. **Adopt a quarterly KMS rotation drill cadence** (see
   `docs/RUNBOOK.md` § "Quarterly KMS rotation drill").
   - Q1 + Q4: data key (the most security-critical).
   - Q2: search key.
   - Q3: Merkle signing key.
   - Drills run in **staging only**, are non-destructive
     (provision sibling CMK, swap alias, run `pnpm verify:kms`,
     roll back), and produce a structured evidence pack the
     SOC 2 auditor reads.

3. **Clarify `AwsKmsAdapter`'s signing surface as intentionally
   not-implemented.** Replace the stale "not yet wired" error
   messages on `signRoot` / `verifyRoot` with explicit
   redirection to `KmsAsymmetricSigner` from `@pharmax/security`.
   The IAM split — PHI-decrypt principal does not hold
   `kms:Sign` — is structural enforcement that a PHI-data-key
   compromise cannot forge audit manifests.

The rotation policy itself is summarised here and lives in
operational detail in the key inventory:

| Trigger                                            | Cadence       | Evidence                                  |
| -------------------------------------------------- | ------------- | ----------------------------------------- |
| Automatic key-material rotation (symmetric / HMAC) | Annual        | CloudTrail; `verify:kms`                  |
| Manual CMK identity rotation                       | On compromise | Per-key runbook entry                     |
| Asymmetric signing key rotation (#7)               | On compromise | RUNBOOK § Rotating the Merkle signing key |
| Quarterly KMS rotation drill                       | Quarterly     | Ticket attachments per drill              |

Application-level `kid` version bumps (`v1 → v2` in the
`aws:kek:<label>:<tenantId>:vN` format) are out of scope for this
ADR — they are code-level migrations, not operator-time steps,
and remain reserved for a future ADR if and when needed.

## Consequences

**What becomes easier:**

- A SOC 2 auditor walking the encryption posture has a single
  page to read (the inventory) plus the policy decisions in
  this ADR. Previously they would interview the team or read
  five files.
- An on-call engineer responding to a KMS-related incident has
  the inventory's per-key blast-radius statement at hand without
  re-deriving it from code.
- A new engineer onboarding to the security surface understands
  why we have eight keys (not one or two), what each protects,
  and what breaks if it goes away, in 10 minutes of reading.
- The quarterly drill produces dated artifacts every 90 days,
  so SOC 2 CC6.7 evidence accumulates without a special
  end-of-period scramble.
- The `signRoot`/`verifyRoot` cleanup eliminates a class of
  "looks broken but isn't" bug reports — the error message now
  tells the operator exactly which port to use.

**What becomes harder or more expensive:**

- A maintenance commitment: every Terraform change to the KMS
  module requires an inventory PR. We accept this; the
  alternative (auditing a stale inventory) is worse.
- Engineering time: ~4 hours per quarter for the drill captain
  (provision, swap, verify, roll back, write up). The drill is
  intentionally non-destructive so total wall-clock is limited
  by deploy cycles, not by reverse-engineering broken state.
- The drill exercises staging only, so we still rely on the
  procedure's logical correctness for the production case. The
  drill rehearses the operator's muscle memory and surfaces
  procedural gaps; it does not guarantee the prod path is
  identical in every detail.

**Ongoing obligations:**

- Drill captain rotates per quarter; same rotation as the
  restore-from-backup drill. The roster lives in the operations
  runbook annex (TBD; track in follow-up).
- The drill captain documents any divergence from the runbook;
  divergences become PRs to update the runbook before the next
  quarter's drill.
- Skipping a quarterly drill is a SOC 2 finding. Drill output
  goes into the CC6.7 evidence pack for the period.
- `code-evidence-map.md` CC6.7 row must reference the inventory
  and the drill artifacts; the CC6.7 row is the auditor's
  pointer into this ADR's operational implementation.

**Failure modes and detection:**

- **Inventory drift.** Someone changes the KMS Terraform module
  without updating the inventory. The PR review checklist is
  the immediate detection. The `kms3` follow-up adds a CI
  check that diffs the two; until that lands, the review is
  the only gate.
- **Drill skipped.** Quarter passes without a captain assigned;
  caught by the SOC 2 evidence-pack assembly (the period's
  CC6.7 attachment is missing). The drill calendar is owned by
  the security on-call rotation.
- **Drill executed but rollback forgotten.** The most
  operationally dangerous failure mode — staging continues to
  point at the drill alias after the drill ends. Detected by
  the closing `verify:kms` snapshot diverging from the opening
  snapshot. The runbook's "When the drill fails" section
  escalates this to an incident.
- **Misleading `signRoot`/`verifyRoot` error in prod.** If a
  composition root is miswired and calls these methods in
  production, the operator now sees an explicit message
  redirecting to the correct port (`KmsAsymmetricSigner`).
  Previously they saw a "not yet wired" message that suggested
  the platform was incomplete; now they see "miswired
  composition root" which points at the actual root cause.

## Alternatives Considered

**One ADR per KMS key.** Each of the eight keys gets its own
ADR. Rejected because the cross-key invariants (no
`Principal: *`, application grants live in IAM, rotation
cadence) are properties of the inventory as a whole, not of
any individual key. Eight ADRs would duplicate the rationale
and make drift detection harder. The inventory document is the
right shape for "the set of facts about this collection of
keys"; ADR-0028 is the right shape for "the policy decisions
that govern the set."

**Skip the inventory; rely on `infra/terraform/modules/kms/main.tf`
inline comments.** Rejected because auditors do not read
Terraform comfortably and the comments lack the operational
context (env vars, owning apps, blast radius). The Terraform
module is the source of truth for what exists; the inventory
is the source of truth for what each key means to the
operation.

**Annual rotation drill instead of quarterly.** Cheaper, lighter
on engineering time. Rejected because SOC 2 review cycles are
typically annual, and an annual drill arrives at the same
moment as the audit — no time to act on divergences before the
evidence is needed. Quarterly cadence puts the most recent
drill three months ahead of the evidence cutoff at worst,
which gives a clean correction window.

**Move asymmetric signing to `AwsKmsAdapter` (implement the
stubs).** Symmetric: yes, that would make the stub real instead
of throwing. Rejected because:

- The IAM split (PHI principal does NOT hold `kms:Sign`) is the
  load-bearing security property of ADR-0024. Collapsing the
  ports would either grant `kms:Sign` to the PHI principal
  (security regression) or require complex IAM gymnastics to
  keep the two principals on the same code path (operational
  regression).
- The asymmetric `Sign` / `GetPublicKey` SDK surface is
  separate from the symmetric `GenerateDataKey` / `Decrypt`
  / `Mac` surface; sharing one wrapper class would mix two
  unrelated AWS APIs and complicate the test surface for both.
- The `KmsAsymmetricSigner` in `@pharmax/security` is already
  built, tested, and wired by the worker composition root.
  There is no "implementation gap" — only a documentation gap
  that the cleanup addresses.

## References

- Code: `packages/crypto/src/aws-kms-adapter.ts` (stub cleanup)
- Code: `packages/crypto/src/kms-adapter.ts` (port contract)
- Code: `packages/security/src/merkle/kms-signing-client.ts`
  (the asymmetric signer the stubs delegate to)
- IaC: `infra/terraform/modules/kms/main.tf` (the eight keys)
- IaC: `infra/terraform/modules/iam/main.tf` (per-app grants)
- Inventory: `docs/security/kms-key-inventory.md`
- Runbook: `docs/RUNBOOK.md` §§ "Rotating a KMS data key",
  "Rotating the KMS search-key (HMAC) key", "Verifying KMS in
  production", "Quarterly KMS rotation drill",
  "Rotating the Merkle signing key"
- Companion ADRs: `0005-envelope-encryption-per-phi-field.md`,
  `0010-blind-indexes-for-phi-search.md`,
  `0023-aws-kms-adapter.md`,
  `0024-merkle-root-signing-and-evidence.md`
- Code-evidence map: `docs/soc2/code-evidence-map.md` (CC6.7 row)
- External: AWS KMS automatic rotation (annual on symmetric +
  HMAC since Apr 2023); AWS KMS asymmetric key family
  (NOT auto-rotated).
