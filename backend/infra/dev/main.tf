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

  environment    = "dev"
  app_source_dir = "${path.module}/../.."
  auth_base_url  = "https://quantara-sandbox.aldero.io"
  app_id         = var.aldero_app_id
  cors_origin       = "*"
  log_level         = "debug"
  docs_allowed_ips  = "68.4.159.0/24,104.28.49.0/24,2a09:bac3::/32"
  alpaca_key_id     = var.alpaca_key_id
  alpaca_secret_key = var.alpaca_secret_key
}

variable "alpaca_key_id" {
  type    = string
  default = ""
}

variable "alpaca_secret_key" {
  type      = string
  sensitive = true
  default   = ""
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

variable "dev_account_id" {
  type    = string
  default = "442725244722"
}

variable "aldero_app_id" {
  description = "Aldero app/tenant ID for JWT audience verification."
  type        = string
  default     = "app_01KPEJYKSSQB3CVWV0D0NSC3KX"
}
