# Phase 8: outcome-handler Lambda
#
# Scheduled every 15 minutes via EventBridge.
# Resolves expired signals, computes Brier/ECE aggregates, and updates per-rule attribution.
#
# IAM: read signals-v2 + candles + ingestion-metadata;
#      read/write signal-outcomes, accuracy-aggregates, rule-attribution, ingestion-metadata.

# ---------------------------------------------------------------------------
# IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "outcome_handler_lambda" {
  name = "${local.prefix}-outcome-handler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "outcome_handler_logs" {
  role       = aws_iam_role.outcome_handler_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "outcome_handler_dynamodb" {
  name = "${local.prefix}-outcome-handler-dynamodb"
  role = aws_iam_role.outcome_handler_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read expired signals (source data).
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.signals_v2.arn,
          "${aws_dynamodb_table.signals_v2.arn}/index/*",
        ]
      },
      {
        # Read candles for canonical price lookup.
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.candles.arn,
          "${aws_dynamodb_table.candles.arn}/index/*",
        ]
      },
      {
        # Write/read outcome tables.
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:BatchWriteItem",
        ]
        Resource = [
          aws_dynamodb_table.signal_outcomes.arn,
          "${aws_dynamodb_table.signal_outcomes.arn}/index/*",
          aws_dynamodb_table.accuracy_aggregates.arn,
          aws_dynamodb_table.rule_attribution.arn,
        ]
      },
      {
        # Write/read ingestion-metadata (dedup markers).
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.ingestion_metadata.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "outcome_handler" {
  function_name = "${local.prefix}-outcome-handler"
  role          = aws_iam_role.outcome_handler_lambda.arn
  handler       = "outcome-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300 # 5 min — resolves up to 200 signals + aggregate recompute

  filename         = "${local.ingestion_source_dir}/dist/outcome-handler.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX               = "${local.prefix}-"
      TABLE_SIGNALS_V2           = aws_dynamodb_table.signals_v2.name
      TABLE_CANDLES              = aws_dynamodb_table.candles.name
      TABLE_SIGNAL_OUTCOMES      = aws_dynamodb_table.signal_outcomes.name
      TABLE_ACCURACY_AGGREGATES  = aws_dynamodb_table.accuracy_aggregates.name
      TABLE_RULE_ATTRIBUTION     = aws_dynamodb_table.rule_attribution.name
      TABLE_METADATA             = aws_dynamodb_table.ingestion_metadata.name
      ENVIRONMENT                = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.outcome_handler_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# EventBridge schedule — every 15 minutes
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "outcome_schedule" {
  name                = "${local.prefix}-outcome-schedule"
  description         = "Trigger outcome handler every 15 minutes to resolve expired signals"
  schedule_expression = "rate(15 minutes)"
}

resource "aws_cloudwatch_event_target" "outcome_handler" {
  rule = aws_cloudwatch_event_rule.outcome_schedule.name
  arn  = aws_lambda_function.outcome_handler.arn
}

resource "aws_lambda_permission" "allow_eventbridge_outcome" {
  statement_id  = "AllowEventBridgeOutcome"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.outcome_handler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.outcome_schedule.arn
}
