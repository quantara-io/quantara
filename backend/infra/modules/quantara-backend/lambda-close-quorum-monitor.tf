# ---------------------------------------------------------------------------
# close-quorum-monitor Lambda — v6 P2 design §11.5
#
# Triggered by DDB Streams REMOVE events on the close-quorum table (TTL expiry).
# For each expired quorum row, checks whether a corresponding signal was written
# to signals-v2. If not, emits a CloseMissed CloudWatch metric.
#
# This Lambda is observability-only — it never writes to the candles or signals
# tables. Failures do not block signal production.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "close_quorum_monitor_lambda" {
  name = "${local.prefix}-close-quorum-monitor-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "close_quorum_monitor_logs" {
  role       = aws_iam_role.close_quorum_monitor_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "close_quorum_monitor_policy" {
  name = "${local.prefix}-close-quorum-monitor-policy"
  role = aws_iam_role.close_quorum_monitor_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadCloseQuorumStream"
        Effect = "Allow"
        Action = [
          "dynamodb:GetShardIterator",
          "dynamodb:GetRecords",
          "dynamodb:ListStreams",
          "dynamodb:DescribeStream",
        ]
        Resource = [
          aws_dynamodb_table.close_quorum.stream_arn,
        ]
      },
      {
        Sid    = "ReadSignalsV2"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.signals_v2.arn,
        ]
      },
      # Metrics are emitted via CloudWatch Embedded Metric Format (EMF) — structured
      # JSON written to stdout. CloudWatch Logs ingests these automatically without
      # requiring cloudwatch:PutMetricData permission. No explicit CW IAM needed.
    ]
  })
}

resource "aws_lambda_function" "close_quorum_monitor" {
  function_name = "${local.prefix}-close-quorum-monitor"
  role          = aws_iam_role.close_quorum_monitor_lambda.arn
  handler       = "close-quorum-monitor.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 30

  filename         = "${local.ingestion_source_dir}/dist/close-quorum-monitor.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX     = "${local.prefix}-"
      TABLE_SIGNALS_V2 = aws_dynamodb_table.signals_v2.name
      CW_NAMESPACE     = "Quantara/Ingestion"
      ENVIRONMENT      = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.close_quorum_monitor_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# DDB Streams event source mapping: close-quorum REMOVE events → monitor Lambda
#
# FilterCriteria: only REMOVE events (TTL expiry).
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "close_quorum_monitor_from_stream" {
  event_source_arn  = aws_dynamodb_table.close_quorum.stream_arn
  function_name     = aws_lambda_function.close_quorum_monitor.arn
  starting_position = "LATEST"

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["REMOVE"]
      })
    }
  }

  batch_size             = 100
  maximum_retry_attempts = 0 # observability-only — don't retry; metric emission is best-effort

  depends_on = [
    aws_iam_role_policy.close_quorum_monitor_policy,
  ]
}
