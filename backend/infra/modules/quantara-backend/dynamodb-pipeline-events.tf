# ---------------------------------------------------------------------------
# pipeline-events DDB table — Live Activity Feed (#184)
#
# Stores PipelineEvent records (indicator-state-updated, signal-emitted,
# ratification-fired, news-enriched, sentiment-shock-detected, quorum-failed)
# emitted by the producer Lambdas. DDB Streams trigger the events-fanout
# Lambda which pushes each new record to all WebSocket clients subscribed
# to the `events` channel.
#
# PK: eventId (S) — unique per event (crypto.randomUUID())
# SK: ts      (S) — ISO-8601 timestamp (chronological sort)
# TTL: ttl    (N) — Unix seconds, 24h from write time
#
# DDB Streams enabled with NEW_IMAGE — events-fanout only needs the new
# record's payload (no diff against prior state).
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "pipeline_events" {
  name         = "${local.prefix}-pipeline-events"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "eventId"
  range_key = "ts"

  attribute {
    name = "eventId"
    type = "S"
  }

  attribute {
    name = "ts"
    type = "S"
  }

  # DDB Streams: triggers events-fanout (defined in lambda-events-fanout.tf).
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  server_side_encryption {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # PITR off — pipeline events are ephemeral (24h TTL), low recovery value.
  point_in_time_recovery { enabled = false }
}
