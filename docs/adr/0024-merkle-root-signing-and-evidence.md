# 0024 — Daily Merkle root signing and evidence

- **Status:** Accepted (scaffold landed; wiring pending KMS + S3 lanes)
- **Date:** 2026-05-25
- **Deciders:** Platform team, Security officer
- **Tags:** `security`, `compliance`, `audit`, `data`

## Context

Pharmax's audit log is already tamper-evident at the row level. Every
`audit_log` row carries `entryHash = SHA-256(canonical(prevHash, ..., row))`
and a per-tenant `seq` monotonic from genesis; the chain is written
under a per-tenant Postgres advisory lock and verified by
[`@pharmax/audit::verifyChain`](../../packages/audit/src/chain/verifier.ts).
See ADR-0006 (hash-chained audit log).

That design proves "no row inside the chain was modified after it was
written" — assuming the chain head pointer in `audit_chain_state`
itself is trustworthy. Two threat models are still uncovered:

1. **Database-admin tampering.** A privileged DB actor with full table
   access could rewrite `audit_log` AND `audit_chain_state` in a
   coordinated way: re-derive every `entryHash` from the modified
   rows, update the chain head, and the in-database verifier sees
   nothing wrong.
2. **Restore-from-backup ambiguity.** An auditor wants to assert "no
   row was added, modified, or removed between T1 and T2." The
   in-database verifier can only assert "the current state is
   internally consistent" — it cannot prove the state hasn't been
   wound back to an earlier consistent state.

Both threats require a commitment that:

- is produced from the audit chain at a specific time, AND
- is signed by a key that the application process does NOT hold (so a
  compromise of the application server cannot forge the commitment),
  AND
- is stored in a location the application server can WRITE but not
  MODIFY (so neither the writer nor a future attacker can revise the
  history they already published).

SOC 2 CC7.2 and PI1.4 explicitly call out evidence of tamper-evidence
for processing-integrity controls; HIPAA's technical safeguards
(`§164.312(c)(1)` integrity controls) require the same.

## Decision

We commit to a **daily per-tenant Merkle root over the audit chain,
signed by a KMS asymmetric key the application does not hold, and
published to an S3 Object Lock bucket in COMPLIANCE mode.**

The decision has four parts:

