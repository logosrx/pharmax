# SOC 2 Evidence Collection Guide

For a SOC 2 Type 2 auditor. Each Trust Services Criterion (TSC) below
states the control intent, the system component that satisfies it, and
the exact artifact(s) to pull as evidence. Folder convention:

```
evidence/
  <period>/                          e.g. 2026-Q2
    <criterion>/                     e.g. CC6.1
      <artifact>.{json,pdf,sql,txt}
```

The same evidence is regenerable from source — every artifact is
either:

1. A query you can re-run (`SELECT ...`), or
2. A script under `scripts/security/` that produces a JSON file, or
3. A CI run log (GitHub Actions, GitLab CI, etc.), or
4. A Terraform plan/apply output stored in object storage.

Auditors prefer regenerable evidence over screenshots — a screenshot
doesn't tell them whether the system _still_ enforces the control.

## Common Criteria (CC)

### CC6.1 — Logical and physical access controls restrict access

**Intent:** Only authorized identities reach Pharmax data, and the
authorization is logged.

**Where it lives:**

- Identity layer: Clerk (sign-in, MFA, session). See ADR-0015.
- Authorization layer: `@pharmax/rbac` + `user_role` table.
- Tenancy isolation: Postgres RLS policies. See ADR-0004.

**Evidence to pull:**

1. `evidence/<period>/CC6.1/clerk-user-export.json` — Clerk Dashboard
   export of every active user (id, email, MFA-enabled flag, last
   sign-in). Pull from the Clerk Dashboard's "Export users" feature.
2. `evidence/<period>/CC6.1/rls-policy-snapshot.sql` — output of:
   ```sql
   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
     FROM pg_policies
    WHERE schemaname = 'public';
   ```
3. `evidence/<period>/CC6.1/access-reviews/` — every per-org JSON from
   `scripts/security/run-access-review.ts` for the period (one per
   quarter, see CC6.2).
4. `evidence/<period>/CC6.1/permission-registry.md` — printout of
   `packages/rbac/src/permissions.ts` at the period-end commit.

### CC6.2 — Access is granted based on business need

**Intent:** Every (user, role, scope) assignment is justified and
reviewed at least quarterly.

**Where it lives:**

- `packages/security/src/access-review/`.
- `scripts/security/run-access-review.ts`.

**Evidence to pull:**

1. `evidence/<period>/CC6.2/<org-slug>.json` — one access review report
   per organization for the quarter.
2. `evidence/<period>/CC6.2/signed-reviews/<org-slug>.pdf` — the same
   report after the reviewer's sign-off (see
   `packages/security/src/access-review/README.md`).

### CC6.6 — System protects against unauthorized access from outside

**Intent:** External network paths into Pharmax are restricted and
monitored.

**Where it lives:**

- Terraform: VPC, security groups, WAF rules (Lane 2 deliverable).
- Application: Clerk middleware on every `/api/ops/*` route.
- Webhook signature verification (Stripe, EasyPost, Clerk).

**Evidence to pull:**

1. `evidence/<period>/CC6.6/terraform-plan.txt` — `terraform plan`
   output against the production state showing the WAF + SG rules.
2. `evidence/<period>/CC6.6/clerk-webhook-signing-key.txt` — proof of
   active key (id only — NEVER export the key material itself).
3. `evidence/<period>/CC6.6/sample-blocked-requests.log` — slice of
   WAF logs showing blocked requests during the period.

### CC7.2 — System monitoring detects security events

**Intent:** Anomalous activity triggers alerts and is investigated.

**Where it lives:**

- Sentry: every `logger.error(...)` and uncaught exception. See
  `docs/OBSERVABILITY.md`.
- Audit chain integrity verifier:
  `scripts/security/verify-audit-chain-all-orgs.ts`.
- Nightly security digest:
  `scripts/security/send-nightly-security-digest.ts`.

**Evidence to pull:**

1. `evidence/<period>/CC7.2/sentry-alerts/<incident-id>.json` — Sentry
   issue snapshots for each alert during the period.
2. `evidence/<period>/CC7.2/audit-chain-verifications/` — at least one
   verifier run per organization per month. Each is the script's
   tab-delimited output captured to a file.
