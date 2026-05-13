# ---------------------------------------------------------------------------
# Fargate Backtest Runner — pulls jobs from backtest-jobs SQS queue,
# runs the Phase 1-3 harness, writes artifacts to S3, updates backtest-runs
# DDB table with status + metrics.
#
# Architecture: single-task pool, 1 vCPU / 2 GB, scale-on-queue-depth
# (0 → 5), idle scale-to-zero.
#
# Shares the VPC / subnets / security-group from ingestion-fargate.tf.
# Shares the ECS cluster from ingestion-fargate.tf (quantara-{env}-ingestion).
#
# Issue #371.
# ---------------------------------------------------------------------------

# ===========================================================================
# ECR repository for the runner image
# ===========================================================================

resource "aws_ecr_repository" "backtest_runner" {
  name                 = "${local.prefix}-backtest-runner"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = { Name = "${local.prefix}-backtest-runner" }
}

# ===========================================================================
# IAM — execution role (for ECS agent to pull image + write logs)
# ===========================================================================

resource "aws_iam_role" "backtest_runner_execution" {
  name = "${local.prefix}-backtest-runner-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backtest_runner_execution" {
  role       = aws_iam_role.backtest_runner_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ===========================================================================
# IAM — task role (what the runner container can do)
# ===========================================================================

resource "aws_iam_role" "backtest_runner_task" {
  name = "${local.prefix}-backtest-runner-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# Read candles (live) + candles-archive (historical) for backtest input.
resource "aws_iam_role_policy" "backtest_runner_dynamodb_read" {
  name = "${local.prefix}-backtest-runner-ddb-read"
  role = aws_iam_role.backtest_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:BatchGetItem",
      ]
      Resource = [
        aws_dynamodb_table.candles.arn,
        "${aws_dynamodb_table.candles.arn}/index/*",
        aws_dynamodb_table.candles_archive.arn,
        "${aws_dynamodb_table.candles_archive.arn}/index/*",
        aws_dynamodb_table.ratifications.arn,
        "${aws_dynamodb_table.ratifications.arn}/index/*",
      ]
    }]
  })
}

# Write backtest-runs status + metrics rows.
resource "aws_iam_role_policy" "backtest_runner_dynamodb_write" {
  name = "${local.prefix}-backtest-runner-ddb-write"
  role = aws_iam_role.backtest_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ]
      Resource = [
        aws_dynamodb_table.backtest_runs.arn,
      ]
    }]
  })
}

# Write artifacts to the backtest-results S3 bucket.
resource "aws_iam_role_policy" "backtest_runner_s3" {
  name = "${local.prefix}-backtest-runner-s3"
  role = aws_iam_role.backtest_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = "${aws_s3_bucket.backtest_results.arn}/*"
    }]
  })
}

# Consume messages from the backtest-jobs queue.
resource "aws_iam_role_policy" "backtest_runner_sqs" {
  name = "${local.prefix}-backtest-runner-sqs"
  role = aws_iam_role.backtest_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility",
      ]
      Resource = aws_sqs_queue.backtest_jobs.arn
    }]
  })
}

# Invoke Bedrock for ratificationMode=replay-bedrock runs.
resource "aws_iam_role_policy" "backtest_runner_bedrock" {
  name = "${local.prefix}-backtest-runner-bedrock"
  role = aws_iam_role.backtest_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      Resource = [
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-haiku-*",
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-sonnet-*",
        "arn:aws:bedrock:${var.aws_region}:*:inference-profile/us.anthropic.claude-haiku-*",
        "arn:aws:bedrock:${var.aws_region}:*:inference-profile/us.anthropic.claude-sonnet-*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-*",
      ]
    }]
  })
}

# CloudWatch Logs write access.
resource "aws_iam_role_policy" "backtest_runner_cloudwatch" {
  name = "${local.prefix}-backtest-runner-cw"
  role = aws_iam_role.backtest_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.backtest_runner.arn}:*"
    }]
  })
}

# ===========================================================================
# CloudWatch Log Group
# ===========================================================================

resource "aws_cloudwatch_log_group" "backtest_runner" {
  name              = "/ecs/${local.prefix}-backtest-runner"
  retention_in_days = 30
}

