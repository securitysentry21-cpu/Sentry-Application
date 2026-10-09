output "dashboard_url" {
  description = "The dashboard and the API: the guard app's server address."
  value       = local.public_origin
}

output "image_repository" {
  value = aws_ecr_repository.app.repository_url
}

output "github_images_role_arn" {
  description = "With image_builder = github: set as the repository variable AWS_IMAGES_ROLE_ARN so CI can push images."
  value       = var.image_builder == "github" ? aws_iam_role.github_images[0].arn : null
}

output "image_build_project" {
  description = "With image_builder = codebuild: the CodeBuild project that infra/scripts/build-image.sh starts."
  value       = var.image_builder == "codebuild" ? aws_codebuild_project.image[0].name : null
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "dbadmin_task_definition" {
  value = aws_ecs_task_definition.dbadmin.arn
}

output "api_task_definition" {
  value = aws_ecs_task_definition.api.arn
}

output "task_subnets" {
  value = aws_subnet.public[*].id
}

output "task_security_groups" {
  value = { for k, v in aws_security_group.service : k => v.id }
}

output "cognito_sign_in_domain" {
  value = "https://${aws_cognito_user_pool_domain.dashboard.domain}.auth.${var.region}.amazoncognito.com"
}
