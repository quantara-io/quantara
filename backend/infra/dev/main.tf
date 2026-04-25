terraform {
  required_version = ">= 1.14"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket         = "quantara-tf-state"
    key            = "backend/dev/terraform.tfstate"
    region         = "us-west-2"
    profile        = "quantara-management"
    dynamodb_table = "quantara-tf-locks"
    encrypt        = true
  }
}

provider "aws" {
  region  = "us-west-2"
  profile = "quantara-management"

  assume_role {
    role_arn     = "arn:aws:iam::${var.dev_account_id}:role/OrganizationAccountAccessRole"
    session_name = "terraform-quantara-backend-dev"
  }

  default_tags {
    tags = {
      Project     = "quantara"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

module "backend" {
  source = "../modules/quantara-backend"

  environment      = "dev"
  app_source_dir   = "${path.module}/../.."
  auth_base_url    = "https://quantara-sandbox.aldero.io"
  app_id           = var.aldero_app_id
  cors_origin = "https://d3tavvh2o76dc5.cloudfront.net,${module.admin.cloudfront_url}"
  log_level   = "debug"
}

module "admin" {
  source = "../modules/quantara-admin"

  environment = "dev"
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

output "ecr_repository_url" {
  value = module.backend.ecr_repository_url
}

output "ecs_cluster_name" {
  value = module.backend.ecs_cluster_name
}

output "ecs_service_name" {
  value = module.backend.ecs_service_name
}

output "cloudfront_url" {
  value = module.backend.cloudfront_url
}

output "admin_cloudfront_url" {
  value = module.admin.cloudfront_url
}

output "admin_bucket_name" {
  value = module.admin.bucket_name
}

output "admin_distribution_id" {
  value = module.admin.cloudfront_distribution_id
}

variable "dev_account_id" {
  type    = string
  default = "442725244722"
}

variable "aldero_app_id" {
  description = "Aldero app/tenant ID for JWT audience verification."
  type        = string
  default     = "app_01KPEJYKSSQB3CVWV0D0NSC3KX"
}
