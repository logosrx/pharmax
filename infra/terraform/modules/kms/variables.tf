variable "name_prefix" {
  description = "Prefix applied to every alias name."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account id (used in resource policies)."
  type        = string
}

variable "asymm_sign_key_spec" {
  description = <<-EOT
    Spec for the asymmetric Merkle-root signing key.

    **DEFAULT MUST STAY `ECC_NIST_P256` until the application signer is updated.**
    AWS KMS pairs each curve with EXACTLY one ECDSA hash size at sign time:
      - ECC_NIST_P256 → ECDSA_SHA_256
      - ECC_NIST_P384 → ECDSA_SHA_384
      - ECC_NIST_P521 → ECDSA_SHA_512
    The application Merkle signer at
    `packages/security/src/merkle/sign-merkle-root.ts` HARDCODES
    `SigningAlgorithm = "ECDSA_SHA_256"`, so any non-P256 spec here
    produces a key the signer cannot use (AWS responds with
    `InvalidSigningAlgorithmException` on `kms:Sign`). The verify path
    and the operator runbook
    (`docs/RUNBOOK.md` §"Rotating the audit Merkle-root signing key")
    both spell out `ECC_NIST_P256`.

    If you need to migrate to P-384 or RSA-PSS:
      1. Update the signer's hardcoded algorithm AND
         `KmsAsymmetricSigningClient` algorithm union in lockstep.
      2. Land a fixture-validated migration that re-signs the latest
         manifest with the new key BEFORE flipping the active key id.
      3. Then change this default.

    Until then: do not change the default. The validation list below
    accepts the broader set only so an in-progress migration that has
    already updated the signer can opt in explicitly via tfvars.
  EOT
  type        = string
  default     = "ECC_NIST_P256"

  validation {
    condition = contains([
      "ECC_NIST_P256",
      "ECC_NIST_P384",
      "ECC_NIST_P521",
      "RSA_2048",
      "RSA_3072",
      "RSA_4096",
    ], var.asymm_sign_key_spec)
    error_message = "asymm_sign_key_spec must be one of the AWS KMS asymmetric SIGN_VERIFY specs."
  }
}

variable "tags" {
  description = "Tags to apply to every key."
  type        = map(string)
  default     = {}
}
