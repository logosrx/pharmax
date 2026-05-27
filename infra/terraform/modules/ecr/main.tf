# =============================================================================
# ECR module — one repo per service image.
#
# Three repositories:
#   - web         (apps/web Next.js image)
#   - worker      (apps/worker BullMQ-style polling worker)
#   - print-agent (apps/print-agent workstation companion)
#
# Each has:
#   - Image scanning on push (Inspector V2 integrates automatically if enabled)
#   - AES256 server-side encryption (KMS-CMK is overkill for an image registry)
#   - Tag immutability so a deployed `release-2025.11.04-abc1234` can't be
#     silently swapped by a re-push
#   - Lifecycle: expire untagged images after `var.untagged_image_expiry_days`,
#     keep the most recent N release-tagged images
# =============================================================================

locals {
  repos = ["web", "worker", "print-agent"]

  lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the ${var.retained_release_count} most recent release-tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["release-", "v"]
          countType     = "imageCountMoreThan"
          countNumber   = var.retained_release_count
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after ${var.untagged_image_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_expiry_days
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_repository" "this" {
  for_each = toset(local.repos)

  name                 = "${var.name_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = var.image_scanning_enabled
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, {
    Service = each.key
  })
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy     = local.lifecycle_policy
}
