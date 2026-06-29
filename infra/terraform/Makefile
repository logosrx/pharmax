# =============================================================================
# Pharmax Terraform — operator shortcuts.
#
# Usage:
#
#   make fmt                 # format every .tf file in the tree
#   make validate            # init -backend=false + validate every module
#   make lint                # tflint --recursive
#
#   make plan-dev-ue1       # plan against environments/dev/us-east-1
#   make plan-staging-ue1   # plan against environments/staging/us-east-1
#   make plan-prod-ue1      # plan against environments/prod/us-east-1
#   make plan-prod-uw2      # plan against environments/prod/us-west-2
#
#   make init-dev-ue1       # init the dev/ue1 working directory
#   make ...
#
# All targets shell out to terraform / tflint; this Makefile owns the
# directory walking + flag conventions, never inline state material.
# =============================================================================

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(abspath $(CURDIR))

# Every leaf working directory (root composition + bootstrap + each env-region)
# is enumerated explicitly so a typo doesn't silently miss a directory.
ENV_DIRS := \
  environments/dev/us-east-1 \
  environments/staging/us-east-1 \
  environments/prod/us-east-1 \
  environments/prod/us-west-2

MODULE_DIRS := \
  modules/alb \
  modules/cloudwatch \
  modules/ecr \
  modules/ecs \
  modules/iam \
  modules/kms \
  modules/network \
  modules/rds \
  modules/s3-audit-archive \
  modules/s3-documents \
  modules/secrets \
  modules/waf

# All directories validate runs against (root + bootstrap + every env-region).
# Modules don't have providers and don't validate independently in any
# meaningful way; they're validated transitively when the root validates.
VALIDATE_DIRS := . bootstrap $(ENV_DIRS)

# ---- Help ------------------------------------------------------------------

.PHONY: help
help:
	@grep -E '^# {2,}.+|^[a-zA-Z0-9_/-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN { FS=":.*?##" } /^[a-zA-Z0-9_/-]+:/ { printf "  %-30s %s\n", $$1, $$2 }'

# ---- Format ----------------------------------------------------------------

.PHONY: fmt
fmt: ## Format every .tf file (`terraform fmt -recursive`)
	terraform fmt -recursive

.PHONY: fmt-check
fmt-check: ## Verify every .tf file is formatted (no diff)
	terraform fmt -recursive -check -diff

# ---- Validate --------------------------------------------------------------

# Validate uses `-backend=false` so a missing backend.tf doesn't block CI.
# Every working directory is walked; a failure in any one halts the rest.
.PHONY: validate
validate: ## Run `terraform init -backend=false && terraform validate` for every working directory
	@set -e; for d in $(VALIDATE_DIRS); do \
	  echo ""; \
	  echo ">>> validating $$d"; \
	  ( cd $$d && terraform init -backend=false -input=false -upgrade=false >/dev/null && terraform validate ); \
	done

# ---- Lint ------------------------------------------------------------------

.PHONY: lint
lint: ## Run tflint --recursive against every directory
	tflint --init
	tflint --recursive

# ---- Init ------------------------------------------------------------------

.PHONY: init-dev-ue1 init-staging-ue1 init-prod-ue1 init-prod-uw2 init-bootstrap

init-bootstrap: ## terraform init in bootstrap/ (run BEFORE any env init)
	cd bootstrap && terraform init -input=false

init-dev-ue1: ## terraform init in environments/dev/us-east-1
	cd environments/dev/us-east-1 && terraform init -input=false

init-staging-ue1: ## terraform init in environments/staging/us-east-1
	cd environments/staging/us-east-1 && terraform init -input=false

init-prod-ue1: ## terraform init in environments/prod/us-east-1
	cd environments/prod/us-east-1 && terraform init -input=false

init-prod-uw2: ## terraform init in environments/prod/us-west-2
	cd environments/prod/us-west-2 && terraform init -input=false

# ---- Plan ------------------------------------------------------------------

.PHONY: plan-dev plan-dev-ue1 plan-staging plan-staging-ue1 plan-prod plan-prod-ue1 plan-prod-uw2

plan-dev: plan-dev-ue1
plan-staging: plan-staging-ue1
plan-prod: plan-prod-ue1

plan-dev-ue1: ## terraform plan against dev/us-east-1
	cd environments/dev/us-east-1 && terraform plan -var-file=terraform.tfvars -out=tfplan

plan-staging-ue1: ## terraform plan against staging/us-east-1
	cd environments/staging/us-east-1 && terraform plan -var-file=terraform.tfvars -out=tfplan

plan-prod-ue1: ## terraform plan against prod/us-east-1 (PRIMARY)
	cd environments/prod/us-east-1 && terraform plan -var-file=terraform.tfvars -out=tfplan

plan-prod-uw2: ## terraform plan against prod/us-west-2 (DR)
	cd environments/prod/us-west-2 && terraform plan -var-file=terraform.tfvars -out=tfplan

# ---- Apply (gated; no apply targets — operator runs explicitly) ------------

# We deliberately do NOT publish an `apply-prod` target. Production applies
# are operator-driven via the deploy pipeline, with sign-off. A Makefile
# typo on `apply-prod` is too cheap to be a SOC 2 finding waiting to happen.

# ---- Drift detection (CI-friendly) -----------------------------------------

.PHONY: drift-prod-ue1 drift-prod-uw2

drift-prod-ue1: ## Plan with -detailed-exitcode against prod/us-east-1; non-zero == drift
	cd environments/prod/us-east-1 && terraform plan -var-file=terraform.tfvars -detailed-exitcode -lock=false || ([ $$? -eq 2 ] && echo "DRIFT DETECTED" && exit 2)

drift-prod-uw2:
	cd environments/prod/us-west-2 && terraform plan -var-file=terraform.tfvars -detailed-exitcode -lock=false || ([ $$? -eq 2 ] && echo "DRIFT DETECTED" && exit 2)

# ---- All-in-one CI gate ----------------------------------------------------

.PHONY: ci
ci: fmt-check validate lint ## Run every gate the CI workflow runs
