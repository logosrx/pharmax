# Evidence Integrity Findings

Whether Pharmax's compliance evidence is durable and tamper-evident,
verified against the code and the Terraform rather than against the
documents that describe them.

Each finding names the file, the resource, and what is missing, so it
can be picked up without repeating the investigation. Findings marked
**INFRA** require a change under `infra/terraform/`, which this branch
deliberately does not touch — that tree is owned by another workstream
this cycle. Findings marked **APP** require a change under `apps/` or
`packages/`, equally out of scope here.

## Summary

| ID     | Finding                                                            | Severity | Owner            | Type  |
| ------ | ------------------------------------------------------------------ | -------- | ---------------- | ----- |
| `EI-1` | Access-review evidence packs are written to ephemeral task storage | High     | Engineering Lead | APP   |
| `EI-2` | Audit-archive bucket policy is missing its Object-Lock-mode deny   | Medium   | Engineering Lead | INFRA |
| `EI-3` | Every production CloudWatch alarm notifies nobody                  | High     | Engineering Lead | INFRA |
| `EI-4` | No durable security-incident record exists                         | Medium   | Security Officer | APP   |
| `EI-5` | The DR region has no Terraform variable file                       | Medium   | Engineering Lead | INFRA |
| `EI-6` | `clerk_webhook_event` is an orphaned evidence table                | Low      | Engineering Lead | APP   |

## What is already correct

Stated first, because the interesting part of an integrity review is
usually what holds up.

- **The Object Lock bucket is real, and it is COMPLIANCE mode.**
  `infra/terraform/modules/s3-audit-archive/main.tf:36` creates the
  bucket with `object_lock_enabled = true`; line 60 configures
  `default_retention { mode = "COMPLIANCE" }` with
  `var.retention_years`, and `infra/terraform/variables.tf:427` refuses
  any value below 6 years. Versioning (line 52), SSE-KMS against a
  dedicated CMK (line 73), full public-access block (line 85),
  `BucketOwnerEnforced` ownership (line 94), and
  `prevent_destroy = true` (line 48) are all present. The lifecycle
  rule transitions to Deep Archive and deliberately never expires
  (line 212).
- **It is wired end to end, not just defined.** The module is
  instantiated at `infra/terraform/main.tf:151`, the worker task role
  gets `s3:PutObject` on it at
  `infra/terraform/modules/iam/main.tf:488` plus KMS use at line 440,
  and the bucket name and CMK alias reach the container as
  `AUDIT_ARCHIVE_S3_BUCKET` / `AUDIT_ARCHIVE_S3_KMS_KEY_ID` at
  `infra/terraform/modules/ecs/main.tf:382`.
- **The Merkle lane fails closed rather than degrading silently.**
  `apps/worker/src/security/daily-merkle-root-loop.ts` refuses to boot
  in production when `AUDIT_ARCHIVE_S3_BUCKET` is unset, and refuses
  when the bucket is set but the SSE-KMS key id is not. A
  `S3ObjectLockPublisher` exists at
  `packages/security/src/merkle/publish-merkle-manifest.ts:188` and
  rejects a retention window shorter than its floor.
- **RDS backups are as claimed.** 35-day retention and Multi-AZ in
  production: `infra/terraform/environments/prod/us-east-1/terraform.tfvars:33`
  and `:44`, consumed at `infra/terraform/modules/rds/main.tf:286` and
  `storage_encrypted = true` at line 283.
- **Audit rows cannot be edited by the application.**
  `prisma/migrations/20260522060000_rls_baseline/migration.sql:130`
  revokes `UPDATE, DELETE` on `audit_log` from both `pharmax_app` and
  `pharmax_system`; the same pattern covers `verification_record` at
  `prisma/migrations/20260525000000_phase2_verification_record/migration.sql:168`.

## EI-1 — Access-review evidence packs are written to ephemeral task storage

**Severity: High. Type: APP. Affects CC6.2-2.**

The quarterly access review produces two artifacts — a JSONL principal
dump and a rendered markdown report — at
`apps/worker/src/compliance/access-review-job.ts:261` and `:275`. Both
go through the `EvidencePublisher` port.

`apps/worker/src/compliance/evidence-publisher.ts` declares that port
and ships exactly two implementations: `FilesystemEvidencePublisher`
(line 70) and `RecordingEvidencePublisher` (line 92). Its own header
comment says the production S3 Object Lock adapter is owned by infra
and that "wiring is in `apps/worker/src/main.ts` once both pieces
land". The infra piece landed. The adapter did not.

