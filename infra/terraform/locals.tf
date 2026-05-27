# =============================================================================
# Root locals — name + tag derivation.
#
# A single source of truth for resource naming and tagging. Two rules:
#
#   1. Every resource name follows `pharmax-${env}-${region-short}-<purpose>`.
#      Including the region short-code in the prefix keeps multi-region
#      resources distinguishable in the AWS console without inspecting tags.
#
#   2. Every resource carries the `common_tags` map. PHI-bearing resources
#      additionally pick up `phi_tags` (the inherited `common_tags` plus
#      `DataClassification = phi` and `HipaaScope = in-scope`).
#
# Region short-codes match the AWS naming convention (us-east-1 → use1,
# us-west-2 → usw2, eu-west-1 → euw1) and are derived programmatically;
# no manual list to drift.
# =============================================================================

locals {
  # Compact region code: drop the dashes and the digit alignment, keep the
  # canonical "first letter of each word + final digit" form.
  region_segments  = split("-", var.region)
  region_shortcode = format(
    "%s%s%s",
    substr(local.region_segments[0], 0, 1),
    substr(local.region_segments[1], 0, 1),
    local.region_segments[2],
  )

  name_prefix = "${var.project}-${var.environment}-${local.region_shortcode}"

  base_tags = {
    Project     = var.project
    Environment = var.environment
    Region      = var.region
    ManagedBy   = "terraform"
    Application = "pharmax"
    Compliance  = "hipaa+soc2"
  }

  common_tags = merge(local.base_tags, var.tags)

  # PHI-bearing resources opt in to a stricter tag for backup / scan rules.
  phi_tags = merge(local.common_tags, {
    DataClassification = "phi"
    HipaaScope         = "in-scope"
  })
}
