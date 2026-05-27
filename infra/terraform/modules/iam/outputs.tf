output "task_execution_role_arn" {
  value = aws_iam_role.task_execution.arn
}

output "task_execution_role_name" {
  value = aws_iam_role.task_execution.name
}

output "task_role_web_arn" {
  value = aws_iam_role.task_web.arn
}

output "task_role_worker_arn" {
  value = aws_iam_role.task_worker.arn
}

output "task_role_print_agent_arn" {
  value = aws_iam_role.task_print_agent.arn
}