3. `evidence/<period>/CC7.2/security-digests/` — every nightly digest
   for the period. The digests are non-PHI by construction.

### CC7.4 — Response to identified security events

**Intent:** Incidents are triaged, contained, and post-mortemed.

**Where it lives:**

- `docs/INCIDENT_RESPONSE.md`.
- `docs/compliance/break-glass-runbook.md` (this folder).
- `docs/RUNBOOK.md`.

**Evidence to pull:**

1. `evidence/<period>/CC7.4/incident-tickets/<INC-id>.pdf` — exported
   ticket from the incident-management system (PagerDuty/Linear/Jira).
2. `evidence/<period>/CC7.4/postmortems/<INC-id>.md` — root-cause +
   remediation document for each Sev1/Sev2.
3. `evidence/<period>/CC7.4/break-glass-sessions/<period>.json` — list
   of every break-glass session opened during the period, derived
   from the `break_glass_session` table.

## Availability (A)

### A1.2 — System capacity and availability are managed

**Intent:** Capacity is provisioned, monitored, and adjusted to meet
the availability commitment.

**Where it lives:**

- Terraform-defined resources (Lane 2).
- Worker observability dashboards (Datadog / CloudWatch).
- Outbox + queue depth alerts.

**Evidence to pull:**

1. `evidence/<period>/A1.2/cloudwatch-cpu-mem-snapshots/` — 95th-
   percentile CPU + memory per service per month.
2. `evidence/<period>/A1.2/outbox-depth-snapshots/` — SQL outputs of
   `SELECT status, count(*) FROM event_outbox GROUP BY status` at
   the start of each month.
3. `evidence/<period>/A1.2/availability-report.md` — uptime calculation
   for each user-facing endpoint.

## Privacy (P)

### P1.1 — Notice of privacy practices

**Intent:** Patients and clinics are informed about how PHI is
handled.

**Where it lives:**

- Public privacy policy URL (legal team owns).
- BAA tracker spreadsheet (security team owns).

**Evidence to pull:**

1. `evidence/<period>/P1.1/privacy-policy-snapshot.pdf` — privacy
   policy as published at period-end.
2. `evidence/<period>/P1.1/baa-tracker.csv` — list of every BAA we
   hold (counterparty, effective date, expiry, custody owner).

## Processing Integrity (PI)

### PI1.4 — System processing is complete, valid, accurate, and timely

**Intent:** Data committed to the system is not silently dropped or
corrupted, and prescriptions move through the workflow without state
loss.

**Where it lives:**

- Workflow safety rules in `.cursor/rules/01-workflow-safety.mdc`.
- Command bus contract (`docs/adr/0007-command-bus-twenty-step-contract.md`).
- Tamper-evident audit chain (`@pharmax/audit`).
- Daily Merkle root signing (`@pharmax/security`, ADR-0024).

**Evidence to pull:**

1. `evidence/<period>/PI1.4/merkle-manifests/<org-slug>/` — every
   signed Merkle manifest for the period. Pulled from the S3 Object
   Lock bucket (or `InMemoryManifestPublisher` log during the
   transition window).
2. `evidence/<period>/PI1.4/audit-chain-verifications/` — same as
   CC7.2, but indexed for processing-integrity review.
3. `evidence/<period>/PI1.4/sla-breach-summary.csv` — count of orders
   over SLA per stage per organization. Generated by a reporting
   query against `order_stage_interval`.

## Pulling a full evidence package

The recommended workflow for a Type 2 period:

1. Create `evidence/<period>/` and a folder per criterion above.
2. Run each script listed for the period, redirect output into the
   matching folder.
3. Manually export Clerk/Sentry/CloudWatch snapshots referenced above.
4. For each criterion, write a one-page `_summary.md` that points the
   auditor at the underlying artifacts.
5. Commit the whole tree to a SOC 2 evidence repository (separate
   from the main code repo — restrict access to the security and
   compliance team).

## Daily Merkle manifest evidence (ADR-0024)

