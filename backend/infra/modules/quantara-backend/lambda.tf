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
        # Cross-region inference profiles. Newer Anthropic models on Bedrock
        # (e.g. Sonnet 4.6+) cannot be invoked via the bare foundation-model
        # id — they return ValidationException demanding an inference profile
        # id. The `us.anthropic.*` profile routes to underlying foundation
        # models in adjacent regions, so we ALSO need foundation-model perms
        # on the wildcard region (target regions vary per AWS routing).
        "arn:aws:bedrock:${var.aws_region}:*:inference-profile/us.anthropic.claude-sonnet-*",
        "arn:aws:bedrock:${var.aws_region}:*:inference-profile/us.anthropic.claude-haiku-*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-*",
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
        # Required by GET /api/admin/pipeline-health — Lambda + ECS CloudWatch metrics
        Effect = "Allow"
        Action = [
          "cloudwatch:GetMetricStatistics",
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
        #
        # `BatchGetItem` is required for `getNewsUsage()` (PR #182), which
        # reads day-bucketed `llm_usage#YYYY-MM-DD` rows from
        # `ingestion-metadata` in a single deterministic batch instead of
        # scanning the whole table every 60s.
        #
        # The `${news_events.arn}/index/*` entry is required for the
        # `published-day-index` GSI Query introduced in #203 / used by
        # paginated `getNews()` in #201. Granting Query on the table ARN
        # alone does NOT cover its GSIs in IAM.
        Effect = "Allow"
        Action = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"]
        Resource = [
          aws_dynamodb_table.prices.arn,
          aws_dynamodb_table.candles.arn,
          # Required for the Pipeline Health page's exchange-stream
          # freshness check (admin.service.ts → getExchangeLastDataAt),
          # which Queries the `exchange-index` GSI on candles. Without
          # this, the dashboard shows every exchange as "down" because
          # the Query throws AccessDenied and the try/catch in the
          # service silently returns null. Same failure mode as #210
          # for news_events; same fix.
          "${aws_dynamodb_table.candles.arn}/index/*",
          aws_dynamodb_table.news_events.arn,
          "${aws_dynamodb_table.news_events.arn}/index/*",
          aws_dynamodb_table.ingestion_metadata.arn,
          aws_dynamodb_table.signals_v2.arn,
          aws_dynamodb_table.indicator_state.arn,
          aws_dynamodb_table.sentiment_aggregates.arn,
          # Required for /api/admin/ratifications (#185 / PR #196).
          aws_dynamodb_table.ratifications.arn,
          "${aws_dynamodb_table.ratifications.arn}/index/*",
          # Genie-metrics endpoint reads these for win-rate + cost metrics.
          aws_dynamodb_table.signal_outcomes.arn,
          # Issue #133: admin /signals-shadow endpoint reads shadow signals.
          aws_dynamodb_table.signals_collection.arn,
        ]
      },
    ]
  })
}

# Read-only perms for the Phase 8 performance API endpoints (#303):
#   GET /api/signals/history    — Queries signal_outcomes
#   GET /api/signals/accuracy   — Queries accuracy_aggregates
#   GET /api/signals/calibration — Queries signal_outcomes (on-the-fly aggregation)
#   GET /api/signals/attribution — Scans rule_attribution (~560 rows)
#
# Kept separate from lambda_dynamodb (which is read-write) to make the
# blast radius explicit: these three tables are never written from the API.
resource "aws_iam_role_policy" "lambda_signals_performance" {
  name = "${local.prefix}-signals-performance"
  role = aws_iam_role.lambda.id

  # Two statements instead of one combined Action × Resource matrix — IAM
  # treats a single statement's actions and resources as a cartesian product,
  # which would over-grant `Scan` on `signal_outcomes` and
  # `accuracy_aggregates` even though the code only Queries / GetItems them.
  # Splitting keeps each grant scoped to the action it actually needs.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Query + GetItem on the two tables the API code only Queries/Gets.
        # /history + /calibration → Query signal_outcomes.
        # /accuracy              → GetItem accuracy_aggregates.
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.signal_outcomes.arn,
          "${aws_dynamodb_table.signal_outcomes.arn}/index/*",
          aws_dynamodb_table.accuracy_aggregates.arn,
          "${aws_dynamodb_table.accuracy_aggregates.arn}/index/*",
        ]
      },
      {
        # /attribution scans rule_attribution (~560 rows max, per the
        # Terraform comment on that table). Scan is intentional here.
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:Scan",
        ]
        Resource = [
          aws_dynamodb_table.rule_attribution.arn,
          "${aws_dynamodb_table.rule_attribution.arn}/index/*",
        ]
      },
    ]
  })
}

