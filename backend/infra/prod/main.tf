terraform {
  required_version = ">= 1.14"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Per-account state — bucket + lock table colocated with the prod workload
  # they describe. See infra issue #1.
  #
  # Credentials resolve from the SDK chain so the same config works locally
  # (AWS_PROFILE=quantara-prod before terraform init) and in CI (OIDC env vars
  # from aws-actions/configure-aws-credentials). Don't hardcode `profile` —
  # CI has no ~/.aws/config file.
  backend "s3" {
    bucket         = "quantara-tf-state-prod"
    key            = "backend/prod/terraform.tfstate"
    region         = "us-west-2"
    dynamodb_table = "quantara-tf-locks-prod"
    encrypt        = true
  }
}

# Provider uses the prod account directly per infra issue #1 (per-account
# state). No cross-account assume-role needed. Credentials come from the
# SDK chain (AWS_PROFILE env locally, OIDC env vars in CI).
provider "aws" {
  region = "us-west-2"

  default_tags {
    tags = {
      Project     = "quantara"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

module "backend" {
  source = "../modules/quantara-backend"

  environment    = "prod"
  app_source_dir = "${path.module}/../.."
  auth_base_url  = "https://quantara.aldero.io"
  app_id         = var.aldero_app_id
  cors_origin    = "https://quantara.io"
  log_level      = "info"
  lambda_memory  = 1024
}

output "api_url" {
  value = module.backend.api_url
}

output "lambda_function_name" {
  value = module.backend.lambda_function_name
}

output "table_names" {
  value = module.backend.table_names
}

variable "prod_account_id" {
  type    = string
  default = "351666231984"
}

variable "aldero_app_id" {
  type    = string
  default = "cli_pp_01KPEJYKS1H2RVZ0CTH6MRTEM4"
}
