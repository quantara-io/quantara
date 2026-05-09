# ---------------------------------------------------------------------------
# WebSocket Lambdas — realtime push channel (design v6, §16)
#
# Three functions share the ingestion_source_dir build artifact:
#   ws-connect-handler    → $connect route (JWT verify + registry write)
#   ws-disconnect-handler → $disconnect route (registry delete)
#   signals-fanout        → DDB Streams on signals table (fanout to WebSocket connections)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# ws-connect IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ws_connect_lambda" {
  name = "${local.prefix}-ws-connect-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ws_connect_logs" {
  role       = aws_iam_role.ws_connect_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ws_connect_dynamodb" {
  name = "${local.prefix}-ws-connect-dynamodb"
  role = aws_iam_role.ws_connect_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
      ]
      Resource = [aws_dynamodb_table.connection_registry.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ws_connect_ssm" {
  name = "${local.prefix}-ws-connect-ssm"
  role = aws_iam_role.ws_connect_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParametersByPath"]
      Resource = "arn:aws:ssm:${var.aws_region}:*:parameter/quantara/${var.environment}/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# ws-connect Lambda
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "ws_connect" {
  function_name = "${local.prefix}-ws-connect"
  role          = aws_iam_role.ws_connect_lambda.arn
  handler       = "ws-connect-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 10

  filename         = "${local.ingestion_source_dir}/dist/ws-connect-handler.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX              = "${local.prefix}-"
      TABLE_CONNECTION_REGISTRY = aws_dynamodb_table.connection_registry.name
      AUTH_BASE_URL             = var.auth_base_url
      APP_ID                    = var.app_id
      ENVIRONMENT               = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.ws_connect_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# ws-disconnect IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ws_disconnect_lambda" {
  name = "${local.prefix}-ws-disconnect-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ws_disconnect_logs" {
  role       = aws_iam_role.ws_disconnect_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ws_disconnect_dynamodb" {
  name = "${local.prefix}-ws-disconnect-dynamodb"
  role = aws_iam_role.ws_disconnect_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
      ]
      Resource = [aws_dynamodb_table.connection_registry.arn]
    }]
  })
}

# ---------------------------------------------------------------------------
# ws-disconnect Lambda
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "ws_disconnect" {
  function_name = "${local.prefix}-ws-disconnect"
  role          = aws_iam_role.ws_disconnect_lambda.arn
  handler       = "ws-disconnect-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 10

  filename         = "${local.ingestion_source_dir}/dist/ws-disconnect-handler.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX              = "${local.prefix}-"
      TABLE_CONNECTION_REGISTRY = aws_dynamodb_table.connection_registry.name
      ENVIRONMENT               = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.ws_disconnect_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# signals-fanout IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "signals_fanout_lambda" {
  name = "${local.prefix}-signals-fanout-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "signals_fanout_logs" {
  role       = aws_iam_role.signals_fanout_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "signals_fanout_dynamodb" {
  name = "${local.prefix}-signals-fanout-dynamodb"
  role = aws_iam_role.signals_fanout_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read DDB Streams on the ratified signals table.
        # IMPORTANT: this is the signals table, NOT signals-v2 (per P2.1 correction).
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams",
        ]
        Resource = "${aws_dynamodb_table.signals.arn}/stream/*"
      },
      {
        # Scan + read connection-registry (find subscribers for a pair).
        # Delete stale rows on GoneException.
        Effect = "Allow"
        Action = [
          "dynamodb:Scan",
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
        ]
        Resource = [aws_dynamodb_table.connection_registry.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy" "signals_fanout_apigateway" {
  name = "${local.prefix}-signals-fanout-apigateway"
  role = aws_iam_role.signals_fanout_lambda.id

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
# signals-fanout Lambda
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "signals_fanout" {
  function_name = "${local.prefix}-signals-fanout"
  role          = aws_iam_role.signals_fanout_lambda.arn
  handler       = "signals-fanout.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 60

  filename         = "${local.ingestion_source_dir}/dist/signals-fanout.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX              = "${local.prefix}-"
      TABLE_CONNECTION_REGISTRY = aws_dynamodb_table.connection_registry.name
      # The WebSocket management endpoint for postToConnection calls.
      # Format: https://<api-id>.execute-api.<region>.amazonaws.com/$default
      WEBSOCKET_API_ENDPOINT = "https://${aws_apigatewayv2_api.websocket.id}.execute-api.${var.aws_region}.amazonaws.com/$default"
      ENVIRONMENT            = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.signals_fanout_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# DDB Streams event source mapping: signals → signals-fanout
#
# IMPORTANT: subscribe to aws_dynamodb_table.signals (ratified user-facing table),
# NOT signals-v2 (pre-ratification compute table). See P2.1 correction in issue #116.
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "signals_fanout_streams" {
  event_source_arn  = aws_dynamodb_table.signals.stream_arn
  function_name     = aws_lambda_function.signals_fanout.arn
  starting_position = "LATEST"
  batch_size        = 10
  enabled           = true

  filter_criteria {
    filter {
      # Only process INSERT events — fanout only pushes new ratified signals.
      # UPDATE (re-ratification) is deferred to v2 per §16 / out-of-scope.
      pattern = jsonencode({ eventName = ["INSERT"] })
    }
  }
}
