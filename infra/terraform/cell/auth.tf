# Dashboard sign-in: Amazon Cognito over OpenID Connect (D-01). MFA is required for everyone (SEC §5).
# People may create their own account, but an account alone grants nothing: access comes only from
# an invitation, accepted by a verified email that matches it (apps/api routes/invitations.ts).
resource "aws_cognito_user_pool" "dashboard" {
  name                     = local.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON"
  deletion_protection      = "ACTIVE"

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 3
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }
}

resource "random_string" "cognito_domain" {
  length  = 6
  special = false
  upper   = false
}

# The sign-in pages: https://sentryops-<random>.auth.eu-central-1.amazoncognito.com
resource "aws_cognito_user_pool_domain" "dashboard" {
  domain       = "sentryops-${random_string.cognito_domain.result}"
  user_pool_id = aws_cognito_user_pool.dashboard.id
}

resource "aws_cognito_user_pool_client" "dashboard" {
  name                                 = "dashboard"
  user_pool_id                         = aws_cognito_user_pool.dashboard.id
  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = ["${local.public_origin}/api/v1/auth/callback"]
  logout_urls                          = ["${local.public_origin}/"]
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  id_token_validity                    = 60
  access_token_validity                = 60
  token_validity_units {
    id_token     = "minutes"
    access_token = "minutes"
  }
}
