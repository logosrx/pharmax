output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "task_security_group_id" {
  value = aws_security_group.tasks.id
}

output "service_web_name" {
  value = aws_ecs_service.web.name
}

output "service_worker_name" {
  value = aws_ecs_service.worker.name
}

output "service_print_agent_name" {
  value = aws_ecs_service.print_agent.name
}

output "log_group_names" {
  value = {
    web         = aws_cloudwatch_log_group.web.name
    worker      = aws_cloudwatch_log_group.worker.name
    print_agent = aws_cloudwatch_log_group.print_agent.name
  }
}
