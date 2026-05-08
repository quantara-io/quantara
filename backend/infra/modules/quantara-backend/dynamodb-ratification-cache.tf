# Phase 6a: ratification-cache — DDB-backed cache keyed on bin-and-hash of context
# PK: cacheKey (SHA-256 hex of binned context fingerprint)
# TTL: 5 minutes (set by application; DDB sweeps within ~48h)
resource "aws_dynamodb_table" "ratification_cache" {
  name         = "${local.prefix}-ratification-cache"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "cacheKey"

  attribute {
    name = "cacheKey"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}
