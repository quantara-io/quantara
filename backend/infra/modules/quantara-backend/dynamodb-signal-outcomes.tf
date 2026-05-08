# Phase 8: signal-outcomes table
#
# Stores resolved outcomes for each signal.
#
# Schema:
#   PK: pair (S)
#   SK: signalId (S)
#
# GSI by-rule (sparse):
#   PK: rule (S)
#   SK: createdAtSignalId (S)   — "createdAt#signalId"
#
# TTL: resolvedAt + 365 days

resource "aws_dynamodb_table" "signal_outcomes" {
  name         = "${local.prefix}-signal-outcomes"
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

  # Sparse GSI for per-rule attribution queries.
  # Only fan-out rows have the "rule" attribute populated.
  attribute {
    name = "rule"
    type = "S"
  }

  attribute {
    name = "createdAtSignalId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-rule"
    hash_key        = "rule"
    range_key       = "createdAtSignalId"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
