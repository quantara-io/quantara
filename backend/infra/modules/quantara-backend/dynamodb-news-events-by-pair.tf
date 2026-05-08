# Phase 5b: news-events-by-pair — scalar fan-out table for the sentiment aggregator.
#
# Each enriched article produces one row per mentioned pair. This table solves the
# DynamoDB GSI limitation: array attributes (mentionedPairs[]) don't index, but a
# scalar PK (pair: "BTC") does.
#
# Schema:
#   PK: pair (S)                     e.g. "BTC"
#   SK: sk (S)                        publishedAt#articleId — time-ordered within pair
#
# TTL: 30 days. Volume: ~50 articles/day × ~2 pairs = 100 fan-out writes/day.

resource "aws_dynamodb_table" "news_events_by_pair" {
  name         = "${local.prefix}-news-events-by-pair"
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

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
