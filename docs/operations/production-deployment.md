# Production deployment

**Audience:** the engineer or operator running the first (or next) Terraform
apply against the production AWS account. Also: the SOC 2 auditor walking the
"how does change land in prod" path.

**Scope:** how to turn the Terraform tree under `infra/terraform/` from
"could be deployed" into "is deployed," safely, with the right CI / drift
detection / sign-off in place.

This runbook is the single source of truth for the deployment path. Other
docs that touch the same surface defer here:

- [`infra/terraform/README.md`](../../infra/terraform/README.md) — the
  per-directory mechanics + module index.
- [`infra/terraform/bootstrap/README.md`](../../infra/terraform/bootstrap/README.md) —
  the one-shot state-bucket + DynamoDB-lock-table provisioner.
- [`docs/RUNBOOK.md`](../RUNBOOK.md) — operational runbook for things
  that go wrong _after_ deploy (KMS rotation, restore, failover, etc.).
- [`docs/operations/restore-drill.md`](./restore-drill.md) — the quarterly
  restore drill that proves the deployed RDS can actually be recovered.

> **Never click in the AWS console for resources Terraform owns.** Every
> change goes through this directory. Console drift on critical resources
> (KMS, IAM, RDS, S3, VPC) is a SOC 2 CC8.1 finding. The daily
> `terraform-drift` GitHub workflow ([`.github/workflows/terraform-drift.yml`](../../.github/workflows/terraform-drift.yml))
> catches drift within 24 hours of introduction.

---

## 0. Prerequisites

Before the first `terraform apply` against a new env-region:

- [ ] AWS account exists and you have admin access in it (typically via
      AWS SSO). A NEW account is preferred over re-using an existing one;
      account-level isolation is the strongest blast-radius boundary.
- [ ] AWS CLI v2 installed locally; `aws sts get-caller-identity` returns
      the right account.
- [ ] Terraform `>= 1.6` installed locally (currently pinned at
      `1.9.8` in the GitHub workflows — match locally to avoid plan
      churn).
- [ ] `tflint >= 0.50` installed locally with the AWS plugin.
- [ ] The ACM certificate for `app.pharmax.example.com` (or your domain)
      is `ISSUED` in the target region. The ALB module looks it up by
      data source; no cert = apply fails fast.
- [ ] An SNS topic for alarms exists, or you've accepted that alarms
      will record state but not page. Topic ARN goes in `terraform.tfvars`.
- [ ] You've read this entire document.

---

## 1. One-time per (account, env, region): bootstrap

Terraform cannot create the bucket it stores its state in. The
chicken-and-egg is solved by the bootstrap module:

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars        # set environment, region, account_suffix

terraform init                  # NO remote backend yet — local state
terraform apply

terraform output                # capture state_bucket_name, lock_table, kms arn
```

The bootstrap module creates:

- The Terraform state S3 bucket (`pharmax-tfstate-<env>-<region-suffix>`)
  with GOVERNANCE-mode Object Lock, KMS-SSE, versioning, public-access
  blocked.
- The DynamoDB lock table.
- A dedicated CMK for state encryption (separate from application CMKs
  to keep the IAM blast radius tight).

Capture the three outputs. They go into the env-region's
`backend.tf` (see `backend.tf.example` for the template).

> **GOVERNANCE vs COMPLIANCE Object Lock.** The state bucket uses
> GOVERNANCE mode because state files may need a controlled rollback
> during a recovery event; COMPLIANCE would make that impossible. The
> audit-archive bucket — which IS auditor evidence — uses COMPLIANCE.

The bootstrap state file ITSELF lives locally on the operator's
machine in `infra/terraform/bootstrap/terraform.tfstate`. It is small
(a handful of resources) and is only needed if you ever want to
destroy or modify the state-backing resources. Store it somewhere
durable (encrypted backup, password manager attachment, etc.).
**Do not commit it.**

---

## 2. One-time per account: GitHub Actions OIDC role

The `terraform-drift` workflow needs to read AWS resources to detect
drift. The future `terraform-apply` workflow (queued, not yet shipped —
see [Open follow-ups](#open-follow-ups)) will need to modify them. Both
authenticate via GitHub OIDC, NOT long-lived AWS access keys.

### 2.1 Configure the OIDC trust relationship

In each AWS account that GitHub Actions needs to touch:

1. Create the OIDC identity provider for GitHub (one-time, per account):

   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com \
     --thumbprint-list <github-cert-thumbprint>
   ```

   The thumbprint changes when GitHub rotates their cert; AWS now
   accepts ANY thumbprint when the identity provider URL is
   `token.actions.githubusercontent.com`, so this is largely
   cosmetic. Keep the value documented in the runbook for change
   tracking.

2. Create the drift-detection role:

   ```bash
   aws iam create-role \
     --role-name pharmax-gh-actions-drift \
     --assume-role-policy-document file://trust-policy-drift.json
   ```

   `trust-policy-drift.json` should restrict the trust to:
   - The OIDC provider for `token.actions.githubusercontent.com`.
   - The repository (`repo:<org>/<repo>:*`).
   - Optionally also a specific environment (`environment:production`)
     if the workflow uses GitHub Environments.

