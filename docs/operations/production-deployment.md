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

## 2. One-time per account: GitHub Actions OIDC roles

Two workflows authenticate to AWS via GitHub Actions OIDC (NOT
long-lived AWS access keys):

| Workflow                                                             | Role variable                                            | Permissions                                             | When it runs                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| [`terraform-drift.yml`](../../.github/workflows/terraform-drift.yml) | `AWS_DRIFT_ROLE_ARN`                                     | READ-ONLY — `Describe*` / `Get*` / `List*` only         | Daily schedule + `workflow_dispatch`                  |
| [`terraform-apply.yml`](../../.github/workflows/terraform-apply.yml) | `AWS_APPLY_ROLE_ARN_STAGING` / `AWS_APPLY_ROLE_ARN_PROD` | WRITE — the IAM the modules need (creates/updates/etc.) | `workflow_dispatch` only, gated by GitHub Environment |

The two roles MUST be separate. The drift role runs unattended every
day; keeping it read-only means a hypothetical token compromise
cannot mutate AWS. The apply role is more powerful but only assumable
inside the gated `terraform-apply-<env-region>` GitHub Environment,
which requires a human reviewer to click Approve.

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

### 2.2 Register the drift role with the repo

| Where               | Name                 | Value        | Why                                                                                                                                         |
| ------------------- | -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository variable | `AWS_DRIFT_ROLE_ARN` | The role ARN | Consumed by `terraform-drift.yml`. Stored as a **variable**, not a secret, because the ARN itself is not sensitive (it's not a credential). |

The drift workflow gracefully no-ops when this variable is unset, so
forks and pre-bootstrap repos do not see false failures.

### 2.3 Create the terraform-apply OIDC role

The apply role is a SEPARATE role from the drift role — broader
permissions, scoped trust. Provision once per AWS account that the
apply workflow targets (typically two: one for the staging account,
one for the production account; production may host multiple regions
under the same account).

**Preferred path — the Terraform module.** The role's trust policy and
permissions live in version control as
[`infra/terraform/modules/iam-github-oidc-apply/`](../../infra/terraform/modules/iam-github-oidc-apply/main.tf).
Enable it in the account's primary working directory via
`terraform.tfvars` (see the `tfapply_*` block in
`environments/prod/us-east-1/terraform.tfvars.example` and
`environments/staging/us-east-1/terraform.tfvars.example`), apply, then
read `terraform output terraform_apply_role_arn`. The module:

- Builds the trust policy with **exact-match** (`StringEquals`)
  subject claims, one per gated `terraform-apply-<env-region>` GitHub
  Environment — tighter than the `StringLike` the manual procedure
  below shows.
- Attaches `PowerUserAccess` plus a narrow inline IAM supplement
  (read-only `iam:Get*/List*` everywhere; IAM writes only on
  `pharmax-<env>-<region>-*` names; `iam:PassRole` only for stack
  roles and only to AWS services; service-linked-role creation).
- Re-uses the account's GitHub OIDC provider from the `cicd-deploy`
  module automatically when both are enabled in the same working
  directory (set `tfapply_create_oidc_provider = true` in accounts
  without it, e.g. staging).

Because the role must exist BEFORE the first CI apply, enable the
module during the operator-driven first apply (§ 3) — the
chicken-and-egg resolves itself in one pass.

**Manual fallback (first-bootstrap or break-glass).** The CLI
procedure below produces the same role shape out-of-band:

1. Create the role with a trust policy that restricts the OIDC
   subject claim to the gated GitHub Environment:

   ```bash
   aws iam create-role \
     --role-name pharmax-gh-actions-apply-prod \
     --assume-role-policy-document file://trust-policy-apply-prod.json
   ```

   `trust-policy-apply-prod.json` example:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": [
               "repo:<org>/<repo>:environment:terraform-apply-prod-ue1",
               "repo:<org>/<repo>:environment:terraform-apply-prod-uw2"
             ]
           }
         }
       }
     ]
   }
   ```

   The `environment:` restriction is load-bearing — the role can
   ONLY be assumed by a job running inside the gated GitHub
   Environment, which requires reviewer approval. This is
   defense-in-depth on top of the workflow-level gate.

2. Attach a permissions policy that covers every action the
   Terraform modules need. The pragmatic shortcut is the AWS-managed
   `arn:aws:iam::aws:policy/PowerUserAccess` plus a narrow inline
   policy for IAM (`PowerUserAccess` excludes IAM by design). For a
   tighter scope, use the per-service `Full*` policies for ec2, rds,
   s3, kms, ecs, ecr, logs, secretsmanager, elasticloadbalancing,
   wafv2, cloudwatch, sns + a narrow inline IAM policy. Iterate the
   policy by running an apply, capturing AccessDenied errors from
   the apply-output artifact, and granting exactly those actions.

3. Capture the role ARN and set the repository variable:

   | Where               | Name (per account)                                                                        | Value        |
   | ------------------- | ----------------------------------------------------------------------------------------- | ------------ |
   | Repository variable | `AWS_APPLY_ROLE_ARN_STAGING` (staging account) / `AWS_APPLY_ROLE_ARN_PROD` (prod account) | The role ARN |

### 2.4 Create the GitHub Environments

The apply workflow gates each env-region behind a GitHub Environment
(one per env-region). One-time setup per env-region, in **Settings →
Environments → New environment**:

| Environment name              | Required reviewers                       | Deployment branches | Wait timer |
| ----------------------------- | ---------------------------------------- | ------------------- | ---------- |
| `terraform-apply-staging-ue1` | 1 reviewer (any platform team member)    | `main` only         | 0 minutes  |
| `terraform-apply-prod-ue1`    | 2 reviewers (platform + infra CODEOWNER) | `main` only         | 0 minutes  |
| `terraform-apply-prod-uw2`    | 2 reviewers (platform + infra CODEOWNER) | `main` only         | 0 minutes  |

Why these settings:

- **Reviewers (2 for prod).** SOC 2 CC8.1 two-person rule. The
  reviewers see the plan summary and a link to the plan-output
  artifact in the run UI before clicking Approve. Staging is 1
  reviewer because the staging account is a learning environment;
  prod is 2.
- **Branch restriction (main only).** A workflow-dispatch run from a
  feature branch cannot deploy. The PR must land on main first; the
  merged commit is what gets applied. Aligns with the
  `git pull → terraform plan → terraform apply` mental model.
- **Wait timer 0.** Reviewer presence IS the gate. A cooling-off
  timer after Approve adds frustration without adding safety —
  there's no actor between the reviewer and the apply who could
  intervene during the timer window. (A timer would matter if the
  approver and the operator were different humans; here they're the
  same workflow run.)

No environment secrets are needed — the role ARN is a repo variable
(not a secret) per § 2.2 / § 2.3, and the AWS resources the apply
role touches (Secrets Manager values, KMS keys) are read at AWS-API
time using the role's permissions.

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

There are two valid paths, in priority order:

1. **CI apply (preferred)** — dispatch
   [`terraform-apply.yml`](../../.github/workflows/terraform-apply.yml).
   Plan + apply both run in GitHub Actions; the apply step is gated
   behind the `terraform-apply-<env-region>` GitHub Environment
   (two-person rule for prod). This is the path the platform team
   uses by default; see § 4.5.
2. **Operator-driven apply** — the original `terraform plan` +
   `terraform apply` flow from a workstation, retained for
   emergencies and for the first-apply per env-region (when no
   apply-role exists yet). Step-by-step:

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

## 4.5 CI apply (the `terraform-apply` workflow)

The [`terraform-apply.yml`](../../.github/workflows/terraform-apply.yml)
workflow runs `terraform plan` then a gated `terraform apply` against
exactly one env-region per dispatch. It closes the `tf1-applyflow`
follow-up that was previously listed under [Open follow-ups](#8-open-follow-ups).

### How to dispatch

1. Confirm pre-conditions:
   - `terraform-ci` is green on `main`.
   - `terraform-drift` is green on the target env-region (no open
     drift issue).
   - You have an _expected_ "N to add, N to change, N to destroy"
     summary from a local `terraform plan` against the same commit.
     If you don't — run `make plan-prod-ue1` locally first. The
     workflow REFUSES to proceed past plan if your prediction
     doesn't match the actual plan summary (catches "I thought my
     PR was tiny but drift snuck a 47-resource delta in").
2. In GitHub, open **Actions → terraform-apply → Run workflow**.
3. Fill the inputs:
   - **env_region** (choice) — exactly one of `staging-ue1`,
     `prod-ue1`, `prod-uw2`.
   - **reason** (string, ≥10 chars) — the justification stamped
     into the apply record (e.g. _"Add CloudWatch alarm threshold
     for fill-stage SLA per ADR-0021"_).
   - **expected_changes** (string) — paste your local plan summary
     line, e.g. _"1 to add, 0 to change, 0 to destroy"_.
4. Click **Run workflow**.

### What happens next

| Phase                  | Where it runs                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`            | Ungated                                           | Validates `reason` length, `expected_changes` shape, env-region maps to an existing working dir.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plan`                 | Ungated (assumes apply role via OIDC)             | Runs `terraform plan -out=tfplan -detailed-exitcode`. Fails the workflow if the plan is a no-op (nothing to apply), if the plan summary doesn't match `expected_changes`, OR if the plan wants to destroy a protected resource type (`aws_kms_key`, `aws_rds_cluster*`, `aws_s3_bucket`, `aws_iam_role*`, `aws_dynamodb_table`). Uploads `tfplan` (7-day retention) + `plan-output.txt` (90-day retention, SOC 2 evidence) as artifacts. Posts the plan summary + last 100 lines to the workflow run summary. |
| **APPROVAL GATE**      | GitHub Environment `terraform-apply-<env-region>` | Reviewer(s) see the plan summary in the run UI; they read the plan-output artifact, click Approve, OR Reject + leave a comment. Two reviewers required for `prod-*`.                                                                                                                                                                                                                                                                                                                                          |
| `apply`                | Gated (assumes apply role via OIDC)               | Downloads the `tfplan` artifact, runs `terraform apply tfplan` (NEVER a re-plan; the saved plan is what was reviewed). Uploads `apply-output.txt` (90-day retention). Posts apply summary including reason, operator, and apply tail to the workflow run summary.                                                                                                                                                                                                                                             |
| `terraform-apply-pass` | Aggregator                                        | Single status check downstream tooling can require.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Hard interlocks

The workflow REFUSES to apply if any of these is true:

- The dispatch came from a non-`main` branch (GitHub Environment
  branch restriction).
- Fewer than the configured number of reviewers Approve.
- The plan diff is zero (no-op apply — wastes reviewer attention).
- The plan summary doesn't match `expected_changes` (a stale plan
  or drift-introduced delta).
- The plan wants to destroy a protected resource type. To
  intentionally destroy one, revise the PR with a `removed { ... }`
  block + explicit ratification in the commit message, re-merge,
  then re-dispatch.
- Two apply runs target the same env-region simultaneously
  (concurrency group serialises them).

### SOC 2 evidence after each apply

Each successful apply produces:

- A GitHub deployment record in the `terraform-apply-<env-region>`
  environment (who dispatched, who approved, when).
- A `plan-output-<env-region>-<run-id>` artifact (90-day retention).
- An `apply-output-<env-region>-<run-id>` artifact (90-day
  retention).
- A workflow run summary with the dispatch reason, the plan/apply
  tails, and the apply exit code.

This four-tuple IS the auditor-facing CC8.1 evidence for the
specific apply. The quarterly evidence pack
([`docs/compliance/evidence-collection-guide.md`](../compliance/evidence-collection-guide.md))
snapshots the deployment record list for the period.

### Pre-merge invariants

`scripts/check-terraform-apply-workflow.ts` (wired into the
[`safety-linters` CI job](../../.github/workflows/ci.yml)) asserts
the workflow's structural invariants on every PR that touches it:
dispatch-only trigger, env-region enum matches the on-disk
directories, plan precedes apply, apply uses the saved plan
(positional `tfplan` argument, no `-auto-approve`), apply job has
`environment:` (the approval gate), concurrency keyed on env-region,
permissions narrow to `id-token:write + contents:read`.

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
3. **Re-run** `make plan-prod-ue1` to confirm clean. Close the issue.

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

- ~~**Production `terraform-apply` workflow** (`tf1-applyflow`):
  approval-gated `workflow_dispatch` workflow that runs `terraform
