# Phase 5b: aggregator-handler Lambda
#
# Two trigger paths:
#   1. SQS event source mapping — enriched_news queue → recompute per (pair, window)
#   2. EventBridge schedule — every 5 minutes — fallback recompute for all pairs

# ---------------------------------------------------------------------------
# IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "aggregator_lambda" {
  name = "${local.prefix}-aggregator-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "aggregator_logs" {
  role       = aws_iam_role.aggregator_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "aggregator_dynamodb" {
  name = "${local.prefix}-aggregator-dynamodb"
  role = aws_iam_role.aggregator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:Query",
        "dynamodb:GetItem",
      ]
      Resource = [
        aws_dynamodb_table.news_events_by_pair.arn,
      ]
    },
    {
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
      ]
      Resource = [
        aws_dynamodb_table.sentiment_aggregates.arn,
      ]
    },
    {
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
      ]
      Resource = [
        aws_dynamodb_table.ingestion_metadata.arn,
      ]
    }]
  })
}

resource "aws_iam_role_policy" "aggregator_sqs" {
  name = "${local.prefix}-aggregator-sqs"
  role = aws_iam_role.aggregator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
      ]
      Resource = aws_sqs_queue.enriched_news.arn
    }]
  })
}

# ---------------------------------------------------------------------------
# Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "aggregator" {
  function_name = "${local.prefix}-aggregator"
  role          = aws_iam_role.aggregator_lambda.arn
  handler       = "aggregator-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 300

  filename         = "${local.ingestion_source_dir}/dist/aggregator-handler.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX                = "${local.prefix}-"
      TABLE_SENTIMENT_AGGREGATES  = aws_dynamodb_table.sentiment_aggregates.name
      TABLE_NEWS_EVENTS_BY_PAIR   = aws_dynamodb_table.news_events_by_pair.name
      TABLE_METADATA              = aws_dynamodb_table.ingestion_metadata.name
      ENVIRONMENT                 = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.aggregator_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# SQS event source mapping — enriched_news → aggregator
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "aggregator_enriched_news" {
  event_source_arn = aws_sqs_queue.enriched_news.arn
  function_name    = aws_lambda_function.aggregator.arn
  batch_size       = 10
  enabled          = true
}

# ---------------------------------------------------------------------------
# EventBridge schedule — 5-minute fallback
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "aggregator_schedule" {
  name                = "${local.prefix}-aggregator-schedule"
  description         = "Fallback: recompute sentiment aggregates every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "aggregator_lambda" {
  rule = aws_cloudwatch_event_rule.aggregator_schedule.name
  arn  = aws_lambda_function.aggregator.arn
}

# depends_on + replace_triggered_by mirror the pattern established in
# lambda-higher-tf-poller.tf (issues #260 and #289): when the Lambda is
# replaced the old resource policy is wiped; both resources must be destroyed
# and recreated in the same apply to keep EventBridge invoke access intact.
resource "aws_lambda_permission" "aggregator_eventbridge" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.aggregator.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.aggregator_schedule.arn

  depends_on = [aws_lambda_function.aggregator]

  lifecycle {
    replace_triggered_by = [aws_lambda_function.aggregator]
  }
}
