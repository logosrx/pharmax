# =============================================================================
# Pharmax — Terraform provider pins.
#
# Pharmax is a HIPAA-aware modular monolith. The IaC needs to be
# reproducible across env (dev / staging / prod) and across operators.
# Pin the provider major + minor versions to avoid surprise drift on a
# new clone or a fresh CI runner.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
