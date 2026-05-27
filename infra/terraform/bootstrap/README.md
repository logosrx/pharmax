# Pharmax — Terraform backend bootstrap

This is a one-shot Terraform module that creates the resources every other
Terraform run depends on:

- An S3 bucket for state files (versioning + SSE-KMS + GOVERNANCE Object
  Lock + TLS-only + public-access blocked).
- A DynamoDB lock table (encrypted, PITR enabled, deletion protected).
- A customer-managed KMS key encrypting both.

You run this BEFORE the first `terraform init` against any
`environments/<env>/<region>/` directory, because Terraform cannot create
the bucket it stores its state in.

## Bootstrap recipe

Run from this directory once per `(account, env, region)` tuple:

```bash
cd infra/terraform/bootstrap

# 1. Copy the .tfvars and edit (account_suffix, region, environment).
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

# 2. Initialize WITHOUT a remote backend. The bootstrap state lives locally
#    on the operator's machine until step 5.
terraform init

# 3. Plan + apply.
terraform plan -out=bootstrap.tfplan
terraform apply bootstrap.tfplan

# 4. Capture the outputs — you'll paste them into the per-env-region
#    backend.tf.
terraform output
```

You'll get back something like:

```
state_bucket_name   = "pharmax-tfstate-dev-abc123"
state_bucket_arn    = "arn:aws:s3:::pharmax-tfstate-dev-abc123"
lock_table_name     = "pharmax-tfstate-locks-dev"
state_kms_key_arn   = "arn:aws:kms:us-east-1:111122223333:key/abcd-efgh-..."
state_kms_key_alias = "alias/pharmax-tfstate-dev"
```

Plug those into the env-region backend file:

```bash
cd ../environments/dev/us-east-1
cp backend.tf.example backend.tf
$EDITOR backend.tf
# Replace REPLACE_pharmax-tfstate-dev-<account-suffix> with the bucket name.
# Replace REPLACE_pharmax-tfstate-locks-dev with the lock table name.
# Replace REPLACE_arn:... with the state KMS key ARN.

terraform init   # initializes the env-region backend against the bootstrap.
```

## Migrating bootstrap state to remote (optional)

The bootstrap state is small but reasonable to keep in version control or
1Password. To move it to its own remote backend (so a new operator can
re-plan without the local state file), add a backend block to
`bootstrap/main.tf` after first apply and run:

```bash
terraform init -migrate-state
```

…against the same bucket the bootstrap created. The bootstrap state then
lives at e.g. `s3://pharmax-tfstate-prod-abc123/pharmax/bootstrap/<env>/terraform.tfstate`.

## Cleanup

A bootstrap teardown is rare — you only do it when retiring an entire AWS
account. The state bucket has GOVERNANCE Object Lock; removing the lock
requires `s3:BypassGovernanceRetention` and is logged in CloudTrail. The
DynamoDB lock table has deletion protection — disable that explicitly
before destroy.

```bash
terraform destroy
```

…will refuse to remove the bucket if it has objects with active retention.
That is the intended safety: a typo at this layer is a SOC 2 incident.
