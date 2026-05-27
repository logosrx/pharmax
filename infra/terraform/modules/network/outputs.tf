output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = [for s in aws_subnet.public : s.id]
}

output "private_subnet_ids" {
  value = [for s in aws_subnet.private : s.id]
}

output "isolated_subnet_ids" {
  value = [for s in aws_subnet.isolated : s.id]
}

output "availability_zones" {
  value = local.azs
}

output "flow_log_group_arn" {
  value = aws_cloudwatch_log_group.flow_logs.arn
}
