resource "aws_dynamodb_table" "users" {
  name         = "${local.prefix}-users"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "email"
    type = "S"
  }

  global_secondary_index {
    name            = "email-index"
    hash_key        = "email"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "signals" {
  name         = "${local.prefix}-signals"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "createdAt"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # DDB Streams — consumed by signals-fanout Lambda (WebSocket push, §16).
  # NEW_IMAGE only: fanout needs the signal payload but not the before-image.
  # NOTE: subscribe to THIS table (ratified signals), NOT signals-v2 (pre-ratification).
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"
}

resource "aws_dynamodb_table" "signal_history" {
  name         = "${local.prefix}-signal-history"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "signalId"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "signalId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "coach_sessions" {
  name         = "${local.prefix}-coach-sessions"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "userId"
  range_key = "sessionId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "coach_messages" {
  name         = "${local.prefix}-coach-messages"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "sessionId"
  range_key = "messageId"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "messageId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "deals" {
  name         = "${local.prefix}-deals"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "dealId"

  attribute {
    name = "dealId"
    type = "S"
  }

  attribute {
    name = "authorId"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "author-index"
    hash_key        = "authorId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "deal_interests" {
  name         = "${local.prefix}-deal-interests"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "dealId"
  range_key = "userId"

  attribute {
    name = "dealId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "campaigns" {
  name         = "${local.prefix}-campaigns"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "userId"
  range_key = "campaignId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "campaignId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "candles" {
  name         = "${local.prefix}-candles"
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

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # v6 P2: DDB Streams feeds the IndicatorLambda (NEW_IMAGE only — no need for OldImage).
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "news_events" {
  name         = "${local.prefix}-news-events"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "newsId"
  range_key = "publishedAt"

  attribute {
    name = "newsId"
    type = "S"
  }

  attribute {
    name = "publishedAt"
    type = "S"
  }

  attribute {
    name = "currency"
    type = "S"
  }

  global_secondary_index {
    name            = "currency-index"
    hash_key        = "currency"
    range_key       = "publishedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "ingestion_metadata" {
  name         = "${local.prefix}-ingestion-metadata"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "metaKey"

  attribute {
    name = "metaKey"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "prices" {
  name         = "${local.prefix}-prices"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "timestamp"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}

# Phase 4a: indicator-state cache
# PK: pair#exchange#timeframe  SK: asOf (ISO8601)
# TTL: 7 days — only the latest snapshot matters; old ones expire automatically
resource "aws_dynamodb_table" "indicator_state" {
  name         = "${local.prefix}-indicator-state"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pk"
  range_key = "asOf"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "asOf"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}

# Phase 5a: embedding-cache — stores article embedding vectors for cosine-similarity dedup.
# Kept separate from news-events because each vector is 1536 floats (text-embedding-3-small)
# and not all consumers need it. TTL = 24 h (set by the enrichment Lambda).
resource "aws_dynamodb_table" "embedding_cache" {
  name         = "${local.prefix}-embedding-cache"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "articleId"

  attribute {
    name = "articleId"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}

# v6 P2 / P2.2 correction: signals-v2 schema migrated from emittedAt#signalId SK to
# deterministic tf#closeTime SK. This enables:
#   - Atomic idempotent dedup via conditional Put (attribute_not_exists(pair))
#   - "Latest signal for pair X on timeframe 15m" via begins_with(SK, "15m#") +
#     ScanIndexForward=false + Limit=1 (filter applied DURING index walk, not after).
#
# Migration approach: Option A (drop+recreate). Acceptable in dev (pre-prod).
# Coordinate with team before deploying to prod — a separate migration task will
# backfill or drain the old table before destroying it.
#
# PK: pair  SK: tf#closeTime  (e.g. "15m#1715187600000")
# TTL: 90 days
resource "aws_dynamodb_table" "signals_v2" {
  name         = "${local.prefix}-signals-v2"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "sk" # composite: "{tf}#{closeTime}"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
