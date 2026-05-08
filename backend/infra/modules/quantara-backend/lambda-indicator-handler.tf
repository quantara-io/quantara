# ---------------------------------------------------------------------------
# Indicator Handler Lambda — Phase 4b
#
# Orchestrates: indicators → scoring → blending → persistence.
# Triggered by EventBridge every minute (see eventbridge-indicator-schedule.tf).
#
# IAM: read/write indicator-state, signals-v2, ingestion-metadata; read candles.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "indicator_handler_lambda" {
  name = "${local.prefix}-indicator-handler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "indicator_handler_logs" {
  role       = aws_iam_role.indicator_handler_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "indicator_handler_dynamodb" {
  name = "${local.prefix}-indicator-handler-dynamodb"
  role = aws_iam_role.indicator_handler_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem",
        "dynamodb:UpdateItem",
      ]
      Resource = [
        # Read candles (input).
        aws_dynamodb_table.candles.arn,
        "${aws_dynamodb_table.candles.arn}/index/*",
        # Write indicator state.
        aws_dynamodb_table.indicator_state.arn,
        # Write + read signals-v2 (putSignal, getLatestSignal).
        aws_dynamodb_table.signals_v2.arn,
        "${aws_dynamodb_table.signals_v2.arn}/index/*",
        # Read + write ingestion-metadata (cooldowns, dispersion history, votes, fear-greed, staleness).
        aws_dynamodb_table.ingestion_metadata.arn,
      ]
    }]
  })
}

resource "aws_lambda_function" "indicator_handler" {
  function_name = "${local.prefix}-indicator-handler"
  role          = aws_iam_role.indicator_handler_lambda.arn
  handler       = "indicator-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 60

  filename         = "${local.ingestion_source_dir}/dist/indicator-handler.js"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX         = "${local.prefix}-"
      TABLE_CANDLES        = aws_dynamodb_table.candles.name
      TABLE_INDICATOR_STATE = aws_dynamodb_table.indicator_state.name
      TABLE_SIGNALS_V2     = aws_dynamodb_table.signals_v2.name
      TABLE_METADATA       = aws_dynamodb_table.ingestion_metadata.name
      ENVIRONMENT          = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.indicator_handler_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}
