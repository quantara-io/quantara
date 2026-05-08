# Phase 5b: sentiment-aggregates — persists the result of recomputeSentimentAggregate.
#
# Schema:
#   PK: pair (S)      e.g. "BTC"
#   SK: window (S)    "4h" | "24h"
#
# Attributes: computedAt, articleCount, meanScore, meanMagnitude,
#             fearGreedTrend24h, fearGreedLatest
#
# No TTL — rows are overwritten on each recompute. One row per (pair, window),
# so the table stays small (5 pairs × 2 windows = 10 rows steady-state).

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

  point_in_time_recovery { enabled = true }
}
