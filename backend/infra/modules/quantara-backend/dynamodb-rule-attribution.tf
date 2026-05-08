# Phase 8: rule-attribution table
#
# Stores per-(rule, pair, timeframe) accuracy attribution over 30d / 90d windows.
# 280 buckets × 2 windows = 560 rows steady-state.
#
# Schema:
#   PK: pk (S)       — "rule#pair#timeframe"
#   SK: window (S)   — "30d" | "90d"
#
# TTL: computedAt + 7 days (refreshed on each resolution batch)

resource "aws_dynamodb_table" "rule_attribution" {
  name         = "${local.prefix}-rule-attribution"
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