The daily Merkle pipeline ([ADR-0024](../adr/0024-merkle-root-signing-and-evidence.md))
produces one signed manifest per organization per UTC day in the
audit-archive S3 bucket (Object Lock COMPLIANCE, customer-managed
SSE-KMS). Each manifest commits to every `audit_log` row for that
organization in the manifest's `[periodStart, periodEnd)` window.

### What evidence does each manifest provide?

- **CC7.2 (System monitoring detects security events):** the
  manifest is cryptographic evidence that the row-level chain has
  not been rewritten since the manifest was signed. A rewrite of
  even one byte of any committed row produces a different Merkle
  root, and the published manifest no longer matches.
- **PI1.4 (Processing integrity):** the manifest commits to the
  exact set of audit rows that existed at sign time, in order.
  Missing or added rows are detectable by re-deriving the root
  from the live database and comparing against the signed root.
- **HIPAA § 164.312(c)(1) (Integrity controls):** the
  externally-signed root with COMPLIANCE-mode retention satisfies
  the "mechanisms to corroborate that ePHI has not been altered or
  destroyed in an unauthorized manner" requirement at the audit-
  log layer.

### Scripts that produce manifest evidence

- [`scripts/security/sign-daily-merkle-root.ts`](../../scripts/security/sign-daily-merkle-root.ts)
  (`pnpm security:sign-merkle`) — back-fills a missed manifest or
  generates manifests for one or all organizations on a chosen UTC
  date. Idempotent: re-runs against an existing manifest return the
  existing object's metadata without overwriting (Object Lock
  COMPLIANCE refuses overwrite by design).

- [`scripts/security/verify-merkle-manifest.ts`](../../scripts/security/verify-merkle-manifest.ts)
  (`pnpm security:verify-merkle`) — auditor workflow. Pulls a
  manifest from S3 (or a local copy), re-derives the Merkle root
  from the live `audit_log`, and verifies the ECDSA-P256 (or
  Ed25519 in dev) signature against the pinned public key PEM.
  Exits 0 + structured JSON on success; exits 1 + structured
  failure reason on failure.

- [`scripts/security/verify-audit-chain-all-orgs.ts`](../../scripts/security/verify-audit-chain-all-orgs.ts)
  (`pnpm security:verify-chain-all`) — combined integrity check.
  Per organization, replays the row-level chain via
  [`verifyChain`](../../packages/audit/src/chain/verifier.ts) AND
  re-verifies the most recent Merkle manifest. Use monthly per
  organization (CC7.2 cadence) and as a pre-deploy gate.

### Suggested evidence layout

```
evidence/
  <period>/
    PI1.4/
      merkle-signing-pubkey.pem        # exported from kms:GetPublicKey
      merkle-manifests/
        <org-slug>/
          YYYY-MM-DD/
            manifest.json              # copied from S3
            verify-output.json         # `security:verify-merkle` stdout
      verify-chain-all/
        YYYY-MM-DD.tsv                 # `security:verify-chain-all` table
```

The PEM is **not secret**. Pinning it in the evidence repo lets
auditors run the verifier offline — they never need AWS
credentials to confirm a historical period's integrity.

### Tamper-attempt narrative

Suppose on day N a privileged DB actor edits `audit_log` rows for
`organizationId = X` and re-derives every downstream `entryHash`
to keep the row-level chain self-consistent. The in-database
`verifyChain` walker sees nothing wrong — the chain's own
consistency invariants are intact.

The next night's run produces a fresh Merkle manifest for
**day N+1**'s window. Day N's existing manifest is unchanged in
S3 (Object Lock refuses overwrite). When the auditor runs
`security:verify-merkle` against day N's manifest, the script
re-derives the Merkle root from the live (post-edit) rows and
compares against the signed `rootHashHex`:

- The rows are different from what was signed.
- The Merkle root therefore differs.
- The script exits with `{ valid: false, reason:
"merkle-root-mismatch" }`.

The signed manifest in S3 is the load-bearing evidence here.
Because COMPLIANCE-mode Object Lock makes it impossible to
overwrite or delete the signed manifest before its retention
window expires, the tamper signal is preserved for as long as the
auditor cares to look. The next nightly digest's `merkleFailures`
counter raises the alarm, and the structured
`merkle.run.org_failed` event is the breadcrumb for incident
response.