apply` via OIDC, posts a comment to a deploy ticket, and only
  proceeds after a GitHub Environment approval.~~ **Shipped** as
  [`terraform-apply.yml`](../../.github/workflows/terraform-apply.yml).
  See § 4.5 for the dispatch procedure.
- **Cross-region RDS read replica** for true RPO < 1h instead of
  "most recent cross-region snapshot." Tracked under DR posture
  refinement; today's "warm standby" is documented as such.
- ~~**CI drift check between `docs/security/kms-key-inventory.md` and
  `infra/terraform/modules/kms/main.tf`** (`kms3`)~~ — **Shipped** as
  `scripts/check-kms-inventory.ts` (closed previously).
- ~~**Apply-role provisioned by Terraform.**~~ **Shipped** as
  [`infra/terraform/modules/iam-github-oidc-apply/`](../../infra/terraform/modules/iam-github-oidc-apply/main.tf)
  — see § 2.3. The chicken-and-egg resolves by enabling the module
  during the operator-driven first apply; the manual CLI procedure
  remains documented as the break-glass fallback.

---

## 9. Compliance crosswalk

This runbook contributes to the following SOC 2 controls:

| Control | What this runbook provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC6.1   | Per-deploy plan review + IAM read/write split for OIDC roles documented in § 2. The apply role (§ 2.3) is trust-scoped to the gated GH Environment subject claim, so even a stolen OIDC token can't bypass the approval.                                                                                                                                                                                                                                                                                      |
| CC6.6   | First-apply checklist confirms ACM cert is ISSUED before the ALB module ships, which is the source of the HTTPS-only listener.                                                                                                                                                                                                                                                                                                                                                                                |
| CC7.2   | Daily `terraform-drift` workflow (§ 5) is the operating evidence that infrastructure-level anomalies surface within 24h.                                                                                                                                                                                                                                                                                                                                                                                      |
| CC8.1   | Two-person plan review enforced either by the operator-driven path (§ 3) OR by the CI apply workflow's GitHub Environment required-reviewers gate (§ 4.5). Branch-protected `infra/terraform/**` PRs (§ 4) + drift-ratification path (§ 5) + pre-merge `check:terraform-apply-workflow` linter constitute the CC8.1 "authorized, reviewed, tested change" evidence at the infrastructure tier. Each CI apply emits a four-artefact evidence pack (deployment record, plan-output, apply-output, run summary). |
| C1.2    | Rollback procedure (§ 6) documents the limits of rollback for KMS / audit-archive / RDS — i.e. exactly when crypto-shred and Object Lock are operating as designed.                                                                                                                                                                                                                                                                                                                                           |

The fuller SOC 2 mapping is in
[`docs/soc2/code-evidence-map.md`](../soc2/code-evidence-map.md).
