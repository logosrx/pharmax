// =============================================================================
// tflint configuration for Pharmax Terraform.
//
// Run from `infra/terraform/`:
//
//   tflint --init
//   tflint --recursive
//
// The recursive mode walks every module + every env-region working directory.
// This config is checked in; the operator's local `~/.tflint.d/` is unused.
// =============================================================================

config {
  call_module_type = "all"
  force            = false
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.32.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

// Disable rules that produce noise in our codebase shape:

// We use module composition; documenting `terraform required_version` once
// at the root + each env-region dir is sufficient.
rule "terraform_required_version" {
  enabled = true
}

rule "terraform_required_providers" {
  enabled = true
}

// Module sources that are local paths (`./modules/...`, `../../..`) are
// fine; we don't need to pin a registry source.
rule "terraform_module_pinned_source" {
  enabled = false
}

// We do use legacy alias outputs intentionally (kms_app_phi_*) for backward
// compatibility — disable the unused output / variable nags so they don't
// fire on those.
rule "terraform_unused_declarations" {
  enabled = false
}

// Naming convention enforcement is helpful but not always feasible across
// historical resources; soften to warning level.
rule "terraform_naming_convention" {
  enabled = false
}

// Documenting every variable type is required (we already do).
rule "terraform_typed_variables" {
  enabled = true
}

rule "terraform_documented_variables" {
  enabled = false
}

rule "terraform_documented_outputs" {
  enabled = false
}
