# ---------------------------------------------------------------------------
# connection-registry DDB table — WebSocket push channel (§16, design v6)
#
# Stores active WebSocket connection metadata.
# PK: connectionId (API Gateway WebSocket connection ID, unique per connection)
# TTL: 2h max session — API Gateway closes connections after 2h anyway.
#
# Per-channel GSI (`channel-index`) added in #184: events-fanout queries
# this index once per PipelineEvent (~100/min steady-state) instead of a
# full-table Scan. signals-fanout still scans (lower rate, scoped by
# `subscribedPairs` FilterExpression). Inverted per-pair subscription
# table for signals at scale is deferred per §16.7.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "connection_registry" {
  name         = "${local.prefix}-connection-registry"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "connectionId"

  attribute {
    name = "connectionId"
    type = "S"
  }

  attribute {
    name = "channel"
    type = "S"
  }

  global_secondary_index {
    name            = "channel-index"
    hash_key        = "channel"
    projection_type = "ALL"
  }

  server_side_encryption {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # PITR off — connection records are ephemeral (2h TTL) and have no recovery value.
  point_in_time_recovery { enabled = false }
}