3. Attach a READ-ONLY policy that scopes the role to the actions the
   `terraform plan` operation needs:
   - `iam:Get*`, `iam:List*`
   - `kms:DescribeKey`, `kms:ListAliases`, `kms:GetKeyPolicy`,
     `kms:GetKeyRotationStatus`, `kms:ListResourceTags`
   - `ec2:Describe*`
   - `rds:Describe*`, `rds:ListTagsForResource`
   - `s3:GetBucket*`, `s3:ListBucket`, `s3:GetObjectLockConfiguration`
   - `logs:Describe*`
   - `ecs:Describe*`, `ecs:ListServices`, `ecs:ListTaskDefinitions`
   - `ecr:Describe*`
   - `secretsmanager:DescribeSecret`, `secretsmanager:ListSecrets`,
     `secretsmanager:GetResourcePolicy`,
     `secretsmanager:ListSecretVersionIds`
   - `elasticloadbalancing:Describe*`
   - `wafv2:Get*`, `wafv2:List*`
   - `cloudwatch:Describe*`, `cloudwatch:Get*`, `cloudwatch:List*`

   **NO** `Create*` / `Update*` / `Put*` / `Delete*` / `Tag*` actions.
   This role is read-only. A future apply role will be separate, with
   write permissions, and will require an additional approval step
   (GitHub Environment with required reviewers).

4. Capture the role ARN.

### 2.2 Register the role with the repo

Two values go into the GitHub repository:

