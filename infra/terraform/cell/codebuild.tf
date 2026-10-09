# Image builds inside the account (image_builder = "codebuild"), for accounts that can't trust GitHub's
# OIDC provider, such as AWS's simplified account type. CodeBuild clones the public repository at the
# commit given, builds infra/docker/Dockerfile on Arm, and pushes sentryops:<commit> to our ECR
# repository with its own role: still no AWS key anywhere. infra/scripts/build-image.sh starts it, after
# CI has passed for that commit.
locals {
  codebuild = var.image_builder == "codebuild" ? 1 : 0
}

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "image_builder" {
  count              = local.codebuild
  name               = "${local.name}-image-builder"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

resource "aws_cloudwatch_log_group" "image_builder" {
  count             = local.codebuild
  name              = "/${local.name}/image-builder"
  retention_in_days = 30
}

data "aws_iam_policy_document" "image_builder_logs" {
  count = local.codebuild
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.image_builder[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "image_builder_logs" {
  count  = local.codebuild
  name   = "write-build-logs"
  role   = aws_iam_role.image_builder[0].name
  policy = data.aws_iam_policy_document.image_builder_logs[0].json
}

resource "aws_iam_role_policy" "image_builder_push" {
  count  = local.codebuild
  name   = "push-images"
  role   = aws_iam_role.image_builder[0].name
  policy = data.aws_iam_policy_document.ecr_push.json
}

resource "aws_codebuild_project" "image" {
  count         = local.codebuild
  name          = "${local.name}-image"
  description   = "Builds sentryops:<commit> from the public repository"
  service_role  = aws_iam_role.image_builder[0].arn
  build_timeout = 30

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    type            = "ARM_CONTAINER"
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux-aarch64-standard:3.0"
    privileged_mode = true # Docker builds need it

    environment_variable {
      name  = "REPOSITORY_URL"
      value = aws_ecr_repository.app.repository_url
    }
    environment_variable {
      name  = "GIT_REPOSITORY"
      value = "https://github.com/${var.github_repository}.git"
    }
    environment_variable {
      name  = "GIT_COMMIT"
      value = "" # set on every build by build-image.sh
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.image_builder[0].name
    }
  }

  source {
    type = "NO_SOURCE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        pre_build = {
          commands = [
            "test -n \"$GIT_COMMIT\"",
            "git clone --quiet \"$GIT_REPOSITORY\" \"$CODEBUILD_SRC_DIR/src\"",
            "git -C \"$CODEBUILD_SRC_DIR/src\" checkout --quiet --detach \"$GIT_COMMIT\"",
            "aws ecr get-login-password --region \"$AWS_REGION\" | docker login --username AWS --password-stdin \"$${REPOSITORY_URL%%/*}\"",
          ]
        }
        build = {
          commands = [
            "docker build -f \"$CODEBUILD_SRC_DIR/src/infra/docker/Dockerfile\" -t \"$REPOSITORY_URL:$GIT_COMMIT\" \"$CODEBUILD_SRC_DIR/src\"",
          ]
        }
        post_build = {
          commands = [
            "test \"$CODEBUILD_BUILD_SUCCEEDING\" = 1",
            "docker push \"$REPOSITORY_URL:$GIT_COMMIT\"",
          ]
        }
      }
    })
  }
}
