variable "environment" {
  description = "Environment name (dev, prod)."
  type        = string
}

variable "aws_region" {
  description = "AWS region for S3 bucket."
  type        = string
  default     = "us-west-2"
}

locals {
  prefix = "quantara-${var.environment}-admin"
}