| Where               | Name                 | Value        | Why                                                                                                                                         |
| ------------------- | -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository variable | `AWS_DRIFT_ROLE_ARN` | The role ARN | Consumed by `terraform-drift.yml`. Stored as a **variable**, not a secret, because the ARN itself is not sensitive (it's not a credential). |

The drift workflow gracefully no-ops when this variable is unset, so
forks and pre-bootstrap repos do not see false failures.

---

## 3. First apply against an env-region

Once the bootstrap + OIDC setup is complete:

```bash
cd infra/terraform/environments/prod/us-east-1

# One-time per env-region: link the backend.
cp backend.tf.example backend.tf
$EDITOR backend.tf              # paste bootstrap outputs

# One-time per operator: link the tfvars.
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars        # tune sizing, certs, alarm SNS

terraform init                  # connects to the remote state
make -C ../../.. ci             # fmt-check + validate + lint

terraform plan -var-file=terraform.tfvars -out=tfplan
# Review the plan with at least one other engineer.

terraform apply tfplan
```

> **Plan review is the load-bearing CC8.1 step.** A 2-person review of
> the `terraform plan` output, with the plan output captured (paste
> into the deploy ticket, or attach as an artifact), is the SOC 2
> evidence that the change was reviewed. The plan output is the
> ground truth — what `apply` will do. Reviewer should:
>
> - Confirm the resource count matches expectation.
> - Spot-check every `destroy` (a destroy on RDS, audit-archive, KMS
>   should NEVER appear in a normal apply — `prevent_destroy` and
>   `deletion_protection` exist exactly to make the plan loud here).
> - Confirm no unexpected resources outside the expected modules.

After apply, populate the empty secrets (see the snippet in
`infra/terraform/README.md` § "Verification before apply"), then deploy
container images to ECR and bounce the ECS services so they pick up
the freshly-populated secrets.

---

## 4. Routine applies after the first one

```bash
cd infra/terraform/environments/prod/us-east-1

git pull                              # pick up the merged HCL change
terraform plan -var-file=terraform.tfvars -out=tfplan
# Review.

terraform apply tfplan
```

Plans should be small (a handful of resource changes per PR). If a
plan wants to change >10 resources, treat it as a code-review smell —
either the PR did too much, or drift has accumulated.

The CI workflow [`terraform-ci.yml`](../../.github/workflows/terraform-ci.yml)
gates every PR that touches `infra/terraform/**` with `fmt-check +
validate + tflint`. A red CI is grounds to NOT apply — the HCL itself
is broken before AWS even sees it.

---

## 5. Handling drift

The daily [`terraform-drift.yml`](../../.github/workflows/terraform-drift.yml)
workflow runs `terraform plan -detailed-exitcode -lock=false` against
every production env-region. Exit code 2 = drift; the workflow opens
(or appends to) a GitHub issue tagged `infra/drift` with the plan
tail.

When you receive a drift alert:

1. **Read the full plan artifact**, not just the issue body. The body
   is truncated to the last 200 lines.
2. **For each drifted resource**, decide one of:
   - **Console change should be reverted.** Open a PR that does
     nothing (or that re-asserts the desired state explicitly), then
     `terraform apply` to restore the world to match HCL.
   - **Console change should be ratified.** Open a PR updating HCL to
     match the world. This is the CC8.1-compliant path — the change
     ends up in version control, gets reviewed, and lands in main.
3. **Re-run** `make plan-prod-use1` to confirm clean. Close the issue.

Common false-positive sources:

- AWS-side automatic updates to managed resources (RDS pending
  maintenance, Inspector findings, GuardDuty findings). These show up
  as state-shape changes; either ignore via `lifecycle.ignore_changes`
  in HCL (with a comment explaining why) or accept them.
- Tag drift from AWS-internal tagging (`aws:cloudformation:*`,
  Cost Explorer). These don't matter operationally; suppress them at
  the module level if they recur.

A clean drift run for >7 days IS the operating evidence the auditor
wants for "infrastructure changes are reviewed." Capture the run
history quarterly per [`docs/compliance/evidence-collection-guide.md`](../compliance/evidence-collection-guide.md).

---

## 6. Rollback

For Terraform-managed resources, "rollback" is "apply the previous
HCL." Concretely:

```bash
git log --oneline infra/terraform/                # find the commit before the bad change
git checkout <good-sha> -- infra/terraform/
cd infra/terraform/environments/prod/us-east-1
terraform plan -var-file=terraform.tfvars -out=tfplan
# Reviewer confirms the plan is the inverse of the bad apply.
terraform apply tfplan
```

Then revert the bad PR via the usual PR-revert workflow so main and
the live world reconcile.

**Resources that cannot be rolled back via Terraform:**

- **RDS data.** A bad migration is rolled back by restoring from a
  snapshot — see [`docs/operations/restore-drill.md`](./restore-drill.md).
- **S3 audit-archive bucket contents.** Object Lock COMPLIANCE
  prevents deletion of audit manifests within retention. Wrong
  manifests stay; corrections are appended.
- **KMS key destruction.** A scheduled key deletion has a minimum
  7-day waiting period. Cancellation is via `aws kms
cancel-key-deletion`; see RUNBOOK § "Rotating the data-encryption key."
- **Secrets Manager rotation.** Rotated secrets keep prior versions
  for the configured `RecoveryWindowInDays`; "rollback" is staging
  the prior version as `AWSCURRENT`.

---

## 7. Pre-deploy checklist (copy into the deploy ticket)

```
## Deploy ticket — <env-region> — <date>

### Pre-flight
- [ ] terraform-ci is green on the commit being deployed
- [ ] terraform-drift is green on the env-region (no open drift issue)
- [ ] `terraform plan` reviewed and attached as an artifact
- [ ] At least 1 reviewer + 1 approver
- [ ] No `destroy` actions in the plan (or, if intentional, explicit
      sign-off captured)
- [ ] Application image tag pinned (no `:latest`)

### Apply
- [ ] `terraform apply tfplan` executed
- [ ] Plan output saved to the ticket
- [ ] Smoke test against ALB succeeded (HTTP 200 on `/health`)
- [ ] CloudWatch shows no new alarms in the 15 minutes post-apply

### Post-deploy
- [ ] On-call notified
- [ ] If secrets rotated: confirm dependent services bounced
- [ ] Quarterly evidence pack updated (`evidence/deployments/<period>/`)
```

---

## 8. Open follow-ups

These are queued for future slices, not blockers for the first
deployment:

- **Production `terraform-apply` workflow** (`tf1-applyflow`):
  approval-gated `workflow_dispatch` workflow that runs `terraform
apply` via OIDC, posts a comment to a deploy ticket, and only
  proceeds after a GitHub Environment approval. Today, apply is
  operator-driven from a local workstation, which is operationally
  fine for the first few deploys but should move to CI before the
  team grows past two.
- **Cross-region RDS read replica** for true RPO < 1h instead of
  "most recent cross-region snapshot." Tracked under DR posture
  refinement; today's "warm standby" is documented as such.
- **CI drift check between `docs/security/kms-key-inventory.md` and
  `infra/terraform/modules/kms/main.tf`** (`kms3`): a static check
  that fails the PR if the inventory document falls out of sync with
  the Terraform module.

---

## 9. Compliance crosswalk

This runbook contributes to the following SOC 2 controls:

| Control | What this runbook provides                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC6.1   | Per-deploy plan review + IAM read/write split for OIDC roles documented in § 2.                                                                                                                                |
| CC6.6   | First-apply checklist confirms ACM cert is ISSUED before the ALB module ships, which is the source of the HTTPS-only listener.                                                                                 |
| CC7.2   | Daily `terraform-drift` workflow (§ 5) is the operating evidence that infrastructure-level anomalies surface within 24h.                                                                                       |
| CC8.1   | Two-person plan review (§ 3) + branch-protected `infra/terraform/**` PRs (§ 4) + drift-ratification path (§ 5) constitute the CC8.1 "authorized, reviewed, tested change" evidence at the infrastructure tier. |
| C1.2    | Rollback procedure (§ 6) documents the limits of rollback for KMS / audit-archive / RDS — i.e. exactly when crypto-shred and Object Lock are operating as designed.                                            |

The fuller SOC 2 mapping is in
[`docs/soc2/code-evidence-map.md`](../soc2/code-evidence-map.md).
