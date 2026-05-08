# Phase 8: accuracy-aggregates table
#
# Stores rolling accuracy / Brier / ECE metrics per (pair, timeframe) bucket.
#
# Schema:
#   PK: pk (S)      — "pair#timeframe"
#   SK: window (S)  — "7d" | "30d" | "90d"
#
# TTL: computedAt + 7 days (refreshed on each resolution batch)

resource "aws_dynamodb_table" "accuracy_aggregates" {
  name         = "${local.prefix}-accuracy-aggregates"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pk"
  range_key = "window"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "window"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
