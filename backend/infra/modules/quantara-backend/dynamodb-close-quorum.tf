# ---------------------------------------------------------------------------
# close-quorum table — v6 P2 design §11.5
#
# Collects exchange arrivals for each (pair, timeframe, closeTime) bar.
# The IndicatorLambda does a DDB String Set ADD on `exchanges` for each
# candle it receives; once the set size >= REQUIRED_EXCHANGE_COUNT (2) the
# handler proceeds to compute and write the blended signal.
#
# PK (id): "pair#timeframe#closeTime"  e.g. "BTC/USDT#1h#1746576000000"
# exchanges: String Set (ADD, not overwrite)
# ttl: epoch SECONDS = floor(closeTimeMs / 1000) + 86_400  (24h)
#
# Streams=NEW_AND_OLD_IMAGES — required by close-quorum-monitor Lambda, which
# reads OldImage on REMOVE events to detect bars that reached quorum but never
# produced a signal (CloseMissed metric).
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "close_quorum" {
  name         = "${local.prefix}-close-quorum"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  point_in_time_recovery { enabled = true }
}
