# Issue #368 — Phase 1: candles-archive table.
#
# Mirrors the candles table key schema (PK=pair, SK=exchange#timeframe#iso8601)
# and the exchange-index GSI, but WITHOUT TTL — the whole point is that historical
# candle data persists indefinitely for backtesting.
#
# Phase 1: table is created but empty. Backfill is a separate prerequisite issue
# (can land in parallel with Phase 2 of the backtest harness).
#
# Access: developer-facing — engineers assume the quantara-dev SSO role locally.
# A dedicated backtest-runner IAM role will be added when the harness needs to
# run in CI/CD (deferred to a future phase).
resource "aws_dynamodb_table" "candles_archive" {
  name         = "${local.prefix}-candles-archive"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "sk"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "exchange"
    type = "S"
  }

  global_secondary_index {
    name            = "exchange-index"
    hash_key        = "exchange"
    range_key       = "sk"
    projection_type = "ALL"
  }

  # No TTL — historical data must persist indefinitely for accurate backtesting.

  point_in_time_recovery { enabled = true }
}
