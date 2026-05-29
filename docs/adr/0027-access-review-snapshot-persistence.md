# 0027 — Access review snapshots are database-canonical, JSON is the export

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** Platform team, Security & Compliance
- **Tags:** `security`, `compliance`, `data`, `soc2`

## Context

SOC 2 CC6.2 requires periodic review of who has access to what. The
`@pharmax/security::generateAccessReview` function produces a
JSON-serializable `AccessReviewReport` summarizing every active
`(user → role → scope → permission)` assignment for one organization
at a point in time, plus a reviewer's-eye summary highlighting
elevated principals, inactive principals, stale assignments, and
roles holding the highest-blast-radius permission
(`patients.crypto_shred`).

Until this change, the only output channel for the report was a JSON
file written to `evidence/access-reviews/<YYYY-Q#>/<org-slug>.json` by
`scripts/security/run-access-review.ts`. The file was committed to
the SOC 2 evidence repository alongside a signed PDF of the human
reviewer's sign-off. That gave us **a** record per quarter, but it
had four gaps that an auditor could legitimately raise:

1. **No tamper-evidence.** Any operator with write access to the
   evidence repo could replace the JSON file after the fact. The
   sign-off PDF would still reference the original date, but the
   content the auditor reads might not match what was actually
   reviewed.
2. **No provenance into the audit chain.** The JSON sat outside the
   `command_log` + `audit_log` + `event_outbox` plumbing that
   underwrites every other tamper-evident write on the platform.
3. **No machine-queryable history.** "Has org X completed an access
   review in the last 90 days?" required walking a directory tree
   on a developer machine, not a SQL query an automated probe
   (nightly security digest, SOC 2 dashboard) could run.
