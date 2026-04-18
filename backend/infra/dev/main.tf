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
  cors_origin    = "*"
  log_level      = "debug"
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

variable "dev_account_id" {
  type    = string
  default = "442725244722"
}

variable "aldero_app_id" {
  description = "Aldero client ID for JWT audience verification."
  type        = string
  default     = "cli_sp_01KPEJYM6QCB01Q0EE3ZB6D94F"
}
