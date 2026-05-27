# 0006 — Hash-chained audit log per tenant with TLV canonical encoding

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** security, audit, compliance

## Context

Pharmax needs a tamper-evident audit log. HIPAA, SOC 2, and the
project's workflow-safety rules require that every sensitive action
be recorded with attribution, context, and integrity.

A plain append-only table — even with `REVOKE UPDATE, DELETE` and
RLS — is **not enough**. A privileged actor (rogue DBA, compromised
service role, leaked migration credential) can still delete rows and
re-insert a "cleaner" history without leaving an integrity signal.
Auditors and incident responders need to detect "the log was tampered
with between time X and time Y" after the fact.

We also need this guarantee **per tenant** so one organization's
chain cannot occlude another's and so future signing (daily Merkle
roots in S3 Object Lock) operates on clean per-tenant boundaries.

## Decision

Implement a **per-tenant hash-chained audit log** with a deterministic,
collision-resistant entry-hash construction.

- Migration `20260522190000_audit_chain` adds three columns
  (`prev_hash`, `entry_hash`, `seq`) backed by a
  `(organizationId, seq)` unique index.
- A companion table `audit_chain_state` holds the latest
  `(latestHash, latestSeq)` per organization so the writer never
  scans `audit_log`. An advisory-lock helper
  `audit_chain_lock_key(uuid)` derives a stable BIGINT key from the
  org UUID, salted to avoid collision with Prisma's migration lock.
- `@pharmax/audit::writeAuditLogInTx(tx, input)` is the **only**
  supported audit insert path. It acquires
  `pg_advisory_xact_lock(audit_chain_lock_key(orgId))` as the first
  statement, reads the chain head, computes
  `entryHash = SHA-256(canonical(prevHash, organizationId, seq,
action, resourceType, resourceId, actorUserId, scope, metadata,
occurredAt))`, inserts the audit row, and upserts the chain head
  — all inside the caller's transaction so a rollback leaves the
  head untouched.
- The **canonical encoding** is a TLV (Tag-Length-Value) format:
  1-byte field tag + 4-byte big-endian length + value, with a NULL
  sentinel (`length=0xFFFFFFFF`) that distinguishes "field present
  but null" from "field present and empty". Field order is fixed
  and version-controlled. JSON columns are sorted-key stringified;
  BigInts in metadata are rejected at encode time.
- `verifyChain(source, args)` walks a tenant's chain in ascending seq
  order and fails fast on the first inconsistency
  (`AUDIT_CHAIN_BROKEN`) with the offending seq and a reason tag.
- The command bus delegates to the chain writer; handler authors see
  no chain at all.

## Consequences

**Easier:**

- Tampering with `audit_log` becomes detectable after the fact. Even
  a privileged actor with DB access cannot rewrite history without
  breaking the chain for some seq value, which `verifyChain` will
  surface.
- The chain is **byte-equivalent** between writer and verifier
  because `computeAuditEntryHash` is pure and exposed. The verifier
  re-derives hashes from persisted bytes; integrity is reproducible.
- A future daily Merkle-root signing job (deferred) reads
  `audit_chain_state` rolling forward, builds a per-day per-tenant
  Merkle tree, signs with a KMS asymmetric key, and writes the
  manifest to S3 Object Lock — closing the loop against even
  internal-state tampering.

**Harder:**

- Every audit write costs one advisory lock per tenant. We accept
  this; the lock is xact-scoped and serializes writes per tenant,
  not globally.
- The TLV encoder is **version-controlled**. A change to field
  order, sentinel encoding, or tag values silently breaks historical
  verification. Encoder changes require a chain-format version
  bump, not a hot fix.
- Bigint values in metadata are rejected at encode time. Callers
  must string-encode them. This surprises new contributors; the
  encoder error message points to the fix.

**Ongoing obligations:**

- New audit-emitting code goes through `@pharmax/audit::writeAuditLogInTx`
  (the bus already does this; direct callers should not exist).
- Encoder changes require a new chain-format version, not a mutation.
- The daily signing job, when it lands, is the operational close on
  this story.

## Alternatives Considered

- **Plain append-only table with REVOKE UPDATE, DELETE.** Detects
  in-band UPDATE/DELETE attempts; does **not** detect a privileged
  rewrite that bypasses the role.
- **JSON-encoded entry hashes without TLV.** Loses determinism —
  whitespace and key ordering across JSON encoders silently produce
  different bytes for the same logical row.
- **Single global chain.** Conflates per-tenant integrity; one
  tenant's tamper would invalidate every other tenant's signing run.

## References

- ADR 0007 — Twenty-step command-bus contract (delegates to `writeAuditLogInTx`)
- `prisma/migrations/20260522190000_audit_chain/`
- `packages/audit/` — `writeAuditLogInTx`, `verifyChain`, `computeAuditEntryHash`
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.3, §C.4
- Deferred: daily Merkle-root signing job (KMS + S3 Object Lock)