4. **No bridge to the operator console.** The future operator-facing
   compliance browse surface ("Show me last quarter's evidence for
   my organization") cannot read JSON files on a developer's disk
   — it needs a row in the tenant-scoped database.

We needed a persisted, immutable, RLS-scoped row that the audit
chain reaches and the future read API can serve, without throwing
away the JSON evidence-pack workflow the reviewer process already
depends on.

## Decision

Make the database row the **canonical** SOC 2 evidence, and reduce
the JSON file to a derived export of that row.

1. **Schema.** Add the `access_review_snapshot` table (migration
   `20260615000000_phase5_access_review_snapshot`). Columns:
   - `id` (UUID, PK), `organizationId` (FK, RLS-scoped),
     `organizationSlug` (denormalized so a later org rename does not
     retroactively alter the evidence label),
   - `periodStart`, `periodEnd`, `generatedAt` (the reporting
     window the snapshot summarizes plus the wall time it was
     produced),
   - five denormalized summary scalars (`totalPrincipals`,
     `elevatedPrincipalCount`, `inactivePrincipalCount`,
     `staleAssignmentCount`, `cryptoShredCapableRoleCount`) so an
     auditor can answer "how many elevated principals in `<org>` at
     `<date>`?" without parsing JSONB,
   - `report` (JSONB) — the full `AccessReviewReport` payload,
     frozen at write time,
   - `digestSha256` (hex) — canonical-JSON SHA-256 of `report`,
   - `reportVersion` (int, default 1) — schema discriminator for
     incompatible future shape changes,
   - `recordedByUserId` (FK, nullable for future system-tier
     scheduled jobs),
   - `commandLogId` (FK, NOT NULL) — the audit-chain hop from
     snapshot → command_log → audit_log → event_outbox.

   The table has RLS enabled with the standard `tenant_isolation`
   policy. There are no UPDATE or DELETE grants beyond the
   `pharmax_system` role used for migrations and forensic repair;
   day-to-day inserts come exclusively through the command bus.

2. **Tenant command, not system command.** `RecordAccessReviewSnapshot`
   is implemented in `@pharmax/security` as a tenant `Command`
   (not a `SystemCommand`). Two reasons:
   - The `command_log` FK on `access_review_snapshot` is NOT NULL.
     The tenant executor writes `command_log` PRE-transaction, so
     the handler can immediately insert a row that FK-references
     it. The system executor writes `command_log` INSIDE the
     transaction AFTER the handler runs (it has to discover the
     org id from the handler's return value first) — at handler
     execution time there is no row for the snapshot FK to target,
     and the insert would fail with FK-constraint-not-satisfied.
   - Snapshots are per-organization evidence; the operator who
     produces evidence (a security officer running the quarterly
     CLI, the future scheduled-worker service user) belongs to the
     target org. Running under that operator's tenancy context is
     exactly the security model SOC 2 expects. Tenant-scoped RLS
     also closes the leak surface for the future read path for
     free.

3. **Permission.** Add `compliance.access_review.record` as a
   distinct permission from the already-landed
   `compliance.access_review.view`. The author of evidence and the
   reader of evidence are different responsibilities — separating
   them means a viewer cannot retroactively forge a snapshot.
   `OrgAdmin` gets both by default; future dedicated role templates
   (SecurityOfficer / ComplianceOfficer) will carry one or both as
   appropriate.

4. **Tamper-evidence via canonical-JSON SHA-256.** The handler
   computes `digestSha256 = sha256(canonical_stringify(report))`
   server-side and stores both. An auditor who downloads the JSON
   evidence file recomputes the digest and confirms it matches the
   `digestSha256` column AND the value emitted on the
   `compliance.access_review_snapshot.recorded.v1` outbox event.
   Any divergence is an integrity incident.

   The canonical-JSON normalization (recursively sort object keys,
   preserve array order) matches the semantics already established
   in `@pharmax/command-bus`'s `canonicalStringify` and in
   `@pharmax/audit/chain/encoder.ts` for the per-row audit hash.

5. **Outbox event.** Register
   `compliance.access_review_snapshot.recorded.v1`
   (owner=`security`, retention=`7y`, phiSafe=`true`,
   routingKey=`tenant.compliance`). Payload carries the snapshot id,
   organization id + slug, period bounds, summary scalars, digest,
   the recording operator's id, and the `commandLogId` so any
   downstream consumer can reach the full audit chain.

6. **CLI dual-write.** `scripts/security/run-access-review.ts`
   dispatches the command (DB row first) and then writes the JSON
   evidence-pack file. Flags `--skip-db`, `--skip-file`, and
   `--dry-run` cover the back-compat and previewing cases. The
   operator is identified by `--as-user=<email>` and looked up in
   system context; the CLI then enters that operator's tenancy
   before dispatching.

## Consequences

What becomes easier:

- **Auditable evidence pipeline.** Producing the per-quarter
  snapshot is now a single `executeCommand` call that lands inside
  the bus's standard `command_log` + `audit_log` + `event_outbox`
  pipeline. A SOC 2 reviewer follows the same provenance path they
  follow for every other workflow event.
- **Tamper-evidence by construction.** Replacing a JSON file in
  the evidence repo no longer "wins" — the canonical digest on the
  row contradicts the swap.
- **Read API is straightforward.** The future
  `/api/admin/access-reviews` endpoint reads tenant-scoped rows
  with no extra plumbing; the Prisma extension's auto-injection
  enforces org isolation, and `compliance.access_review.view`
  gates the route.
- **Nightly security digest can light up.** The digest composer
  already has a `AccessReviewCalendarProbe` slot for "last access
  review per org" — the new table is its natural source.
- **Cross-quarter diff tooling becomes possible.** Two snapshot
  rows + their digests are enough to produce a "what changed since
  last quarter" report; previously this would have required
  walking two file trees and re-parsing.

What becomes harder / what we take on:

- **Schema discipline on `report`.** The JSONB column captures
  exactly what `generateAccessReview` produces today. Any
  incompatible shape change (renamed field, restructured
  `summary`) MUST bump `reportVersion` so verifiers and the
  future read API can branch on the version. We do NOT rewrite
  historical rows; they keep their original `reportVersion` and
  digest forever.
- **Operator UX guard rails.** Running the CLI without `--dry-run`
  now requires `--as-user=<email>` so the snapshot can carry a
  `recordedByUserId`. The CLI surfaces a clear error if the
  operator is missing, inactive, or in the wrong org — but this
  is one more thing reviewers need to know.
- **PHI invariant carries forward.** `generateAccessReview` is the
  single producer and it is PHI-free by construction (operator
  identity only). If a future iteration ever embeds PHI into the
  report (e.g. patient-touching workflows summarized per role),
  the command's `redactFields` MUST be updated and the
  per-payload PHI invariant on
  `compliance.access_review_snapshot.recorded.v1` re-evaluated.
- **Idempotency contract.** The CLI derives the idempotency key
  from `(quarter, orgId, operatorId)` so a same-quarter re-run by
  the same operator is a replay (returns the cached snapshot id).
  Operators who genuinely want a fresh row mid-quarter must wait
  for the next quarter or dispatch the command directly with a
  new key. Documented in the playbook.

## Alternatives Considered

1. **JSON-only (status quo).** Easy, no schema work. Rejected
   because the four gaps in the Context are real auditor findings
   waiting to happen.

2. **Make the command a `SystemCommand`.** The script already runs
   under `withSystemContext`; a system command would skip the
   per-operator RBAC check and let the CLI run as ops. Rejected
   because:
   - the `command_log` FK ordering makes a system handler insert
     fail (see Decision §2),
   - per-operator accountability is exactly what the SOC 2 author-
     identity invariant wants captured on the row.

3. **Defer the FK via `DEFERRABLE INITIALLY IMMEDIATE`.** Would
   let a system handler insert the snapshot row before the bus
   wrote `command_log` and resolve both at commit. Rejected
   because (a) the cross-cutting bus contract becomes "some
   handlers run before command_log, some after" — a code-review
   trap, and (b) the tenant-command path already gives us the
   right shape with no schema gymnastics.

4. **Add a `postCommandLogWrites` hook to `SystemHandlerResult`.**
   Would let the system bus run the snapshot insert AFTER
   `createCommandLog` but BEFORE `createAuditLogInTx`. Rejected
   because the tenant-command path is the natural fit for
   per-org evidence; expanding the system-bus contract for a
   single command introduces complexity that the simpler choice
   avoids.

## References

- Code:
  - `packages/security/src/access-review/record-access-review-snapshot.ts`
  - `packages/security/src/access-review/generate-access-review.ts`
  - `packages/security/src/access-review/README.md`
  - `packages/events/src/events/compliance/access-review-snapshot-recorded-v1.ts`
  - `scripts/security/run-access-review.ts`
- Migrations:
  - `prisma/migrations/20260615000000_phase5_access_review_snapshot/`
- Companion ADRs:
  - `0011-row-level-security.md` (RLS pattern this row depends on)
  - `0018-event-schema-registry.md` (event registration)
  - `0024-merkle-root-signing-and-evidence.md` (per-org daily
    Merkle roots — the audit-side equivalent of this row)
- External: SOC 2 Trust Services Criteria CC6.2 (Logical Access:
  Periodic User Access Reviews).
- Implementation plan: `docs/IMPLEMENTATION_PLAN.md`
  (Phase 5 — Compliance evidence).
