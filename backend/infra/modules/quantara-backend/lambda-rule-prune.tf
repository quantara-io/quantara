# Phase 8 §10.10: rule-prune Lambda
#
# Scheduled daily via EventBridge.
# Scans rule_attribution (90d window), computes per-(rule, pair, TF) Brier,
# and writes lifecycle status to rule_status.
#
# Harmless when run with an empty rule_attribution table — only acts on
# buckets with n >= 30 resolved signals.

# ---------------------------------------------------------------------------
# IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "rule_prune_lambda" {
  name = "${local.prefix}-rule-prune-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rule_prune_logs" {
  role       = aws_iam_role.rule_prune_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "rule_prune_dynamodb" {
  name = "${local.prefix}-rule-prune-dynamodb"
  role = aws_iam_role.rule_prune_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read rule_attribution (Scan for all 90d-window rows).
        Effect = "Allow"
        Action = [
          "dynamodb:Scan",
          "dynamodb:GetItem",
        ]
        Resource = [
          aws_dynamodb_table.rule_attribution.arn,
        ]
      },
      {
        # Read signal_outcomes via by-rule GSI to compute per-rule Brier.
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.signal_outcomes.arn,
          "${aws_dynamodb_table.signal_outcomes.arn}/index/*",
        ]
      },
      {
        # Read + write rule_status (lifecycle decisions).
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Scan",
        ]
        Resource = [
          aws_dynamodb_table.rule_status.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "rule_prune" {
  function_name = "${local.prefix}-rule-prune"
  role          = aws_iam_role.rule_prune_lambda.arn
  handler       = "rule-prune-handler.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 300 # 5 min — scans ≤560 rows + Brier queries per bucket

  filename         = "${local.ingestion_source_dir}/dist/rule-prune.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX           = "${local.prefix}-"
      TABLE_RULE_ATTRIBUTION = aws_dynamodb_table.rule_attribution.name
      TABLE_SIGNAL_OUTCOMES  = aws_dynamodb_table.signal_outcomes.name
      TABLE_RULE_STATUS      = aws_dynamodb_table.rule_status.name
      ENVIRONMENT            = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.rule_prune_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# EventBridge schedule — daily at 02:00 UTC
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "rule_prune_schedule" {
  name                = "${local.prefix}-rule-prune-schedule"
  description         = "Trigger rule-prune Lambda daily to auto-disable/re-enable rules with sustained Brier > 0.30"
  schedule_expression = "cron(0 2 * * ? *)"
}

resource "aws_cloudwatch_event_target" "rule_prune_lambda" {
  rule = aws_cloudwatch_event_rule.rule_prune_schedule.name
  arn  = aws_lambda_function.rule_prune.arn
}

# depends_on + replace_triggered_by mirror the pattern from lambda-outcome-handler.tf:
# when the Lambda is replaced the old resource policy is wiped; both resources must
# be destroyed and recreated in the same apply to keep EventBridge invoke access intact.
resource "aws_lambda_permission" "allow_eventbridge_rule_prune" {
  statement_id  = "AllowEventBridgeRulePrune"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rule_prune.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.rule_prune_schedule.arn

  depends_on = [aws_lambda_function.rule_prune]

  lifecycle {
    replace_triggered_by = [aws_lambda_function.rule_prune]
  }
}
