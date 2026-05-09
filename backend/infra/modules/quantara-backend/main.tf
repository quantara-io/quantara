locals {
  prefix = "quantara-${var.environment}"

  # Number of distinct exchanges that must have written a candle for a given
  # (pair, tf, closeTime) close-quorum row before the indicator handler
  # computes a signal. Source of truth for both indicator-handler and
  # close-quorum-monitor — keep them in sync to avoid false-positive
  # CloseMissed metrics when this is tuned.
  required_exchange_count = "2"

  alpaca_ssm_param_arns = [
    "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quantara/${var.environment}/alpaca/key-id",
    "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quantara/${var.environment}/alpaca/secret-key",
  ]
}

data "aws_caller_identity" "current" {}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}
