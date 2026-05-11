# ---------------------------------------------------------------------------
# Indicator Handler Lambda — v6 P2 (DDB Streams trigger)
#
# Trigger: DDB Streams on quantara-{env}-candles (FilterCriteria: source=live,
#          timeframe in [15m,1h,4h,1d]).
# IAM: read candles stream + read/write close-quorum + read/write signals-v2 +
#      read/write ingestion-metadata (cooldowns, dispersion history, votes, fear-greed).
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
        Sid    = "ReadWriteSignalsV2"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.signals_v2.arn,
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
      {
        Sid    = "ReadSentimentAggregates"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.sentiment_aggregates.arn,
        ]
      },
      {
        # Phase 8 Platt calibration (§10.6): indicator-handler reads
        # `platt#{pair}#{TF}` from calibration-params on every emit to apply
        # σ(a·raw + b) to the blended confidence. Read-only — the calibration
        # job (lambda-calibration-job.tf) is the sole writer.
        Sid    = "ReadCalibrationParams"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.calibration_params.arn,
        ]
      },
      {
        # Phase 8 §10.10: score.ts reads rule_status to skip auto-disabled rules.
        # listDisabledRuleKeys does a per-invocation Scan with a small projection;
        # the table has ≤280 rows so this is cheap. Read-only — only the rule-prune
        # Lambda writes to this table.
        Sid    = "ReadRuleStatus"
        Effect = "Allow"
        Action = [
          "dynamodb:Scan",
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.rule_status.arn,
        ]
      },
      {
        # Ratification path: buildSentimentBundle → recomputeSentimentAggregate
        # queries news-events-by-pair (pair + window). Without this grant every
        # emit hits AccessDenied and falls back to ratificationStatus=n/a,
        # leaving quantara-{env}-signals empty. Read-only.
        Sid    = "ReadNewsEventsByPair"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.news_events_by_pair.arn,
          "${aws_dynamodb_table.news_events_by_pair.arn}/index/*",
        ]
      },
    ]
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

  filename         = "${local.ingestion_source_dir}/dist/indicator-handler.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX          = "${local.prefix}-"
      TABLE_CANDLES         = aws_dynamodb_table.candles.name
      TABLE_CLOSE_QUORUM    = aws_dynamodb_table.close_quorum.name
      TABLE_INDICATOR_STATE = aws_dynamodb_table.indicator_state.name
      TABLE_SIGNALS_V2      = aws_dynamodb_table.signals_v2.name
      TABLE_METADATA        = aws_dynamodb_table.ingestion_metadata.name
      TABLE_RULE_STATUS     = aws_dynamodb_table.rule_status.name
      # Phase 8 Platt calibration: indicator-handler reads platt#{pair}#{TF}
      # rows on the emit path. Set explicitly so the calibration-store helper
      # in ingestion/src/calibration/calibration-store.ts doesn't fall back to
      # the TABLE_PREFIX-derived guess.
      TABLE_CALIBRATION_PARAMS  = aws_dynamodb_table.calibration_params.name
      # Ratification path: set explicitly so news-by-pair-store.ts doesn't fall
      # back to the TABLE_PREFIX-derived guess (mirrors #335 / TABLE_RULE_STATUS
      # and #333 / TABLE_CALIBRATION_PARAMS patterns).
      TABLE_NEWS_EVENTS_BY_PAIR = aws_dynamodb_table.news_events_by_pair.name
      REQUIRED_EXCHANGE_COUNT   = local.required_exchange_count
      ENVIRONMENT               = var.environment
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

# ---------------------------------------------------------------------------
# DDB Streams event source mapping: candles → indicator_handler
#
# FilterCriteria: fire on live OR live-synthesized candles with signal
# timeframes. The DDB Streams `S` filter is exact-string match — both
# values must be enumerated explicitly, NOT relied on as "anything except
# backfill". `live-synthesized` is emitted by the Kraken silent-window
# carry-forward logic in stream.ts (#224) and must vote in close-quorum
# alongside `live` candles, otherwise the 2-of-3 quorum drops to 1-of-2
# during Kraken silences.
#
# batch_size=10 and maximum_batching_window_in_seconds=1 reduce the
# number of Lambda invocations while keeping latency < ~5s.
# maximum_retry_attempts=3 limits retries for permanent Lambda errors
# (e.g. provisioned concurrency exhaustion) — DLQ should be added if
# error visibility is needed.
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "indicator_from_candles" {
  event_source_arn  = aws_dynamodb_table.candles.stream_arn
  function_name     = aws_lambda_function.indicator_handler.arn
  starting_position = "LATEST"

  filter_criteria {
    filter {
      pattern = jsonencode({
        dynamodb = {
          NewImage = {
            timeframe = { S = ["15m", "1h", "4h", "1d"] }
            source    = { S = ["live", "live-synthesized"] }
          }
        }
      })
    }
  }

  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  maximum_retry_attempts             = 3

  depends_on = [
    aws_iam_role_policy.indicator_handler_dynamodb,
  ]
}
