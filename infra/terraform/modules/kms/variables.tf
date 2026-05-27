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
    Spec for the asymmetric Merkle-root signing key. ECC_NIST_P384 is the
    default — small signatures (~96 bytes), broadly supported by software
    verifiers, and FIPS-validated under AWS KMS. Switch to RSA_4096 only
    if a specific external verifier requires RSA-PSS / RSA-PKCS1v15 over
    a well-known SHA-256/SHA-384 hash and cannot accept ECDSA.
  EOT
  type        = string
  default     = "ECC_NIST_P384"

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
