# ---------------------------------------------------------------------------
# higher-tf-poller Lambda — v6 design §5.9 + §12.3
#
# Produces live higher-TF candles (15m / 1h / 4h / 1d) by calling fetchOHLCV
# on each (exchange, pair, tf) combo at close-boundary minutes. Writes with
# `source: "live"` so the indicator-handler DDB Streams FilterCriteria
# (source = "live" AND timeframe in [15m,1h,4h,1d]) actually matches.
#
# Without this Lambda, the v6 design's IndicatorLambda receives zero events
# (MarketStreamManager only writes 1m; backfill writes "backfill"-tagged rows).
# ---------------------------------------------------------------------------

resource "aws_iam_role" "higher_tf_poller_lambda" {
  name = "${local.prefix}-higher-tf-poller-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "higher_tf_poller_logs" {
  role       = aws_iam_role.higher_tf_poller_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "higher_tf_poller_dynamodb" {
  name = "${local.prefix}-higher-tf-poller-policy"
  role = aws_iam_role.higher_tf_poller_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = aws_dynamodb_table.candles.arn
      },
    ]
  })
}

resource "aws_lambda_function" "higher_tf_poller" {
  function_name = "${local.prefix}-higher-tf-poller"
  role          = aws_iam_role.higher_tf_poller_lambda.arn
  handler       = "higher-tf-poller-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512
  # Up to 5 pairs × 3 exchanges × N TFs of fetchOHLCV per invocation. Each call
  # is bounded by the per-exchange 15s timeout in the handler.
  timeout = 60

  filename         = "${local.ingestion_source_dir}/dist/higher-tf-poller-handler.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX  = "${local.prefix}-"
      TABLE_CANDLES = aws_dynamodb_table.candles.name
      ENVIRONMENT   = var.environment
    }
  }
}

# Invoke once per minute. The handler internally checks which TFs (15m/1h/4h/1d)
# have a close boundary at this tick and only fetches those.
resource "aws_cloudwatch_event_rule" "higher_tf_poller_schedule" {
  name                = "${local.prefix}-higher-tf-poller-schedule"
  description         = "Trigger higher-TF candle poller every minute"
  schedule_expression = "cron(* * * * ? *)"
}

resource "aws_cloudwatch_event_target" "higher_tf_poller" {
  rule = aws_cloudwatch_event_rule.higher_tf_poller_schedule.name
  arn  = aws_lambda_function.higher_tf_poller.arn
}

resource "aws_lambda_permission" "allow_eventbridge_higher_tf_poller" {
  statement_id  = "AllowEventBridgeInvokeHigherTfPoller"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.higher_tf_poller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.higher_tf_poller_schedule.arn
}
