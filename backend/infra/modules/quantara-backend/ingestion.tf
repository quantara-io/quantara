# ---------------------------------------------------------------------------
# Ingestion Lambda — scheduled price fetching from exchanges
# ---------------------------------------------------------------------------

locals {
  ingestion_source_dir = "${var.app_source_dir}/../ingestion"
  ingestion_source_hash = sha256(join("", [
    for f in sort(fileset(local.ingestion_source_dir, "src/**/*.ts")) :
    filesha256("${local.ingestion_source_dir}/${f}")
  ]))
}

resource "terraform_data" "ingestion_build" {
  triggers_replace = local.ingestion_source_hash

  provisioner "local-exec" {
    command     = "npm run package"
    working_dir = local.ingestion_source_dir
  }
}

resource "aws_iam_role" "ingestion_lambda" {
  name = "${local.prefix}-ingestion-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ingestion_logs" {
  role       = aws_iam_role.ingestion_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ingestion_dynamodb" {
  name = "${local.prefix}-ingestion-dynamodb"
  role = aws_iam_role.ingestion_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:Query",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
      ]
      Resource = [
        aws_dynamodb_table.prices.arn,
        "${aws_dynamodb_table.prices.arn}/index/*",
        aws_dynamodb_table.candles.arn,
        "${aws_dynamodb_table.candles.arn}/index/*",
        aws_dynamodb_table.news_events.arn,
        "${aws_dynamodb_table.news_events.arn}/index/*",
        aws_dynamodb_table.ingestion_metadata.arn,
      ]
    }]
  })
}

resource "aws_iam_role_policy" "ingestion_alpaca_ssm" {
  name = "${local.prefix}-ingestion-alpaca-ssm"
  role = aws_iam_role.ingestion_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = local.alpaca_ssm_param_arns
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = data.aws_kms_alias.ssm.target_key_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "ingestion_s3" {
  name = "${local.prefix}-ingestion-s3"
  role = aws_iam_role.ingestion_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:PutObject",
        "s3:GetObject",
      ]
      Resource = "${aws_s3_bucket.data_archive.arn}/*"
    }]
  })
}

resource "aws_lambda_function" "ingestion" {
  function_name = "${local.prefix}-ingestion"
  role          = aws_iam_role.ingestion_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 60

  filename         = "${local.ingestion_source_dir}/dist/ingestion.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX = "${local.prefix}-"
      TABLE_PRICES = aws_dynamodb_table.prices.name
      ENVIRONMENT  = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.ingestion_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# EventBridge schedule — fetch prices every 5 minutes
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "ingestion_schedule" {
  name                = "${local.prefix}-ingestion-schedule"
  description         = "Trigger price ingestion every ${var.ingestion_interval_minutes} minutes"
  schedule_expression = "rate(${var.ingestion_interval_minutes} minutes)"
}

resource "aws_cloudwatch_event_target" "ingestion_lambda" {
  rule = aws_cloudwatch_event_rule.ingestion_schedule.name
  arn  = aws_lambda_function.ingestion.arn
}

resource "aws_lambda_permission" "ingestion_eventbridge" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingestion.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ingestion_schedule.arn
}

# ---------------------------------------------------------------------------
# Backfill Lambda — historical candle data from exchange REST APIs
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "backfill" {
  function_name = "${local.prefix}-backfill"
  role          = aws_iam_role.ingestion_lambda.arn
  handler       = "backfill-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 900

  filename         = "${local.ingestion_source_dir}/dist/backfill.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX        = "${local.prefix}-"
      TABLE_CANDLES       = aws_dynamodb_table.candles.name
      TABLE_METADATA      = aws_dynamodb_table.ingestion_metadata.name
      DATA_ARCHIVE_BUCKET = aws_s3_bucket.data_archive.id
      ENVIRONMENT         = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.ingestion_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# News Backfill Lambda — historical news from CryptoPanic
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "news_backfill" {
  function_name = "${local.prefix}-news-backfill"
  role          = aws_iam_role.ingestion_lambda.arn
  handler       = "news-backfill-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 900

  filename         = "${local.ingestion_source_dir}/dist/news-backfill.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX      = "${local.prefix}-"
      TABLE_NEWS_EVENTS = aws_dynamodb_table.news_events.name
      TABLE_METADATA    = aws_dynamodb_table.ingestion_metadata.name
      ENVIRONMENT       = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.ingestion_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# Enrichment Lambda — Bedrock news sentiment analysis (SQS triggered)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "enrichment_lambda" {
  name = "${local.prefix}-enrichment-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "enrichment_logs" {
  role       = aws_iam_role.enrichment_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "enrichment_dynamodb" {
  name = "${local.prefix}-enrichment-dynamodb"
  role = aws_iam_role.enrichment_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
      ]
      Resource = [
        aws_dynamodb_table.news_events.arn,
      ]
    }]
  })
}

resource "aws_iam_role_policy" "enrichment_bedrock" {
  name = "${local.prefix}-enrichment-bedrock"
  role = aws_iam_role.enrichment_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel"]
      Resource = [
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-haiku*",
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-3-5-haiku*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "enrichment_sqs" {
  name = "${local.prefix}-enrichment-sqs"
  role = aws_iam_role.enrichment_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.enrichment.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.enriched_news.arn
      },
    ]
  })
}

resource "aws_lambda_function" "enrichment" {
  function_name = "${local.prefix}-enrichment"
  role          = aws_iam_role.enrichment_lambda.arn
  handler       = "enrichment-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300

  filename         = "${local.ingestion_source_dir}/dist/enrichment.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_NEWS_EVENTS   = aws_dynamodb_table.news_events.name
      ENRICHED_NEWS_QUEUE = aws_sqs_queue.enriched_news.url
      ENVIRONMENT         = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.enrichment_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

resource "aws_lambda_event_source_mapping" "enrichment_sqs" {
  event_source_arn = aws_sqs_queue.enrichment.arn
  function_name    = aws_lambda_function.enrichment.arn
  batch_size       = 1
  enabled          = true
}
