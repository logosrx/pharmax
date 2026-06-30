# Provider pins for this module, kept consistent with the root
# `infra/terraform/versions.tf`. Child modules declare their own
# `required_providers` so the module is self-describing and
# `tflint --recursive` can lint each module in isolation.

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
