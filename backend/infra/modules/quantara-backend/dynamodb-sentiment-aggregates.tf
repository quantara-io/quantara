# Phase 5b: sentiment-aggregates — windowed sentiment roll-ups per pair
# PK: pair (S)    SK: window (S) — "4h" | "24h"
# TTL: 1 hour (refreshed on every news event or 5-min scheduled fallback)
resource "aws_dynamodb_table" "sentiment_aggregates" {
  name         = "${local.prefix}-sentiment-aggregates"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "window"

  attribute {
    name = "pair"
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
