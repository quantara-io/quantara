variable "environment" {
  type = string
}

variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "app_source_dir" {
  description = "Path to the backend/ directory containing package.json and src/."
  type        = string
}

variable "auth_base_url" {
  description = "Aldero auth base URL for JWT verification."
  type        = string
}

variable "app_id" {
  description = "Aldero app ID for JWT audience verification."
  type        = string
}

variable "cors_origin" {
  description = "Allowed CORS origin."
  type        = string
  default     = "*"
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "lambda_memory" {
  type    = number
  default = 512
}

variable "lambda_timeout" {
  type    = number
  default = 30
}
