resource "aws_dynamodb_table" "users" {
  name         = "${local.prefix}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "email"
    type = "S"
  }

  global_secondary_index {
    name            = "email-index"
    hash_key        = "email"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "signals" {
  name         = "${local.prefix}-signals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pair"
  range_key    = "createdAt"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "signal_history" {
  name         = "${local.prefix}-signal-history"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pair"
  range_key    = "signalId"

  attribute {
    name = "pair"
    type = "S"
  }

  attribute {
    name = "signalId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "coach_sessions" {
  name         = "${local.prefix}-coach-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "sessionId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "coach_messages" {
  name         = "${local.prefix}-coach-messages"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"
  range_key    = "messageId"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "messageId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "deals" {
  name         = "${local.prefix}-deals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "dealId"

  attribute {
    name = "dealId"
    type = "S"
  }

  attribute {
    name = "authorId"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "author-index"
    hash_key        = "authorId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "deal_interests" {
  name         = "${local.prefix}-deal-interests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "dealId"
  range_key    = "userId"

  attribute {
    name = "dealId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

resource "aws_dynamodb_table" "campaigns" {
  name         = "${local.prefix}-campaigns"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "campaignId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "campaignId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}
