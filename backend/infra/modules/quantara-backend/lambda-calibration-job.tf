# Phase 7/8: calibration-job Lambda
#
# Triggered by EventBridge daily at 04:00 UTC. For each (pair, TF) slice
# with n ≥ 50 resolved directional signals over the last 90 days:
#   1. Fit Platt scaling coefficients via Newton-Raphson.
#   2. Compute Kelly stats {p, b} per direction (buy / sell).
#   3. Persist to the calibration-params DynamoDB table.
#
# IAM scope (read access patterns in ingestion/src/calibration-job.ts before
# changing — only grant what the handler actually uses):
#   - Query  signal_outcomes               (queryOutcomesByPairTimeframe)
#   - PutItem calibration_params           (putPlattRow, putKellyRow)
#
# Notably: NO Scan on signal_outcomes (Query only by partition), NO writes to
# accuracy_aggregates (that's the outcome-handler's responsibility).

# ---------------------------------------------------------------------------
# IAM role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "calibration_job_lambda" {
  name = "${local.prefix}-calibration-job-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "calibration_job_logs" {
  role       = aws_iam_role.calibration_job_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "calibration_job_dynamodb" {
  name = "${local.prefix}-calibration-job-dynamodb"
  role = aws_iam_role.calibration_job_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "QuerySignalOutcomes"
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
        Sid    = "WriteCalibrationParams"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
        ]
        Resource = [
          aws_dynamodb_table.calibration_params.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "calibration_job" {
  function_name = "${local.prefix}-calibration-job"
  role          = aws_iam_role.calibration_job_lambda.arn
  handler       = "calibration-job.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512

  # 5 min — full sweep is PAIRS × 4 TFs × (1 Platt fit + 2 Kelly fits) =
  # ~280 Query+PutItem cycles per run. Generous bound — actual runs land
  # well under 60s once data accumulates.
  timeout = 300

  filename         = "${local.ingestion_source_dir}/dist/calibration-job.zip"
  source_code_hash = local.ingestion_source_hash

  environment {
    variables = {
      TABLE_PREFIX             = "${local.prefix}-"
      TABLE_SIGNAL_OUTCOMES    = aws_dynamodb_table.signal_outcomes.name
      TABLE_CALIBRATION_PARAMS = aws_dynamodb_table.calibration_params.name
      ENVIRONMENT              = var.environment
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.calibration_job_logs,
    terraform_data.ingestion_build,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.ingestion_build]
  }
}

# ---------------------------------------------------------------------------
# EventBridge schedule — daily at 04:00 UTC
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "calibration_job_schedule" {
  name                = "${local.prefix}-calibration-job-schedule"
  description         = "Trigger calibration job daily at 04:00 UTC to refit Platt + Kelly per (pair, TF)"
  schedule_expression = "cron(0 4 * * ? *)"
}

resource "aws_cloudwatch_event_target" "calibration_job" {
  rule = aws_cloudwatch_event_rule.calibration_job_schedule.name
  arn  = aws_lambda_function.calibration_job.arn
}

# depends_on + replace_triggered_by mirror the pattern established in
# lambda-higher-tf-poller.tf (issues #260 and #289): when the Lambda is
# replaced the old resource policy is wiped; both resources must be destroyed
# and recreated in the same apply to keep EventBridge invoke access intact.
resource "aws_lambda_permission" "allow_eventbridge_calibration_job" {
  statement_id  = "AllowEventBridgeCalibrationJob"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.calibration_job.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.calibration_job_schedule.arn

  depends_on = [aws_lambda_function.calibration_job]

  lifecycle {
    replace_triggered_by = [aws_lambda_function.calibration_job]
  }
}