So `apps/worker/src/main.ts:739` constructs a
`FilesystemEvidencePublisher` unconditionally, including in
production, and the worker emits a warning about it at line 766
(`worker.quarterly_access_review.filesystem_publisher`). On Fargate the
directory it writes to disappears when the task is replaced. The
evidence the auditor will ask for is therefore not merely mutable — it
is not retained at all.

Two mitigating facts, neither of which closes the gap. First,
`RecordAccessReviewSnapshot`
(`packages/security/src/access-review/record-access-review-snapshot.ts`)
does persist a digest-sealed row in Postgres: the report JSONB plus its
SHA-256 over canonical JSON, on a row carrying a NOT NULL FK to
`command_log`. That row is durable and tamper-evident within the
database. Second, it is not immutable in the Object Lock sense, and it
is only created when a human dispatches the command — by design, per
the comment at `apps/worker/src/main.ts:726`.

**The task.** Add an `S3ObjectLockEvidencePublisher` implementing
`EvidencePublisher` in `apps/worker/src/compliance/`, modelled on
`S3ObjectLockPublisher` at
`packages/security/src/merkle/publish-merkle-manifest.ts:188`. Select
it in `apps/worker/src/main.ts:739` when `AUDIT_ARCHIVE_S3_BUCKET` and
`AUDIT_ARCHIVE_S3_KMS_KEY_ID` are both present, and promote the
line-766 warning to a boot refusal in production once it is available.
No Terraform is needed: bucket, CMK, IAM grant, and container
environment all already exist.

## EI-2 — Audit-archive bucket policy is missing its Object-Lock-mode deny

**Severity: Medium. Type: INFRA. Affects CC7.2-2, CC7.2-3, PI1.4-2.**

`infra/terraform/modules/s3-audit-archive/main.tf` documents four DENY
statements in the comment block at lines 107-121:

1. Deny non-TLS.
2. Deny PUT not using SSE-KMS.
3. Deny PUT targeting a CMK other than this bucket's.
4. Deny PUT that bypasses Object-Lock retention metadata.

`data "aws_iam_policy_document" "bucket"` at line 123 implements the
first three — `DenyInsecureTransport` (line 125),
`DenyUnEncryptedObjectUploads` (line 146), `DenyWrongKmsKey` (line 166).
The fourth is not there.

The bucket-level `default_retention` at line 60 covers the ordinary
case: a `PutObject` that specifies no lock headers inherits COMPLIANCE
for `var.retention_years`. It does not cover a caller that specifies
them. S3 lets a `PutObject` supply `x-amz-object-lock-mode` and
`x-amz-object-lock-retain-until-date`, and per-object values override
the bucket default. A principal holding `s3:PutObject` — which the
worker task role does, via
`infra/terraform/modules/iam/main.tf:488` — can therefore write a
manifest under `GOVERNANCE` mode with a retain-until date of tomorrow,
and that object is deletable. The bucket's stated guarantee is
"once-written-cannot-be-overwritten for the auditor's retention
period"; today that holds by convention rather than by policy.

**The task.** Add a fourth statement to
`data "aws_iam_policy_document" "bucket"` in
`infra/terraform/modules/s3-audit-archive/main.tf`, denying
`s3:PutObject` when `s3:object-lock-mode` is anything other than
`COMPLIANCE`, using `StringNotEqualsIfExists` so a header-less PUT
still inherits the default. Consider a companion condition on
`s3:object-lock-remaining-retention-days` with a numeric floor derived
from `var.retention_years`. The comment at line 114 already describes
the intent, so no design decision is outstanding.

## EI-3 — Every production CloudWatch alarm notifies nobody

**Severity: High. Type: INFRA. Affects CC7.1-1, CC7.2-1, A1.1-1.**

`infra/terraform/modules/cloudwatch/main.tf` defines ten metric
alarms, including `${var.name_prefix}-audit-chain-integrity` at line
282 — the alarm that fires when the hash chain breaks.

Line 24 computes their actions:

```
alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
```

and `infra/terraform/environments/prod/us-east-1/terraform.tfvars:72`
sets `alarm_sns_topic_arn = ""`. Every production alarm therefore has
an empty `alarm_actions` and an empty `ok_actions`. The alarms
evaluate, transition state, and are visible in the console; nothing
leaves AWS. An auditor testing CC7.2-1 by asking "show me the
notification for the last alarm transition" gets nothing.

Application-layer detection is unaffected and does still deliver: the
chain verifier loop
(`apps/worker/src/security/audit-chain-verifier-loop.ts`), the nightly
digest (`apps/worker/src/security/nightly-security-digest-loop.ts`),
and Sentry all route through their own channels. The gap is
specifically the CloudWatch lane.

