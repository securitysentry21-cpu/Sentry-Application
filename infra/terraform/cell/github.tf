# CI pushes images without any stored AWS key (ARCH §19.8: no long-lived access keys anywhere):
# GitHub's OIDC token is exchanged for a short-lived role that can only push to our image repository,
# and only from the main branch of this repository. The repository is public, so pull requests from
# forks must never match: their tokens name refs/pull/…, not refs/heads/main.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.image_builder == "github" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  count = var.image_builder == "github" ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_images" {
  count                = var.image_builder == "github" ? 1 : 0
  name                 = "${local.name}-github-images"
  assume_role_policy   = data.aws_iam_policy_document.github_assume[0].json
  max_session_duration = 3600
}

# Push to our image repository only; used by CI (github) or CodeBuild (codebuild.tf).
data "aws_iam_policy_document" "ecr_push" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
}

resource "aws_iam_role_policy" "github_images" {
  count  = var.image_builder == "github" ? 1 : 0
  name   = "push-images"
  role   = aws_iam_role.github_images[0].name
  policy = data.aws_iam_policy_document.ecr_push.json
}
