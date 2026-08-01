# Pharmax — prod / us-east-1 backend (PRIMARY region).

terraform {
  backend "s3" {
    bucket         = "pharmax-tfstate-prod-116354"
    key            = "pharmax/prod/us-east-1/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "pharmax-tfstate-locks-prod"
    encrypt        = true
    kms_key_id     = "arn:aws:kms:us-east-1:172800116354:key/b884bfb2-cc81-46f2-a177-7b121ad8546b"
  }
}
