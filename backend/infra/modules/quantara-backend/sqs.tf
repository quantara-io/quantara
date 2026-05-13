# ---------------------------------------------------------------------------
# SQS Queues — decoupling ingestion from analysis
# ---------------------------------------------------------------------------

# --- Enrichment queue (raw news → Bedrock Lambda) ---

resource "aws_sqs_queue" "enrichment_dlq" {
  name                      = "${local.prefix}-enrichment-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "enrichment" {
  name                       = "${local.prefix}-enrichment"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.enrichment_dlq.arn
    maxReceiveCount     = 3
  })
}

# --- Market events queue (candle close + ticker events → analysis) ---

resource "aws_sqs_queue" "market_events_dlq" {
  name                      = "${local.prefix}-market-events-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "market_events" {
  name                       = "${local.prefix}-market-events"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.market_events_dlq.arn
    maxReceiveCount     = 3
  })
}

# --- Enriched news queue (enriched news → analysis) ---

resource "aws_sqs_queue" "enriched_news_dlq" {
  name                      = "${local.prefix}-enriched-news-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "enriched_news" {
  name                       = "${local.prefix}-enriched-news"
  visibility_timeout_seconds = 360 # must be >= Lambda timeout (300s) × 1.2
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.enriched_news_dlq.arn
    maxReceiveCount     = 3
  })
}

# --- Backtest jobs queue (admin POST → Fargate runner) ---
# Visibility timeout 3600s: a single backtest job can run up to ~1h.
# Retention 4 days. DLQ after 3 failed receive attempts.

resource "aws_sqs_queue" "backtest_jobs_dlq" {
  name                      = "${local.prefix}-backtest-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "backtest_jobs" {
  name                       = "${local.prefix}-backtest-jobs"
  visibility_timeout_seconds = 3600 # backtest may run up to 1h
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.backtest_jobs_dlq.arn
    maxReceiveCount     = 3
  })
}
