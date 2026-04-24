# ---------------------------------------------------------------------------
# Fargate Ingestion Service — persistent WebSocket streaming + news polling
# ---------------------------------------------------------------------------

# ===========================================================================
# VPC (minimal — public subnets only, no NAT gateway)
# ===========================================================================

resource "aws_vpc" "ingestion" {
  cidr_block           = "10.1.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.prefix}-ingestion-vpc" }
}

resource "aws_internet_gateway" "ingestion" {
  vpc_id = aws_vpc.ingestion.id
  tags   = { Name = "${local.prefix}-ingestion-igw" }
}

resource "aws_subnet" "ingestion_a" {
  vpc_id                  = aws_vpc.ingestion.id
  cidr_block              = "10.1.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = { Name = "${local.prefix}-ingestion-a" }
}

resource "aws_subnet" "ingestion_b" {
  vpc_id                  = aws_vpc.ingestion.id
  cidr_block              = "10.1.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = { Name = "${local.prefix}-ingestion-b" }
}

resource "aws_route_table" "ingestion" {
  vpc_id = aws_vpc.ingestion.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.ingestion.id
  }

  tags = { Name = "${local.prefix}-ingestion-rt" }
}

resource "aws_route_table_association" "ingestion_a" {
  subnet_id      = aws_subnet.ingestion_a.id
  route_table_id = aws_route_table.ingestion.id
}

resource "aws_route_table_association" "ingestion_b" {
  subnet_id      = aws_subnet.ingestion_b.id
  route_table_id = aws_route_table.ingestion.id
}

resource "aws_security_group" "ingestion_ecs" {
  name_prefix = "${local.prefix}-ingestion-ecs-"
  vpc_id      = aws_vpc.ingestion.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.prefix}-ingestion-ecs-sg" }
}

# ===========================================================================
# ECS Cluster + ECR
# ===========================================================================

resource "aws_ecs_cluster" "ingestion" {
  name = "${local.prefix}-ingestion"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = { Name = "${local.prefix}-ingestion-cluster" }
}

resource "aws_ecr_repository" "ingestion" {
  name                 = "${local.prefix}-ingestion"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = { Name = "${local.prefix}-ingestion" }
}

# ===========================================================================
# IAM — Execution Role + Task Role
# ===========================================================================

resource "aws_iam_role" "ingestion_ecs_execution" {
  name = "${local.prefix}-ingestion-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ingestion_ecs_execution" {
  role       = aws_iam_role.ingestion_ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ingestion_ecs_execution_alpaca_ssm" {
  name = "${local.prefix}-ingestion-ecs-execution-alpaca-ssm"
  role = aws_iam_role.ingestion_ecs_execution.id

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

resource "aws_iam_role" "ingestion_ecs_task" {
  name = "${local.prefix}-ingestion-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "ingestion_ecs_dynamodb" {
  name = "${local.prefix}-ingestion-ecs-dynamodb"
  role = aws_iam_role.ingestion_ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
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

resource "aws_iam_role_policy" "ingestion_ecs_cloudwatch" {
  name = "${local.prefix}-ingestion-ecs-cloudwatch"
  role = aws_iam_role.ingestion_ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.ingestion_stream.arn}:*"
    }]
  })
}

resource "aws_iam_role_policy" "ingestion_ecs_sqs" {
  name = "${local.prefix}-ingestion-ecs-sqs"
  role = aws_iam_role.ingestion_ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["sqs:SendMessage"]
      Resource = [
        aws_sqs_queue.enrichment.arn,
        aws_sqs_queue.market_events.arn,
      ]
    }]
  })
}

# ===========================================================================
# CloudWatch Log Group
# ===========================================================================

resource "aws_cloudwatch_log_group" "ingestion_stream" {
  name              = "/ecs/${local.prefix}-ingestion"
  retention_in_days = 30
}

# ===========================================================================
# ECS Task Definition + Service
# ===========================================================================

resource "aws_ecs_task_definition" "ingestion" {
  family                   = "${local.prefix}-ingestion"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.fargate_cpu)
  memory                   = tostring(var.fargate_memory)
  execution_role_arn       = aws_iam_role.ingestion_ecs_execution.arn
  task_role_arn            = aws_iam_role.ingestion_ecs_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "ingestion"
    image     = "${aws_ecr_repository.ingestion.repository_url}:latest"
    essential = true

    portMappings = [{
      containerPort = 8080
      hostPort      = 8080
      protocol      = "tcp"
    }]

    environment = [
      { name = "ENVIRONMENT", value = var.environment },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "TABLE_PREFIX", value = "${local.prefix}-" },
      { name = "TABLE_PRICES", value = aws_dynamodb_table.prices.name },
      { name = "TABLE_CANDLES", value = aws_dynamodb_table.candles.name },
      { name = "TABLE_NEWS_EVENTS", value = aws_dynamodb_table.news_events.name },
      { name = "TABLE_METADATA", value = aws_dynamodb_table.ingestion_metadata.name },
      { name = "ENRICHMENT_QUEUE_URL", value = aws_sqs_queue.enrichment.url },
      { name = "MARKET_EVENTS_QUEUE_URL", value = aws_sqs_queue.market_events.url },
    ]

    secrets = [
      { name = "ALPACA_KEY_ID", valueFrom = local.alpaca_ssm_param_arns[0] },
      { name = "ALPACA_SECRET_KEY", valueFrom = local.alpaca_ssm_param_arns[1] },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ingestion_stream.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_ecs_service" "ingestion" {
  name            = "${local.prefix}-ingestion"
  cluster         = aws_ecs_cluster.ingestion.id
  task_definition = aws_ecs_task_definition.ingestion.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.ingestion_a.id, aws_subnet.ingestion_b.id]
    security_groups  = [aws_security_group.ingestion_ecs.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}