# Write perms for the admin /debug/* endpoints (manual debug controls page,
# PR #208). These are best-effort, low-frequency operator actions:
#
#   - `inject-sentiment-shock`   → PutItem `ratifications`
#   - `replay-news-enrichment`   → PutItem `ratifications`
#   - `force-ratification` etc.  → PutItem `ratifications`
#
# Every debug endpoint also goes through `reserveIdempotency()` first, which
# does a conditional PutItem on `ingestion_metadata` keyed
# `admin-debug-idem#*` to prevent double-fires within a 60s window — so all
# of them need PutItem on metadata regardless of which target table they
# ultimately write to.
#
# Kept separate from `lambda_admin_ops` (which is read-only by intent) so a
# future reader can see that the API role's WRITE blast radius for admin
# routes is limited to these two tables on these specific endpoints.
resource "aws_iam_role_policy" "lambda_admin_debug_writes" {
  name = "${local.prefix}-admin-debug-writes"
  role = aws_iam_role.lambda.id

  # Two statements instead of one combined Action × Resource matrix — IAM
  # treats a single statement's actions and resources as a cartesian product,
  # which would over-grant (e.g. PutItem on news_events, UpdateItem on
  # ratifications) even though the code never exercises those combinations.
  # Splitting keeps each grant scoped to the action it actually needs.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Idempotency-cache PutItems (ingestion_metadata) + force-ratification
        # / inject-shock PutItems on ratifications. Pre-existing.
        Effect = "Allow"
        Action = ["dynamodb:PutItem"]
        Resource = [
          aws_dynamodb_table.ingestion_metadata.arn,
          aws_dynamodb_table.ratifications.arn,
        ]
      },
      {
        # /debug/reenrich-news resets a news_events row's status to "raw".
        # No PutItem grant on this table — the route only updates an existing
        # row's status field.
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = [aws_dynamodb_table.news_events.arn]
      },
    ]
  })
}

# SendMessage permission for /debug/reenrich-news, which re-queues news items
# onto the enrichment queue after resetting their status to raw. Kept narrow:
# SendMessage only, scoped to the single queue.
resource "aws_iam_role_policy" "lambda_admin_debug_sqs" {
  name = "${local.prefix}-admin-debug-sqs"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.enrichment.arn
    }]
  })
}

# InvokeFunction permission for /debug/force-indicators (issue #288), which
# calls the indicator-handler Lambda with a synthetic DynamoDBStreamEvent to
# recompute IndicatorState without waiting for the next live bar close.
# Scoped to the single indicator-handler ARN — no wildcard.
resource "aws_iam_role_policy" "lambda_admin_debug_invoke_indicator" {
  name = "${local.prefix}-admin-debug-invoke-indicator"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.indicator_handler.arn
    }]
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
      AUTH_BASE_URL            = var.auth_base_url
      APP_ID                   = var.app_id
      TABLE_PREFIX             = "${local.prefix}-"
      TABLE_USERS              = aws_dynamodb_table.users.name
      TABLE_SIGNALS            = aws_dynamodb_table.signals.name
      TABLE_SIGNAL_HISTORY     = aws_dynamodb_table.signal_history.name
      TABLE_COACH_SESSIONS     = aws_dynamodb_table.coach_sessions.name
      TABLE_COACH_MESSAGES     = aws_dynamodb_table.coach_messages.name
      TABLE_DEALS              = aws_dynamodb_table.deals.name
      TABLE_DEAL_INTERESTS     = aws_dynamodb_table.deal_interests.name
      TABLE_CAMPAIGNS          = aws_dynamodb_table.campaigns.name
      TABLE_INDICATOR_STATE    = aws_dynamodb_table.indicator_state.name
      TABLE_SIGNALS_V2         = aws_dynamodb_table.signals_v2.name
      TABLE_RATIFICATIONS      = aws_dynamodb_table.ratifications.name
      TABLE_SIGNAL_OUTCOMES       = aws_dynamodb_table.signal_outcomes.name
      TABLE_ACCURACY_AGGREGATES   = aws_dynamodb_table.accuracy_aggregates.name
      TABLE_RULE_ATTRIBUTION      = aws_dynamodb_table.rule_attribution.name
      TABLE_SIGNALS_COLLECTION    = aws_dynamodb_table.signals_collection.name
      CORS_ORIGIN              = var.cors_origin
      CLOUDFRONT_URL           = "https://${aws_cloudfront_distribution.api.domain_name}"
      ENVIRONMENT              = var.environment
      LOG_LEVEL                = var.log_level
      AWS_ACCOUNT_ID           = data.aws_caller_identity.current.account_id
      # Override the ratification model in dev (Haiku 4.5 — ~12x cheaper)
      # so debug iteration doesn't burn the Sonnet budget. Prod gets the
      # default (Sonnet 4.6) which matches production ratification logic.
      RATIFICATION_MODEL_ID = var.environment == "prod" ? "us.anthropic.claude-sonnet-4-6" : "us.anthropic.claude-haiku-4-5-20251001-v1:0"
      # Used by /debug/reenrich-news to re-queue items. Injected here so
      # the service code never falls back to a string-built URL that is
      # malformed when AWS_ACCOUNT_ID is unset (see PR #269 review thread).
      ENRICHMENT_QUEUE_URL = aws_sqs_queue.enrichment.url
      # Used by /debug/force-indicators (issue #288) to invoke the indicator
      # handler Lambda by name. Injected explicitly so the service never
      # constructs a function name from TABLE_PREFIX with a stale format.
      INDICATOR_HANDLER_FUNCTION_NAME = aws_lambda_function.indicator_handler.function_name
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
