# Phase 8 §10.10: rule-status table
#
# Stores the lifecycle status for each (rule, pair, timeframe) bucket.
# Written by the rule-prune Lambda; read by the ingestion Fargate service
# before applying each rule.
#
# Schema:
#   PK: pk (S)  — "{rule}#{pair}#{TF}"
#   (no sort key — one row per bucket)
#
# No TTL — rows are long-lived lifecycle state; the prune job overwrites them.

resource "aws_dynamodb_table" "rule_status" {
  name         = "${local.prefix}-rule-status"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}
