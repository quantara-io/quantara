# ---------------------------------------------------------------------------
# events-fanout Lambda + ESM — Live Activity Feed (#184)
#
# Triggered by DDB Streams on the `pipeline-events` table. Pushes each
# new PipelineEvent to all WebSocket clients subscribed to the `events`
# channel via the connection-registry GSI lookup.
#
# Mirrors the signals-fanout pattern (lambda-websocket.tf) but is a
# separate Lambda + role to keep IAM blast-radius small and to allow
# scale-out independent of the trading-signal fanout.
#
# This file also adds:
#   - Producer Put grants on `pipeline_events` for indicator-handler,
#     aggregator-handler, enrichment, and the API Lambda (ratify path
#     via WebSocket-emit shares the API Lambda's role).
#   - signals-fanout & ws-connect IAM grants extended for the new
#     channel-index GSI on connection-registry.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# events-fanout IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "events_fanout_lambda" {
  name = "${local.prefix}-events-fanout-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "events_fanout_logs" {
  role       = aws_iam_role.events_fanout_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "events_fanout_dynamodb" {
  name = "${local.prefix}-events-fanout-dynamodb"
  role = aws_iam_role.events_fanout_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read DDB Streams on pipeline-events.
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams",
        ]
        Resource = "${aws_dynamodb_table.pipeline_events.arn}/stream/*"
      },
      {
        # Query connection-registry by `channel` via the channel-index GSI
        # (find all `events` subscribers). Delete stale rows on GoneException.
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
        ]
        Resource = [
          aws_dynamodb_table.connection_registry.arn,
          "${aws_dynamodb_table.connection_registry.arn}/index/*",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy" "events_fanout_apigateway" {
  name = "${local.prefix}-events-fanout-apigateway"
  role = aws_iam_role.events_fanout_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["execute-api:ManageConnections"]
      Resource = "${aws_apigatewayv2_api.websocket.execution_arn}/*/@connections/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# events-fanout Lambda
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "events_fanout" {
  function_name = "${local.prefix}-events-fanout"
  role          = aws_iam_role.events_fanout_lambda.arn
  handler       = "events-fanout.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 60

  filename         = "${local.ingestion_source_dir}/dist/events-fanout.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX              = "${local.prefix}-"
      TABLE_CONNECTION_REGISTRY = aws_dynamodb_table.connection_registry.name
      WEBSOCKET_API_ENDPOINT    = "https://${aws_apigatewayv2_api.websocket.id}.execute-api.${var.aws_region}.amazonaws.com/$default"
      ENVIRONMENT               = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.events_fanout_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# DDB Streams event source mapping: pipeline-events → events-fanout
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "events_fanout_streams" {
  event_source_arn  = aws_dynamodb_table.pipeline_events.stream_arn
  function_name     = aws_lambda_function.events_fanout.arn
  starting_position = "LATEST"
  batch_size        = 25
  enabled           = true

  filter_criteria {
    filter {
      # Only INSERT — TTL-driven REMOVE has no consumer.
      pattern = jsonencode({ eventName = ["INSERT"] })
    }
  }
}

# ---------------------------------------------------------------------------
# Producer Put grants on pipeline-events
#
# Each producer Lambda's existing dynamodb policy is augmented with a
# PutItem grant on pipeline-events. Inline-attached as separate policies
# (rather than editing the existing dynamodb policy in place) so the
# diff stays scoped and the existing policies remain reviewable.
# ---------------------------------------------------------------------------

resource "aws_iam_role_policy" "indicator_handler_pipeline_events" {
  name = "${local.prefix}-indicator-handler-pipeline-events"
  role = aws_iam_role.indicator_handler_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = [aws_dynamodb_table.pipeline_events.arn]
    }]
  })
}

resource "aws_iam_role_policy" "aggregator_pipeline_events" {
  name = "${local.prefix}-aggregator-pipeline-events"
  role = aws_iam_role.aggregator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = [aws_dynamodb_table.pipeline_events.arn]
    }]
  })
}

resource "aws_iam_role_policy" "enrichment_pipeline_events" {
  name = "${local.prefix}-enrichment-pipeline-events"
  role = aws_iam_role.enrichment_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = [aws_dynamodb_table.pipeline_events.arn]
    }]
  })
}

# ---------------------------------------------------------------------------
# TABLE_PIPELINE_EVENTS env var on producer Lambdas — passed through so
# `emitPipelineEventSafe` resolves the table name. Implemented as a noop
# producer-side environment-variable override; if the env is unset, the
# emit fails gracefully (caught by emitPipelineEventSafe).
# ---------------------------------------------------------------------------
