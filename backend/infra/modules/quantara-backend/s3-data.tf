# ---------------------------------------------------------------------------
# S3 Data Archive — raw market data and news for replay / reprocessing
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "data_archive" {
  bucket = "${local.prefix}-data-archive"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data_archive" {
  bucket = aws_s3_bucket.data_archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "data_archive" {
  bucket = aws_s3_bucket.data_archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "data_archive" {
  bucket = aws_s3_bucket.data_archive.id

  rule {
    id     = "archive-lifecycle"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }
  }
}
