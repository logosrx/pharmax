provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      Region      = var.region
      ManagedBy   = "terraform"
      Application = "pharmax"
      Compliance  = "hipaa+soc2"
    }
  }
}
