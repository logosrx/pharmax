variable "name_prefix" {
  description = "Prefix applied to repo names."
  type        = string
}

variable "tags" {
  description = "Tags to apply to every repository."
  type        = map(string)
  default     = {}
}

variable "image_scanning_enabled" {
  description = "Scan images on push for CVEs (Inspector)."
  type        = bool
  default     = true
}

variable "untagged_image_expiry_days" {
  description = "Lifecycle rule: expire untagged images older than N days."
  type        = number
  default     = 14
}

variable "retained_release_count" {
  description = "Lifecycle rule: retain the N most recent release-tagged images."
  type        = number
  default     = 50
}
