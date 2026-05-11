# Phase 7/8: calibration-params table
#
# Stores Platt scaling coefficients (per pair/timeframe) and Kelly stats
# (per pair/timeframe/direction). Written by the calibration-job Lambda
# (daily @ 04:00 UTC); read by the indicator-handler Lambda on every emit
# (Platt) and by the API Lambda on every getSignalForUser (Kelly).
#
# Schema:
#   PK: pk (S)  —  "platt#{pair}#{TF}"             (Platt rows)
#                  "kelly#{pair}#{TF}#{direction}" (Kelly rows)
#
# Hash-only — no SK. Row count is small and bounded
# (PAIRS × {15m,1h,4h,1d} for Platt; PAIRS × {15m,1h,4h,1d} × {buy,sell}
# for Kelly), so a single-partition Query pattern is unnecessary.
#
# No TTL — calibration params are reference data. The job re-fits daily
# so rows are naturally overwritten.

resource "aws_dynamodb_table" "calibration_params" {
  name         = "${local.prefix}-calibration-params"
  billing_mode = "PAY_PER_REQUEST"

  server_side_encryption {
    enabled = true
  }

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}
