locals {
  prefix = "quantara-${var.environment}"

  alpaca_ssm_param_arns = [
    "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quantara/${var.environment}/alpaca/key-id",
    "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quantara/${var.environment}/alpaca/secret-key",
  ]
}

data "aws_caller_identity" "current" {}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}