**The task.** Provision an SNS topic with at least one confirmed
subscription and set `alarm_sns_topic_arn` in
`infra/terraform/environments/prod/us-east-1/terraform.tfvars`. Then
add a `validation` block to `variable "alarm_sns_topic_arn"` in
`infra/terraform/variables.tf:383` rejecting the empty string when
`var.environment == "prod"`, so this cannot recur silently.

**Sequencing note.** The `feat/prod-alerting` branch is wiring
production alerting in this exact tree. This finding is very likely
already being fixed there; it is recorded so the control-status change
it justifies has a written basis, not to duplicate the work.

## EI-4 — No durable security-incident record exists

**Severity: Medium. Type: APP. Affects CC7.3-1, CC7.4-1.**

There is no incident artifact in the system. `prisma/schema.prisma`
declares 85 models and none of them represents an incident, a
postmortem, or a breach determination. No code anywhere references such
a type.

What exists instead:

- A policy describing the process:
  `docs/policies/incident-response-policy.md`, its framework stub
  `docs/soc2/policies/incident-response.md`, the operator runbook
  `docs/INCIDENT_RESPONSE.md`, and the playbook
  `docs/soc2/playbooks/incident-response.md`.
- An honest exporter: `scripts/soc2/export-incident-log.ts` announces
  itself as "STUB MODE" at line 4 and states at line 6 that "Pharmax
  does not yet maintain a structured `incident_log` table". It emits a
  banner artifact plus a best-effort proxy CSV of `audit_log` rows
  whose action begins `incident.`, `rbac.breakglass.`, `sod.`, or
  `audit.chain.` (lines 166-171), and explicitly says these are not a
  substitute.

That exporter is the right behaviour and should not be "fixed" by
making it look complete. The finding is that the underlying record does
not exist, so an auditor's incident population is a folder of
gitignored PDFs whose completeness nothing enforces. Nothing in the
system can answer "was every incident recorded?" because nothing in the
system records one.

**The task.** Either add an `incident` model plus a `RecordIncident`
command following the standard command-bus contract, so incidents
become queryable evidence with an audit trail — at which point
`export-incident-log.ts` retires its stub banner as its own header
anticipates at line 20 — or accept the gap explicitly as a
risk-register entry naming the issue tracker as the system of record
and the compensating control that keeps it complete. Do not leave it
implied.

## EI-5 — The DR region has no Terraform variable file

**Severity: Medium. Type: INFRA. Affects A1.3-1.**

`infra/terraform/environments/prod/us-west-2/` contains `main.tf`,
`variables.tf`, `provider.tf`, `outputs.tf`, `versions.tf`, and
`terraform.tfvars.example` — but no `terraform.tfvars`, and no
`backend.tf`. Compare `prod/us-east-1/`, which has both.

The stack cannot be planned or applied as written, so the secondary
region is scaffolding rather than infrastructure. That is consistent
with `docs/soc2/policies/backup-and-recovery.md` §3.5, which already
records full-region failure as out of scope for a single-region
architecture with ADR-0022 as the mitigation. The finding is only that
the directory's presence reads, to someone scanning the tree, like a
provisioned DR region.

**The task.** Either add `backend.tf` and `terraform.tfvars` for
`prod/us-west-2` and record the region in the BCP/DR policy, or add a
`README.md` in that directory stating it is unprovisioned scaffolding
for ADR-0022 and naming the risk-register entry that tracks it.

## EI-6 — `clerk_webhook_event` is an orphaned evidence table

**Severity: Low. Type: APP. Affects CC6.1-1, CC6.5-1.**

ADR-0030 replaced Clerk with the in-house identity engine and is
`Accepted`. The route and handler that wrote this table —
`apps/web/app/api/clerk/webhook/route.ts` and
`apps/web/src/server/auth/clerk-webhook-handlers.ts` — no longer
exist. The model `ClerkWebhookEvent` remains at
`prisma/schema.prisma:2075`, mapped to `clerk_webhook_event`, with no
writer.

The table is still named as an evidence source in
`docs/soc2/evidence-inventory.md`, in the CC6.1-1 / CC6.5-1 /
CC6.6-2 rows of
[`trust-service-criteria-mapping.md`](./trust-service-criteria-mapping.md),
and in [`code-evidence-map.md`](./code-evidence-map.md). Those
document references are corrected on this branch. The schema object and
`scripts/soc2/export-clerk-session-log.ts` are not, because they fall
outside its scope for the schema and would change evidence-pack
behaviour for the script.

**The task.** Decide whether the table is retained as a historical
record — in which case say so in a schema comment and keep the exporter
as a read-only historical artifact — or dropped in a migration and the
exporter deleted along with its reference in
`scripts/soc2/run-quarterly-evidence-pack.ts`. Either is defensible; an
orphan with neither decision recorded is not.
