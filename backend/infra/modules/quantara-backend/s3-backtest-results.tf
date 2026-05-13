# ---------------------------------------------------------------------------
# S3 — backtest-results bucket
#
# Stores per-run artifacts under s3://quantara-{env}-backtest-results/{runId}/:
#   summary.md, metrics.json, trades.csv, equity-curve.csv,
#   per-rule-attribution.csv, calibration-by-bin.csv
#
# Lifecycle: objects expire after 90 days (matches backtest-runs TTL).
#
# Issue #371.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "backtest_results" {
  bucket = "${local.prefix}-backtest-results"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backtest_results" {
  bucket = aws_s3_bucket.backtest_results.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backtest_results" {
  bucket = aws_s3_bucket.backtest_results.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backtest_results" {
  bucket = aws_s3_bucket.backtest_results.id

  rule {
    id     = "backtest-90d-expiry"
    status = "Enabled"

    expiration {
      days = 90
    }

    # Also expire incomplete multipart uploads after 7 days to avoid orphaned
    # part storage from failed runner uploads.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
