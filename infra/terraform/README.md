# Pharmax — Terraform infrastructure

This directory provisions the AWS footprint for Pharmax in a HIPAA-aware,
SOC 2-ready shape. One stack per (environment, region) tuple; each stack
is a single Terraform working directory under `environments/<env>/<region>/`
that instantiates the shared composition at the root of this directory.

```
infra/terraform/
├── README.md                ← this file
├── Makefile                 ← fmt / validate / lint / plan-* shortcuts
├── .tflint.hcl              ← tflint config (recursive, AWS plugin)
├── main.tf                  ← root composition: wires every module
├── variables.tf, outputs.tf ← root variable + output surface
├── locals.tf                ← name + tag derivation
├── versions.tf              ← required_version + required_providers
├── backend.tf.example       ← template (per-env-region dirs use their own)
├── policies/                ← raw IAM / S3 / param-group policy snippets
├── bootstrap/               ← one-shot: state bucket + DynamoDB + KMS
├── modules/
│   ├── alb/                 ← public ALB, HTTPS listener, target group
│   ├── cloudwatch/          ← alarms + overview dashboard
│   ├── ecr/                 ← three repos (web / worker / print-agent)
│   ├── ecs/                 ← Fargate cluster + three services
│   ├── iam/                 ← per-service task roles, least-privilege
│   ├── kms/                 ← eight CMKs (rds / docs / audit-archive /
│   │                          secrets / data / search / asymm-sign / logs)
│   ├── network/             ← VPC + 3 subnet tiers + NAT + flow logs
│   ├── rds/                 ← Postgres 16 Multi-AZ, encrypted, isolated
│   ├── s3-audit-archive/    ← Object-Lock COMPLIANCE Merkle archive
│   ├── s3-documents/        ← versioned, KMS-encrypted documents bucket
│   ├── secrets/             ← Secrets Manager entries + rotation hooks
│   └── waf/                 ← WAFv2 + managed rule groups + rate limit
└── environments/
    ├── README.md
    ├── dev/us-east-1/
    ├── staging/us-east-1/
    ├── prod/us-east-1/      ← primary
    └── prod/us-west-2/      ← DR (warm standby)
```

The stack is composed once and parameterized; a new region is provisioned
by copying one `environments/<env>/<region>/` directory and editing two
values (`region` in `provider.tf` and the `terraform.tfvars`).

---

## Prerequisites

1. **Terraform `>= 1.6`.** Pinned in every `versions.tf`.
2. **AWS provider `~> 5.0`.** Pinned. Updates are deliberate, never automatic.
3. **AWS CLI v2.** Used by the bootstrap recipe and by drift-detection cron.
4. **`tflint`** (`~> 0.50`) with the AWS plugin (`~> 0.32`).
5. **An ACM certificate already issued** for the domain referenced in
   `acm_certificate_domain` per env-region — the ALB module looks it up
   via data source.
6. **An SNS topic** for alarm notifications (optional; alarms still
   record state when the topic ARN is empty).

---

## First-time bootstrap

Terraform cannot create the bucket it stores its state in. The
chicken-and-egg is solved by `infra/terraform/bootstrap/` — a separate,
one-shot Terraform module that creates the state bucket, DynamoDB lock
table, and state-encryption CMK.

Run **once per (account, env, region)** tuple:

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars        # set environment + region + account_suffix
terraform init                  # NO remote backend — local state
terraform apply
terraform output                # capture state_bucket_name + lock_table + kms arn
```

Then plug those values into the matching `environments/<env>/<region>/backend.tf`
(copy from `backend.tf.example`). See [`bootstrap/README.md`](./bootstrap/README.md)
for full detail.

The bootstrap state bucket has **GOVERNANCE-mode** Object Lock (not
COMPLIANCE) because state files may need a controlled rollback during a
recovery event; COMPLIANCE would make that impossible. The audit-archive
bucket — which IS auditor evidence — uses COMPLIANCE.

---

## Per-environment provisioning workflow

```bash
# Choose your env-region.
cd infra/terraform/environments/dev/us-east-1

