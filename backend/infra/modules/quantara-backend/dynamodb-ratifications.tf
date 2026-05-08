# Phase 6a: ratifications — LLM ratification audit trail
# PK: pair  SK: invokedAtRecordId (ISO8601 + UUID, ScanIndexForward=false for recent-first)
# TTL: 30 days
resource "aws_dynamodb_table" "ratifications" {
  name         = "${local.prefix}-ratifications"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key  = "pair"
  range_key = "invokedAtRecordId"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "invokedAtRecordId"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
