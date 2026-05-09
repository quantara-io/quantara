resource "aws_iam_role" "lambda" {
  name = "${local.prefix}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "${local.prefix}-dynamodb"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem",
        "dynamodb:BatchGetItem",
      ]
      Resource = [
        aws_dynamodb_table.users.arn, "${aws_dynamodb_table.users.arn}/index/*",
        aws_dynamodb_table.signals.arn, "${aws_dynamodb_table.signals.arn}/index/*",
        aws_dynamodb_table.signal_history.arn, "${aws_dynamodb_table.signal_history.arn}/index/*",
        aws_dynamodb_table.coach_sessions.arn, "${aws_dynamodb_table.coach_sessions.arn}/index/*",
        aws_dynamodb_table.coach_messages.arn,
        aws_dynamodb_table.deals.arn, "${aws_dynamodb_table.deals.arn}/index/*",
        aws_dynamodb_table.deal_interests.arn,
        aws_dynamodb_table.campaigns.arn,
        aws_dynamodb_table.signals_v2.arn, "${aws_dynamodb_table.signals_v2.arn}/index/*",
        aws_dynamodb_table.indicator_state.arn,
      ]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_bedrock" {
  name = "${local.prefix}-bedrock"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      Resource = [
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-sonnet-*",
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-haiku-*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_ssm" {
  name = "${local.prefix}-ssm"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParametersByPath", "ssm:PutParameter"]
      Resource = "arn:aws:ssm:${var.aws_region}:*:parameter/quantara/${var.environment}/*"
    }]
  })
}

# Read-only ops perms for the admin dashboard endpoints
resource "aws_iam_role_policy" "lambda_admin_ops" {
  name = "${local.prefix}-admin-ops"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:ListTasks",
          "ecs:DescribeClusters",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ]
        Resource = "arn:aws:sqs:${var.aws_region}:*:${local.prefix}-*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:DescribeLogStreams",
          "logs:GetLogEvents",
          "logs:FilterLogEvents",
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/ecs/${local.prefix}-*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "lambda:GetFunction",
          "lambda:ListFunctions",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable", "dynamodb:Scan"]
        Resource = "arn:aws:dynamodb:${var.aws_region}:*:table/${local.prefix}-*"
      },
      {
        # Read-only access for the admin Market, News, Pipeline State, and
        # Genie-metrics pages, which Query and GetItem from ingestion-owned
        # tables. Without this block, calls fail with AccessDeniedException —
        # the admin service does NOT swallow DynamoDB permission errors, so
        # the endpoints surface a 500 to the caller rather than silently
        # returning empty data.
        #
        # `sentiment_aggregates` belongs HERE (not in `lambda_dynamodb`)
        # because the API never writes to it — only the ingestion aggregator
        # writes. Having it in the over-broad statement was over-permissive
        # (Put/Update/Delete were granted unnecessarily). Same reasoning
        # applies to `ratifications` and `signal_outcomes` — admin reads
        # only, never writes.
        Effect = "Allow"
        Action = ["dynamodb:Query", "dynamodb:GetItem"]
        Resource = [
          aws_dynamodb_table.prices.arn,
          aws_dynamodb_table.candles.arn,
          aws_dynamodb_table.news_events.arn,
          aws_dynamodb_table.ingestion_metadata.arn,
          aws_dynamodb_table.signals_v2.arn,
          aws_dynamodb_table.indicator_state.arn,
          aws_dynamodb_table.sentiment_aggregates.arn,
          # Required for /api/admin/ratifications (#185 / PR #196).
          aws_dynamodb_table.ratifications.arn,
          "${aws_dynamodb_table.ratifications.arn}/index/*",
          # Genie-metrics endpoint reads these for win-rate + cost metrics.
          aws_dynamodb_table.signal_outcomes.arn,
        ]
      },
    ]
  })
}

# Build the app from source
locals {
  source_hash = sha256(join("", [
    for f in sort(fileset(var.app_source_dir, "src/**/*.ts")) :
    filesha256("${var.app_source_dir}/${f}")
  ]))
}

resource "terraform_data" "build" {
  triggers_replace = local.source_hash

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = var.app_source_dir
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${var.app_source_dir}/dist/index.js"
  output_path = "${path.module}/.build/lambda.zip"

  depends_on = [terraform_data.build]
}

resource "aws_lambda_function" "api" {
  function_name = "${local.prefix}-api"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = var.lambda_memory
  timeout       = var.lambda_timeout

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      AUTH_BASE_URL        = var.auth_base_url
      APP_ID               = var.app_id
      TABLE_PREFIX         = "${local.prefix}-"
      TABLE_USERS          = aws_dynamodb_table.users.name
      TABLE_SIGNALS        = aws_dynamodb_table.signals.name
      TABLE_SIGNAL_HISTORY = aws_dynamodb_table.signal_history.name
      TABLE_COACH_SESSIONS = aws_dynamodb_table.coach_sessions.name
      TABLE_COACH_MESSAGES = aws_dynamodb_table.coach_messages.name
      TABLE_DEALS          = aws_dynamodb_table.deals.name
      TABLE_DEAL_INTERESTS = aws_dynamodb_table.deal_interests.name
      TABLE_CAMPAIGNS        = aws_dynamodb_table.campaigns.name
      TABLE_INDICATOR_STATE  = aws_dynamodb_table.indicator_state.name
      TABLE_SIGNALS_V2       = aws_dynamodb_table.signals_v2.name
      TABLE_RATIFICATIONS    = aws_dynamodb_table.ratifications.name
      TABLE_SIGNAL_OUTCOMES  = aws_dynamodb_table.signal_outcomes.name
      CORS_ORIGIN            = var.cors_origin
      CLOUDFRONT_URL       = "https://${aws_cloudfront_distribution.api.domain_name}"
      ENVIRONMENT          = var.environment
      LOG_LEVEL            = var.log_level
      AWS_ACCOUNT_ID       = data.aws_caller_identity.current.account_id
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    terraform_data.build,
  ]
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
