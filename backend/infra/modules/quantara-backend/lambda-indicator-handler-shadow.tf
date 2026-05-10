# ---------------------------------------------------------------------------
# Indicator Handler Shadow Lambda — Issue #133 (1m/5m data collection)
#
# Separate handler from indicator-handler to avoid accidentally writing
# 1m/5m shadow signals to signals-v2 (the production compute table).
# Cost note: 1m candles fire ~60× more frequently than 15m — this handler
# is intentionally cheap (no LLM, no fanout, no blend, no ratification).
#
# Trigger: DDB Streams on quantara-{env}-candles (FilterCriteria: source=live,
#          timeframe in [1m,5m]).
# Output:  writes to signals-collection (shadow table) only.
# IAM: read candles stream + read/write close-quorum + read/write
#      signals-collection + read/write ingestion-metadata.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "indicator_handler_shadow_lambda" {
  name = "${local.prefix}-indicator-handler-shadow-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "indicator_handler_shadow_logs" {
  role       = aws_iam_role.indicator_handler_shadow_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "indicator_handler_shadow_dynamodb" {
  name = "${local.prefix}-indicator-handler-shadow-dynamodb"
  role = aws_iam_role.indicator_handler_shadow_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadCandlesTableAndStream"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          # DDB Streams permissions for event source mapping
          "dynamodb:GetShardIterator",
          "dynamodb:GetRecords",
          "dynamodb:ListStreams",
          "dynamodb:DescribeStream",
        ]
        Resource = [
          aws_dynamodb_table.candles.arn,
          "${aws_dynamodb_table.candles.arn}/index/*",
          aws_dynamodb_table.candles.stream_arn,
        ]
      },
      {
        Sid    = "ReadWriteCloseQuorum"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
        ]
        Resource = [
          aws_dynamodb_table.close_quorum.arn,
        ]
      },
      {
        Sid    = "ReadWriteSignalsCollection"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.signals_collection.arn,
        ]
      },
      {
        Sid    = "ReadWriteIndicatorState"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.indicator_state.arn,
        ]
      },
      {
        Sid    = "ReadWriteIngestionMetadata"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
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

resource "aws_lambda_function" "indicator_handler_shadow" {
  function_name = "${local.prefix}-indicator-handler-shadow"
  role          = aws_iam_role.indicator_handler_shadow_lambda.arn
  handler       = "indicator-handler-shadow.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  # 1m/5m processing is simpler (no LLM, no blend) but fires ~60× more than
  # the production handler — keep memory modest to limit cost.
  memory_size = 256
  timeout     = 60

  filename         = "${local.ingestion_source_dir}/dist/indicator-handler-shadow.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX                = "${local.prefix}-"
      TABLE_CANDLES               = aws_dynamodb_table.candles.name
      TABLE_CLOSE_QUORUM          = aws_dynamodb_table.close_quorum.name
      TABLE_INDICATOR_STATE       = aws_dynamodb_table.indicator_state.name
      TABLE_SIGNALS_COLLECTION    = aws_dynamodb_table.signals_collection.name
      TABLE_METADATA              = aws_dynamodb_table.ingestion_metadata.name
      REQUIRED_EXCHANGE_COUNT     = local.required_exchange_count
      ENVIRONMENT                 = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.indicator_handler_shadow_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# DDB Streams event source mapping: candles → indicator_handler_shadow
#
# FilterCriteria: only fire on live 1m and 5m candles — the shadow / data-
# collection path. The existing indicator_from_candles ESM already covers
# [15m,1h,4h,1d]; these two ESMs are separate so the production handler is
# never invoked on short-TF candles.
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "indicator_shadow_from_candles" {
  event_source_arn  = aws_dynamodb_table.candles.stream_arn
  function_name     = aws_lambda_function.indicator_handler_shadow.arn
  starting_position = "LATEST"

  filter_criteria {
    filter {
      pattern = jsonencode({
        dynamodb = {
          NewImage = {
            timeframe = { S = ["1m", "5m"] }
            source    = { S = ["live"] }
          }
        }
      })
    }
  }

  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  maximum_retry_attempts             = 3

  depends_on = [
    aws_iam_role_policy.indicator_handler_shadow_dynamodb,
  ]
}