- **Compute** — every UTC day (default 02:00 UTC, after the previous
  day's last possible audit row), the worker scans each
  organization's `audit_log` for the previous 24h window and builds a
  binary Merkle tree of `entryHash` values in ascending `seq` order.
  Implemented by
  [`computeDailyMerkleRoot`](../../packages/security/src/merkle/compute-daily-merkle-root.ts).
  Domain-tagged leaf and node hashes per RFC 6962 §2.1.

- **Sign** — the root, the organization id, and the period are signed
  via a domain-tagged preimage by an AWS KMS asymmetric key. The
  worker's IAM role gets `kms:Sign` on that key only; no other
  identity has signing access. Implemented by
  [`MerkleRootSigner`](../../packages/security/src/merkle/sign-merkle-root.ts).
  Local Ed25519 signer is provided for dev/test; production uses
  `KmsAsymmetricSigner` (currently a stub awaiting the Terraform key
  ARN from the deployment lane).

- **Publish** — the signed manifest is written to an S3 Object Lock
  bucket with COMPLIANCE-mode retention matching the SOC 2 retention
  policy. Key shape:
  `<orgId>/<YYYY>/<MM>/<DD>/merkle-manifest.json`. Implemented by
  [`ManifestPublisher`](../../packages/security/src/merkle/publish-merkle-manifest.ts);
  `S3ObjectLockPublisher` is a stub today, `InMemoryManifestPublisher`
  is wired for dev.

- **Verify** — the same manifest can be re-derived from the live
  audit log and the signature re-checked against the published key
  material. Implemented by
  [`verifyMerkleManifest`](../../packages/security/src/merkle/verify-merkle-manifest.ts).
  An auditor pulls a manifest from S3, runs the verifier against
  Postgres, and gets a binary pass/fail with structured reasons.

The whole pipeline runs as a worker loop
([`apps/worker/src/security/daily-merkle-root-loop.ts`](../../apps/worker/src/security/daily-merkle-root-loop.ts))
and is wired into the SOC 2 evidence-collection guide
([`docs/compliance/evidence-collection-guide.md`](../compliance/evidence-collection-guide.md))
under criteria CC7.2 and PI1.4.

## Consequences

**Easier:**

- An auditor can verify processing-integrity over any chosen window
  in minutes, without trusting the Pharmax process or its DB
  administrator.
- Database-admin tampering becomes evident: any post-hoc edit to
  `audit_log` rows inside a window produces a Merkle root that no
  longer matches the published signed manifest.
- A future incident response that includes "did this period get
  rewound from a backup?" has a yes/no answer from the manifest
  series.

**Harder / more expensive:**

- Operational responsibility expands. We now own a daily cron-style
  job, a KMS asymmetric key, an S3 bucket with COMPLIANCE-mode
  Object Lock, and the IAM glue between them. Misconfigurations
  here are themselves an incident.
- Signing the wrong root is silent unless the verifier runs. We
  commit to running the verifier at least monthly per organization
  (per `scripts/security/verify-audit-chain-all-orgs.ts`) and to
  including a "manifests verified" line in the nightly digest.
- KMS sign latency adds to the worker's daily wall-clock. At our
  current org count this is negligible; at 10k orgs the daily window
  becomes a sizing consideration. The loop is intentionally
  sequential per-org today to keep KMS request rate predictable.
- Retention follows the bucket's Object Lock duration, which is a
  one-way ratchet. Choosing 7 years means manifest objects cannot be
  deleted for 7 years even if the underlying tenant is offboarded.
  Pharmax retains them anyway for HIPAA — but the decision is now
  cryptographically enforced.

**Failure modes and detection:**

- _KMS key unavailable:_ the worker logs a structured error and skips
  the org for that day. The next day's run includes a separate
  manifest for that day's window; the missed day stays missed but
  becomes evident in the digest. Manual remediation: re-run
  `scripts/security/sign-daily-merkle-root.ts --date=YYYY-MM-DD`.
- _S3 PUT fails:_ same as KMS — logged, skipped, evident in the
  digest. The bucket's Object Lock will refuse a second PUT to the
  same key, so the manifest cannot be silently overwritten.
- _Signing key compromise:_ manifests signed after the compromise are
  invalid. The recovery path is a key rotation event documented in
  `docs/RUNBOOK.md` (the "Rotating a KMS data key" section is the
  template; rotation of the asymmetric audit key is a separate
  procedure). Manifests signed before the compromise remain valid
  because each manifest carries `signerKid`; the verifier accepts
  any historically-trusted kid.

## Alternatives Considered

**A. Sign the chain head directly (no Merkle tree).**

- _What:_ sign `audit_chain_state.latestHash` daily.
- _Why attractive:_ simpler — one signature per org per day, no tree
  to construct.
- _Why rejected:_ the chain-head hash already commits to every row
  via the chain, but it does not support **partial verification**.
  An auditor reviewing the period [T1, T2] would have to verify the
  ENTIRE chain back to genesis to re-derive `latestHash`. With a
  per-day Merkle root, the auditor verifies one day's window in
  isolation. The Merkle approach also keeps the signed object's
  semantics ("this is the period from X to Y") explicit rather than
  implicit.

**B. Use Postgres logical-replication WAL as the tamper-evident
trace.**

- _What:_ stream WAL to an immutable sink and replay.
- _Why attractive:_ zero domain-code changes; the WAL already
  contains every write.
- _Why rejected:_ WAL is at the wrong abstraction layer. It contains
  every byte of every row including PHI; storing it in an
  Object-Lock bucket would create a long-lived PHI custody surface
  that contradicts the envelope-encryption model in ADR-0005.
  The audit log is by design PHI-free; signing its Merkle root is
  the right grain.

**C. Use an external transparency-log service (e.g., Sigstore
Rekor, Google's CT logs).**

- _What:_ publish the Merkle root to a third-party append-only log.
- _Why attractive:_ offloads the immutability problem to a service
  whose business model is exactly that.
- _Why rejected:_ introduces a third-party custody surface for what
  amounts to per-tenant timestamps that COULD correlate to PHI
  events. Even though the manifest itself is PHI-free, the _count_
  of audit events per day per tenant is sensitive data. We may add
  a transparency-log mirror as a future enhancement; for now, the
  audit-archive S3 bucket under our own KMS + IAM stays the system
  of record.

## References

- Code:
  - [`packages/security/src/merkle/compute-daily-merkle-root.ts`](../../packages/security/src/merkle/compute-daily-merkle-root.ts)
  - [`packages/security/src/merkle/sign-merkle-root.ts`](../../packages/security/src/merkle/sign-merkle-root.ts)
  - [`packages/security/src/merkle/publish-merkle-manifest.ts`](../../packages/security/src/merkle/publish-merkle-manifest.ts)
  - [`packages/security/src/merkle/verify-merkle-manifest.ts`](../../packages/security/src/merkle/verify-merkle-manifest.ts)
  - [`apps/worker/src/security/daily-merkle-root-loop.ts`](../../apps/worker/src/security/daily-merkle-root-loop.ts)
  - [`scripts/security/sign-daily-merkle-root.ts`](../../scripts/security/sign-daily-merkle-root.ts)
- Companion ADRs:
  - `0004-multi-tenancy-via-postgres-rls.md` — per-tenant data isolation.
  - `0005-envelope-encryption-per-phi-field.md` — why audit_log is PHI-free.
  - `0006-hash-chained-audit-log.md` — the row-level chain this signs over.
  - `0011-separation-of-duties-at-command-bus.md` — break-glass session is in the same family.
- External: RFC 6962 §2.1 (Certificate Transparency Merkle Trees);
  AWS KMS Sign/Verify documentation; AWS S3 Object Lock COMPLIANCE
  mode documentation.
- Implementation plan: `docs/IMPLEMENTATION_PLAN.md` (Phase 5,
  "Compliance evidence: control matrix, log retention policies, KMS
  rotation runbook, access-review jobs").
