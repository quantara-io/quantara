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
    key            = "backend/prod/terraform.tfstate"
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
    role_arn     = "arn:aws:iam::${var.prod_account_id}:role/OrganizationAccountAccessRole"
    session_name = "terraform-quantara-backend-prod"
  }

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
