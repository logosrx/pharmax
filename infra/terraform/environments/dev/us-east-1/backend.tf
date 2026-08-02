# Pharmax — dev / us-east-1 backend.
# Generated from the bootstrap run (workspace dev-ue1) on 2026-06-11,
# account pharmax-mgmt.
#
# Committed on purpose: the terraform-apply CI plan job needs the state
# coordinates, and without them it inits an empty local state and plans
# the whole stack from scratch. Bucket / lock-table names and the KMS
# ARN are not secrets — those live in Secrets Manager. See the
# env-region exception in .gitignore.

terraform {
  backend "s3" {
    bucket         = "pharmax-tfstate-dev-955504"
    key            = "pharmax/dev/us-east-1/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "pharmax-tfstate-locks-dev"
    encrypt        = true
    kms_key_id     = "arn:aws:kms:us-east-1:375259955504:key/33908f85-db29-4281-a3f7-702d29d27f13"
  }
}
