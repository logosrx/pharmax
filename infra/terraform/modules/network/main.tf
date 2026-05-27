# =============================================================================
# Network module — VPC + subnet tiers + NAT + flow logs.
#
# Three subnet tiers:
#   - public:    /24 per AZ. Hosts only the ALB.
#   - private:   /22 per AZ. Hosts ECS Fargate tasks. Default route via NAT.
#   - isolated:  /24 per AZ. Hosts RDS. No internet egress.
#
# Why three tiers (not just public/private)?
#   PHI stores must not have any internet egress path even via NAT — the
#   isolated tier has no route to 0.0.0.0/0. This matches the
#   "no public DB" requirement from the brief and reduces the blast
#   radius if a tenant's IAM is misconfigured.
# =============================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)

  # /16 vpc → /20 per-AZ slice → divided by tier:
  #   bits 4 = AZ index (0..15)
  #   bits 8 = tier slot inside the AZ
  # The cidrsubnet calls below derive each subnet from `var.vpc_cidr`.
  public_subnets = {
    for idx, az in local.azs :
    az => cidrsubnet(var.vpc_cidr, 8, idx)
  }

  private_subnets = {
    for idx, az in local.azs :
    az => cidrsubnet(var.vpc_cidr, 6, idx + 4)
  }

  isolated_subnets = {
    for idx, az in local.azs :
    az => cidrsubnet(var.vpc_cidr, 8, idx + 32)
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-vpc"
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-igw"
  })
}

# ---- Subnets ----------------------------------------------------------------

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value
  availability_zone       = each.key
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-${each.key}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value
  availability_zone       = each.key
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-private-${each.key}"
    Tier = "private"
  })
}

resource "aws_subnet" "isolated" {
  for_each = local.isolated_subnets

  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value
  availability_zone       = each.key
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-isolated-${each.key}"
    Tier = "isolated"
  })
}

# ---- NAT --------------------------------------------------------------------
# `single` keeps dev cheap. `per_az` ensures an AZ failure doesn't sever
# egress for the remaining healthy private subnets.

locals {
  nat_az_names = var.nat_gateway_strategy == "per_az" ? local.azs : [local.azs[0]]
}

resource "aws_eip" "nat" {
  for_each = toset(local.nat_az_names)

  domain = "vpc"

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-nat-${each.key}"
  })
}

resource "aws_nat_gateway" "this" {
  for_each = toset(local.nat_az_names)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-nat-${each.key}"
  })

  depends_on = [aws_internet_gateway.this]
}

# ---- Route tables -----------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-rt-public"
  })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  for_each = aws_subnet.private

  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-rt-private-${each.key}"
  })
}

resource "aws_route" "private_nat" {
  for_each = aws_route_table.private

  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = var.nat_gateway_strategy == "per_az" ? aws_nat_gateway.this[each.key].id : aws_nat_gateway.this[local.nat_az_names[0]].id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# Isolated tier intentionally has no default route to 0.0.0.0/0.
# A dedicated route table makes the isolation explicit and easy to audit.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-rt-isolated"
    Tier = "isolated"
  })
}

resource "aws_route_table_association" "isolated" {
  for_each = aws_subnet.isolated

  subnet_id      = each.value.id
  route_table_id = aws_route_table.isolated.id
}

# ---- VPC flow logs ----------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${var.name_prefix}/flow-logs"
  retention_in_days = var.flow_logs_retention_days
  kms_key_id        = var.flow_logs_kms_key_arn

  tags = var.tags
}

resource "aws_iam_role" "flow_logs" {
  name = "${var.name_prefix}-vpc-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "vpc-flow-logs.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "${var.name_prefix}-vpc-flow-logs"
  role = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}

resource "aws_flow_log" "this" {
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
  traffic_type         = "ALL"
  vpc_id               = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-flow-log"
  })
}
