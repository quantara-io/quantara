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
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.enriched_news_dlq.arn
    maxReceiveCount     = 3
  })
}
