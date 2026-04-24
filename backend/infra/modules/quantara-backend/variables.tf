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

variable "ingestion_interval_minutes" {
  description = "How often to fetch prices from exchanges (in minutes)."
  type        = number
  default     = 5
}

variable "alpaca_key_id" {
  description = "Alpaca API key ID for news data."
  type        = string
  default     = ""
}

variable "alpaca_secret_key" {
  description = "Alpaca API secret key for news data."
  type        = string
  sensitive   = true
  default     = ""
}

variable "docs_allowed_ips" {
  description = "Comma-separated list of IPs allowed to access /api/docs. Use '*' to allow all."
  type        = string
  default     = "*"
}

variable "fargate_cpu" {
  description = "Fargate ingestion task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "fargate_memory" {
  description = "Fargate ingestion task memory in MB."
  type        = number
  default     = 512
}