# One-time per env-region: link the backend.
cp backend.tf.example backend.tf
$EDITOR backend.tf              # paste bootstrap outputs

# One-time per developer: link the tfvars.
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars        # tune sizing, certs, alarm SNS

# Initialize. After the first init you don't need to repeat this
# unless module sources change.
terraform init

# Format + validate before every PR.
make -C ../../.. fmt-check
make -C ../../.. validate

# Plan.
terraform plan -var-file=terraform.tfvars -out=tfplan

# Apply (after review).
terraform apply tfplan
```

For the full first-time-deployment procedure — bootstrap, OIDC role
setup, plan review, post-apply secrets backfill, rollback — see
[`docs/operations/production-deployment.md`](../../docs/operations/production-deployment.md).

Two GitHub workflows automate the parts that can be automated:

- [`.github/workflows/terraform-ci.yml`](../../.github/workflows/terraform-ci.yml)
  — runs `fmt-check + validate + tflint` (the three no-credential
  gates) on every PR that touches `infra/terraform/**`. The
  `terraform-ci-pass` aggregator is the required status check that
  branch protection rules point at.
- [`.github/workflows/terraform-drift.yml`](../../.github/workflows/terraform-drift.yml)
  — daily scheduled `terraform plan -detailed-exitcode -lock=false`
  against each production env-region via GitHub OIDC. Exit code 2
  (drift) opens a `infra/drift`-labeled GitHub issue with the plan
  tail. The workflow gracefully no-ops when the `AWS_DRIFT_ROLE_ARN`
  repository variable is unset (forks, pre-bootstrap repos).

Production `terraform apply` is deliberately operator-driven (run
locally with the captured plan + 2-person review) rather than
auto-applied from CI. This is the SOC 2 CC8.1 posture documented
in the deployment runbook. An approval-gated `terraform-apply`
workflow is queued (`tf1-applyflow`) for when the team grows past
two engineers.

The Makefile at `infra/terraform/Makefile` exposes shortcuts for every
env-region:

```bash
make plan-dev-use1
make plan-staging-use1
make plan-prod-use1
make plan-prod-usw2
make ci    # fmt-check + validate + lint, the CI gate
```

---

## Provisioning a new region (e.g. `eu-west-1`)

1. `cp -r environments/prod/us-east-1 environments/prod/eu-west-1`.
2. Edit two values in `terraform.tfvars`:
   - `region = "eu-west-1"`
   - `vpc_cidr = "10.143.0.0/16"` (NON-overlapping with existing CIDRs)
3. Edit `provider.tf` so its default region matches.
4. Edit `acm_certificate_domain` to a cert that exists in the new region.
5. Run the bootstrap module pointed at the new region:
   `cd ../../bootstrap && terraform apply -var environment=prod -var region=eu-west-1 ...`.
6. Plug bootstrap outputs into `environments/prod/eu-west-1/backend.tf`.
7. `terraform init && terraform plan && terraform apply`.

That's the whole list. The composition is region-agnostic.

---

## Drift detection

A nightly job runs `terraform plan -detailed-exitcode -lock=false` and
pages on-call if the exit code is `2` (drift detected). Targets:

```bash
make drift-prod-use1
make drift-prod-usw2
```

The expected hot spots are RDS pending maintenance and CloudWatch
dashboards a human edited in the console — both should be reconciled
by editing this directory, not the AWS console. Console drift on
critical resources (KMS, IAM, S3) is a SOC 2 CC8.1 finding.

---

## Disaster recovery — `us-east-1` → `us-west-2` failover

The DR posture today is **warm standby** with a parallel infrastructure
footprint in `us-west-2`. Capacity is intentionally minimal (1 task each)
to keep cost down; failover scales it up.

### What's automated

| Layer           | Status                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ECR images      | Replicated cross-region via the deploy pipeline (a build pushes both regions concurrently).                                                                                                                                          |
| Secrets Manager | `pharmax-prod-usw2/*` exists in parallel; values are populated by the same out-of-band rotation procedure (the DR rotation runbook covers this).                                                                                     |
| State           | `pharmax-tfstate-prod-usw2` lives in `us-west-2` so a `us-east-1` outage cannot brick our DR Terraform.                                                                                                                              |
| KMS keys        | Independent per-region keys. **Cross-region key access does not work** — envelope-encrypted PHI from `us-east-1` is unreadable from `us-west-2` and vice versa. This is by design (ADR 0022 §3 KMS regionality).                     |
| RDS             | Multi-AZ inside `us-west-2`. Cross-region replicas are NOT configured today — RPO during a true regional failure is "the most recent restorable time of the most recent cross-region snapshot" (which is currently a manual export). |
| ALB / Route53   | Two ALBs, one per region. Failover is a Route53 record swap (manual today; a health-check-driven automatic swap is a planned enhancement).                                                                                           |
| Vendor webhooks | Stripe, EasyPost, Clerk webhooks point at `app.pharmax.example.com` (us-east-1) only. Failover requires updating each vendor dashboard.                                                                                              |

### What's manual

The full failover runbook lives in [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md#disaster-recovery-regional-failover);
the short version:

1. **Decision.** Confirm `us-east-1` is unrecoverable for the SLA window
   (typically `> 60 minutes`). Page the CEO.
2. **DNS.** Swap Route53 A-ALIAS at `app.pharmax.example.com` to the
   `us-west-2` ALB. TTL 60s.
3. **Database.** Restore the most recent cross-region snapshot into the
   `us-west-2` RDS instance (or a fresh sibling) via
   `aws rds restore-db-instance-from-db-snapshot`. Update the
   `database-url` secret in `pharmax-prod-usw2/*` to point at the
   restored endpoint.
4. **Capacity.** Scale ECS desired counts up:
   `aws ecs update-service --cluster pharmax-prod-usw2-cluster --service pharmax-prod-usw2-web --desired-count 5`
   (or run `make plan-prod-usw2` after editing the .tfvars to bake the
   new floor into IaC).
5. **Worker continuity.** The Merkle-root signer and outbox drains in
   `us-west-2` start running against `us-west-2` PHI immediately.
   Cross-region audit unification is a manual reconciliation step
   when `us-east-1` returns; ADR 0022 §4 covers the exception.
6. **Vendor webhooks.** Update Stripe / EasyPost / Clerk dashboards to
   point at the `us-west-2` endpoint. The Stripe rotation procedure in
   `docs/RUNBOOK.md` is the template.
7. **Customer comms.** Per the incident response policy.

### What's blocked until DR-region keys come up

If `us-east-1` is regionally degraded and the failure mode is **KMS in
particular** (rare but real — Dec 2021 was a precedent), the steps that
require a healthy KMS for **either region** are blocked until the
recovery completes:

- Reading existing `us-east-1` PHI envelopes is impossible from any
  region — the per-tenant KEK lives in `us-east-1` KMS.
  Mitigation: serve only newly-created data in `us-west-2` while
  `us-east-1` is offline; reconcile when the KMS key is reachable.
- Signed Merkle manifests for `us-east-1`-pinned tenants cannot be
  produced. The next day's run includes a separate manifest for that
  day's window once `us-east-1` returns.

These are documented in ADR 0022 §3 and in the failover runbook.

---

## Compliance mapping — which Terraform resource implements which control

This is the auditor's primary table. Each row pairs a SOC 2 / HIPAA
control with the Terraform resource that satisfies it.

| Control                                                                   | Implementing resource                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **CC6.1** — Logical access protection                                     | `modules/iam/*` (per-service task roles, no wildcards). `modules/network/*` (private + isolated tiers; no public DB).      |
| **CC6.6** — Transmission encryption                                       | `modules/alb/main.tf` (HTTPS-only listener, TLS-1-3-2021-06). `modules/rds/main.tf` (`rds.force_ssl=1` parameter).         |
| **CC6.7** — Restriction of access                                         | `modules/iam/main.tf` (resource-arn-scoped policies). `modules/secrets/*` (per-secret IAM scoping).                        |
| **CC6.8** — Prevent unauthorized software                                 | `modules/ecr/main.tf` (immutable tags, scan-on-push, lifecycle).                                                           |
| **CC7.1** — Detect vulnerabilities                                        | `modules/ecr/main.tf` (`scan_on_push = true`). `modules/cloudwatch/main.tf` alarms.                                        |
| **CC7.2** — Monitor anomalies                                             | `modules/cloudwatch/main.tf` (RDS / ALB / ECS alarms + audit-chain integrity custom metric). VPC flow logs in `network`.   |
| **CC7.3 / CC7.4** — Evaluate / respond to events                          | The `audit_chain_integrity_failure` alarm in `cloudwatch` + the runbook procedures in `docs/RUNBOOK.md`.                   |
| **CC8.1** — Authorized, reviewed, tested change                           | The whole IaC tree under version control + branch protection (`docs/security/branch-protection.md`).                       |
| **CC9.1** — Risk mitigation                                               | RDS automated backups, Multi-AZ, S3 versioning, audit-archive Object Lock, DR region.                                      |
| **A1.2** — Backup, environmental protections                              | `modules/rds/main.tf` (35-day retention, KMS encryption, performance insights).                                            |
| **A1.3** — Test recovery                                                  | `docs/operations/restore-drill.md` quarterly drill, exercising the IaC end-to-end.                                         |
| **C1.1** — Identify confidential information                              | `local.phi_tags` applied to PHI-bearing resources (RDS, S3 buckets, KMS data + search keys).                               |
| **C1.2** — Dispose of confidential information                            | `modules/kms/main.tf` `aws_kms_key.data` (per-tenant key shred = crypto-shred). S3 audit-archive `prevent_destroy = true`. |
| **PI1.4** — Stores inputs/outputs protected                               | `modules/kms/main.tf` (data + search keys). `modules/s3-audit-archive/main.tf` Object Lock COMPLIANCE 7y.                  |
| **§ 164.308(a)(1)(ii)(D)** — Information system activity review           | VPC flow logs; CloudTrail (account-level); ECS log groups; RDS Postgres logs (DDL only — no PHI).                          |
| **§ 164.308(a)(7)** — Contingency plan                                    | RDS Multi-AZ + 35-day backups + DR region (`environments/prod/us-west-2/`).                                                |
| **§ 164.310(b)** — Workstation / facility                                 | N/A in IaC — AWS-side; covered by AWS BAA.                                                                                 |
| **§ 164.312(a)(1)** — Access control                                      | `modules/iam/main.tf` per-role narrow grants; KMS encryption-context-bound DEK unwrapping.                                 |
| **§ 164.312(a)(2)(iv)** — Encryption + decryption                         | `modules/kms/main.tf` data + search + audit-archive + RDS keys; envelope encryption at the application layer.              |
| **§ 164.312(b)** — Audit controls                                         | `audit_log` table + Merkle archive bucket (`modules/s3-audit-archive`).                                                    |
| **§ 164.312(c)(1)** — Integrity (tamper detection)                        | Daily Merkle root signing (ADR 0024) → `modules/kms/aws_kms_key.asymm_sign` + COMPLIANCE Object Lock bucket.               |
| **§ 164.312(e)(1)** / **(e)(2)(ii)** — Transmission security / encryption | ALB HTTPS-only + RDS TLS-only + AWS-internal TLS over backbone.                                                            |

A more detailed mapping (with implementation status and evidence
location) lives in [`docs/security/control-matrix.md`](../../docs/security/control-matrix.md).

---

## Verification before apply

Before `terraform apply` on a new env-region:

- [ ] `make fmt-check` reports clean.
- [ ] `make validate` succeeds for every working directory.
- [ ] `make lint` reports zero errors.
- [ ] No `.tfvars` (only `.tfvars.example`) is committed. Real
      `.tfvars` files are gitignored.
- [ ] No `backend.tf` (only `backend.tf.example`) is committed.
- [ ] The ACM cert referenced in `acm_certificate_domain` is `ISSUED`
      in the same region as `var.region`.
- [ ] The SNS topic referenced in `alarm_sns_topic_arn` exists, or the
      value is empty.
- [ ] The remote state bucket + DynamoDB table exist (run the bootstrap
      module first).
- [ ] You have read [`docs/operations/restore-drill.md`](../../docs/operations/restore-drill.md)
      and confirmed who will run the next quarterly drill.

After apply, populate the empty secrets:

```bash
aws secretsmanager put-secret-value \
  --secret-id pharmax-prod-use1/clerk-secret-key \
  --secret-string "$CLERK_SECRET_KEY"

aws secretsmanager put-secret-value \
  --secret-id pharmax-prod-use1/clerk-webhook-secret \
  --secret-string "$CLERK_WEBHOOK_SECRET"

# … repeat for stripe-secret-key, stripe-webhook-secret, easypost-api-key,
# fedex-client-id/secret, ups-client-id/secret, sentry-dsn, redis-url.
```

…then bounce the ECS services so they re-fetch.

---

## Module index

| Module              | What it owns                                                                                                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network/`          | VPC, public/private/isolated subnets across 2-4 AZs, NAT (single or per-AZ), VPC flow logs encrypted with the logs CMK.                                                                                                                                                                                         |
| `kms/`              | Eight CMKs: `rds`, `documents`, `audit_archive`, `secrets`, `data`, `search`, `asymm_sign`, `logs`. Rotation enabled where supported (asymmetric is application-rotated). Resource policies enumerate principals — no `Principal: *`.                                                                           |
| `rds/`              | Postgres 16 Multi-AZ, encrypted with the rds CMK, in isolated subnets, hardened parameter group (force-ssl, statement-timeout, idle-tx-timeout). `manage_master_user_password = true` so the master password lives in Secrets Manager and Terraform never sees it.                                              |
| `secrets/`          | One Secrets Manager entry per logical credential. Encrypted with the secrets CMK. Optional rotation lambda hooks for Stripe / Clerk / carrier credentials.                                                                                                                                                      |
| `ecr/`              | Three repositories (web, worker, print-agent) with immutable tags, scan-on-push, and lifecycle rules.                                                                                                                                                                                                           |
| `alb/`              | Public ALB, HTTPS listener (TLS-1-3-2021-06), HTTP→HTTPS redirect, web target group. Cert via data source.                                                                                                                                                                                                      |
| `waf/`              | Regional WAFv2 Web ACL: CommonRuleSet, KnownBadInputs, AmazonIpReputation, SQLi, rate-based (per-IP, configurable).                                                                                                                                                                                             |
| `iam/`              | Task execution role + per-service task roles (web/worker/print-agent), narrowly scoped: `kms:GenerateDataKey` / `Decrypt` on data CMK; `kms:GenerateMac` on search CMK; worker-only `kms:Sign` on asymm CMK + `kms:GenerateDataKey/Decrypt` on audit-archive CMK; secrets read scoped by ARN; no `Resource: *`. |
| `s3-audit-archive/` | Object-Lock COMPLIANCE bucket, configurable retention (default 7y), SSE-KMS with the dedicated audit-archive CMK, deny-non-TLS, deny-non-KMS, deny-wrong-CMK uploads, lifecycle to Glacier Deep Archive, `prevent_destroy = true`.                                                                              |
| `s3-documents/`     | SSE-KMS document bucket with the documents CMK, versioning enabled, public access blocked, deny-non-TLS, deny-non-KMS, lifecycle to expire noncurrent versions.                                                                                                                                                 |
| `ecs/`              | Fargate cluster + three services (web autoscaling on CPU; worker + print-agent fixed). Secrets injected via `secrets =` block (never plaintext). KMS aliases injected as env vars. KMS-encrypted CloudWatch log groups. Container Insights enabled.                                                             |
| `cloudwatch/`       | Alarms (RDS CPU/storage/connections/replica-lag, ALB 5xx %/p99, ECS CPU/mem/running-count, audit-chain integrity custom metric) + a single overview dashboard.                                                                                                                                                  |

---

## Relationship to application code

### `packages/crypto/` — envelope encryption + blind-index search

`AwsKmsAdapter` (`packages/crypto/src/aws-kms-adapter.ts`) calls KMS three
ways: `kms:GenerateDataKey` + `kms:Decrypt` on the `data` CMK, and
`kms:GenerateMac` on the `search` CMK. Both keys are exported by this
stack:

| env var                 | source (this stack output) | notes                                                                               |
| ----------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `AWS_REGION`            | injected by ECS task def   | The crypto package uses it for SigV4.                                               |
| `AWS_KMS_DATA_KEY_ID`   | `kms_data_key_alias`       | Set to the **alias**, not the bare id.                                              |
| `AWS_KMS_SEARCH_KEY_ID` | `kms_search_key_alias`     | HMAC_256 GENERATE_VERIFY_MAC key.                                                   |
| `AWS_KMS_APP_KEY_ID`    | `kms_data_key_alias`       | Legacy alias for `AWS_KMS_DATA_KEY_ID`. Kept for back-compat until callers migrate. |

> The aliases are non-sensitive (not credentials), so they live in the
> task definition `environment =` block, NOT in Secrets Manager. KMS key
> rotation updates the key material under the alias without changing the
> alias string — no app re-deploy needed.

The IAM scoping is in `modules/iam/main.tf` — task roles hold
`kms:GenerateDataKey` + `kms:Decrypt` on `var.data_key_arn` only;
`kms:GenerateMac` on `var.search_key_arn` only.

### `packages/security/merkle/` — daily Merkle-root signing

The worker writes signed manifests to the audit-archive bucket using
the asymmetric signing CMK. Wiring:

| env var                     | source                         | notes                                           |
| --------------------------- | ------------------------------ | ----------------------------------------------- |
| `AWS_KMS_AUDIT_SIGN_KEY_ID` | `kms_asymm_sign_key_alias`     | `kms:Sign` only — never `kms:Verify`/`Decrypt`. |
| `AUDIT_ARCHIVE_BUCKET`      | `s3_audit_archive_bucket_name` | Object-Lock COMPLIANCE bucket name.             |
| `AUDIT_ARCHIVE_KMS_KEY_ID`  | `kms_audit_archive_key_alias`  | SSE-KMS roundtrip on Merkle-manifest writes.    |

### `apps/web`, `apps/worker`, `apps/print-agent`

Each service runs as its own ECS service. The env-var schemas live in:

- [`apps/web/src/server/env.ts`](../../apps/web/src/server/env.ts)
- [`apps/worker/src/env.ts`](../../apps/worker/src/env.ts)
- [`apps/print-agent/src/env.ts`](../../apps/print-agent/src/env.ts)

Every secret-typed key has a matching entry in the `secrets/` module.
ECS task definitions in `modules/ecs/main.tf` inject them by ARN via
the `secrets =` block — plaintext never appears in
`describe-task-definition`.

---

## Destroying a stack

Production stacks have `deletion_protection = true` on RDS,
`enable_deletion_protection = true` on the ALB, and `prevent_destroy = true`
on the audit-archive bucket. All three are intentional.

To tear down a non-prod stack:

```bash
cd environments/dev/us-east-1
terraform destroy -var-file=terraform.tfvars
```

For prod, treat teardown as an incident-grade operation — disable each
deletion-protection in a focused PR, get sign-off, then destroy. The
audit-archive bucket should **never** be destroyed without a SOC 2
auditor sign-off; even a destroyed bucket cannot be recreated with the
same name, and Object Lock COMPLIANCE retention only expires when the
bucket itself is removed.