# ===========================================================================
# ECS Task Definition
# ===========================================================================

resource "aws_ecs_task_definition" "backtest_runner" {
  family                   = "${local.prefix}-backtest-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # 1 vCPU = 1024 CPU units; 2 GB memory = 2048 MB
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.backtest_runner_execution.arn
  task_role_arn            = aws_iam_role.backtest_runner_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "backtest-runner"
    image     = "${aws_ecr_repository.backtest_runner.repository_url}:latest"
    essential = true

    environment = [
      { name = "ENVIRONMENT", value = var.environment },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "TABLE_PREFIX", value = "${local.prefix}-" },
      { name = "TABLE_CANDLES", value = aws_dynamodb_table.candles.name },
      { name = "TABLE_CANDLES_ARCHIVE", value = aws_dynamodb_table.candles_archive.name },
      { name = "TABLE_RATIFICATIONS", value = aws_dynamodb_table.ratifications.name },
      { name = "TABLE_BACKTEST_RUNS", value = aws_dynamodb_table.backtest_runs.name },
      { name = "BACKTEST_JOBS_QUEUE_URL", value = aws_sqs_queue.backtest_jobs.url },
      { name = "BACKTEST_RESULTS_BUCKET", value = aws_s3_bucket.backtest_results.id },
      { name = "RATIFICATION_MODEL_ID", value = var.environment == "prod" ? "us.anthropic.claude-sonnet-4-6" : "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.backtest_runner.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

# ===========================================================================
# ECS Service (desired_count=0 at rest; autoscaling brings it up)
# ===========================================================================

resource "aws_ecs_service" "backtest_runner" {
  name            = "${local.prefix}-backtest-runner"
  cluster         = aws_ecs_cluster.ingestion.id
  task_definition = aws_ecs_task_definition.backtest_runner.arn
  # Idle count is 0 — autoscaling raises it when messages arrive.
  desired_count = 0
  launch_type   = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.ingestion_a.id, aws_subnet.ingestion_b.id]
    security_groups  = [aws_security_group.ingestion_ecs.id]
    assign_public_ip = true
  }
}

# ===========================================================================
# Application Auto Scaling — scale on SQS queue depth (0 → 5 tasks)
# ===========================================================================

resource "aws_appautoscaling_target" "backtest_runner" {
  max_capacity       = 5
  min_capacity       = 0
  resource_id        = "service/${aws_ecs_cluster.ingestion.name}/${aws_ecs_service.backtest_runner.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "backtest_runner_scale_up" {
  name               = "${local.prefix}-backtest-runner-scale-up"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.backtest_runner.resource_id
  scalable_dimension = aws_appautoscaling_target.backtest_runner.scalable_dimension
  service_namespace  = aws_appautoscaling_target.backtest_runner.service_namespace

  step_scaling_policy_configuration {
    adjustment_type          = "ExactCapacity"
    cooldown                 = 60
    metric_aggregation_type  = "Maximum"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "backtest_jobs_not_empty" {
  alarm_name          = "${local.prefix}-backtest-jobs-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Backtest jobs queue has messages — scale up runner"

  dimensions = {
    QueueName = aws_sqs_queue.backtest_jobs.name
  }

  alarm_actions = [aws_appautoscaling_policy.backtest_runner_scale_up.arn]
}

resource "aws_appautoscaling_policy" "backtest_runner_scale_down" {
  name               = "${local.prefix}-backtest-runner-scale-down"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.backtest_runner.resource_id
  scalable_dimension = aws_appautoscaling_target.backtest_runner.scalable_dimension
  service_namespace  = aws_appautoscaling_target.backtest_runner.service_namespace

  step_scaling_policy_configuration {
    adjustment_type          = "ExactCapacity"
    cooldown                 = 300
    metric_aggregation_type  = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = 0
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "backtest_jobs_empty" {
  alarm_name          = "${local.prefix}-backtest-jobs-empty"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Backtest jobs queue is empty — scale runner to zero"

  dimensions = {
    QueueName = aws_sqs_queue.backtest_jobs.name
  }

  alarm_actions = [aws_appautoscaling_policy.backtest_runner_scale_down.arn]
}
