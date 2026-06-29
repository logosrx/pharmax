# Per-environment, per-region Terraform working directories

Each `environments/<env>/<region>/` subdirectory is its own Terraform
**root module** with its own backend, its own state file, and its own
`terraform.tfvars`. They all instantiate the shared composition at
`../../../` (`infra/terraform/`) which wires every module into a stack.

## Why split per environment AND per region

- **Per environment** (dev / staging / prod): different sizing, different
  approval gates, different alarm thresholds.
- **Per region** (us-east-1 / us-west-2 / future eu-west-1): one stack ==
  one region. The composition assumes a single AWS region for every
  resource (`var.region`). This matches ADR 0022's tenant-pinned-region
  model: when the multi-region trigger fires, a new
  `environments/prod/<new-region>/` directory is added without
  contaminating the existing region's state.
- **Per state file**: a regional KMS outage that takes out the
  `us-east-1` provider should not block a `terraform plan` against
  `us-west-2`. Separate state files keep them independent.

## Directory layout

```
environments/
├── README.md                    ← this file
├── dev/
│   └── us-east-1/
│       ├── main.tf              ← `module "stack" { source = "../../../" ... }`
│       ├── variables.tf         ← passes through every var the stack needs
│       ├── provider.tf          ← provider "aws" { region = ... }
│       ├── versions.tf          ← required_version + required_providers
│       ├── backend.tf.example   ← S3+DynamoDB backend, copy to backend.tf
│       ├── terraform.tfvars.example ← env-specific values, copy to .tfvars
│       └── outputs.tf           ← re-exposes the stack module's outputs
├── staging/
│   └── us-east-1/...
└── prod/
    ├── us-east-1/...            ← primary region
    └── us-west-2/...            ← DR region
```

## How to provision a new env-region tuple

1. **Bootstrap the backend.** A separate, one-time Terraform root in
   `infra/terraform/bootstrap/` creates the state bucket + DynamoDB
   lock table + state-encryption CMK. Run that ONCE per AWS account
   with `terraform init && terraform apply -var-file=...`.
2. **Copy a sibling.** `cp -r environments/prod/us-east-1
environments/prod/eu-west-1`, then change two values:
   - `terraform.tfvars` → `region`, `vpc_cidr`, `acm_certificate_domain`
   - `backend.tf` → `region`, `key` (one state file per env-region)
3. **Init.** `cd environments/prod/eu-west-1 && terraform init`.
4. **Plan.** `terraform plan -var-file=terraform.tfvars`.
5. **Apply.** `terraform apply -var-file=terraform.tfvars`.

The `Makefile` at `infra/terraform/Makefile` exposes shortcuts
(`make plan-prod-ue1`, `make plan-prod-uw2`, etc.).

## Never commit `terraform.tfvars` or `backend.tf`

The repository's `.gitignore` covers them. The `*.example` files are
the canonical templates; real values live in the deploy environment
(secret store, CI variables, or a developer's encrypted vault) and
are populated at apply time.
