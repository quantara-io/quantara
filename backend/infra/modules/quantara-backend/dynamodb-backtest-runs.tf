# ---------------------------------------------------------------------------
# DynamoDB — backtest-runs
#
# Stores metadata for every backtest job: status, parameters, cost, and a
# pointer to S3 artifacts. Items expire after 90 days (TTL).
#
# Issue #371.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "backtest_runs" {
  name         = "${local.prefix}-backtest-runs"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "runId"

  attribute {
    name = "runId"
    type = "S"
  }

  # GSI: list all runs sorted by submission time (most recent first).
  # hash_key = "userId" keeps per-user scans efficient; "all" partition
  # key is a sentinel used by admin list queries that want ALL runs.
  attribute {
    name = "submittedAt"
    type = "S"
  }

  attribute {
    name = "listPartition"
    type = "S"
  }

  global_secondary_index {
    name            = "list-index"
    hash_key        = "listPartition"
    range_key       = "submittedAt"
    projection_type = "ALL"
  }

  # 90-day TTL
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
