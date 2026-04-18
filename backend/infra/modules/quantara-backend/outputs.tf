output "api_url" {
  value = aws_apigatewayv2_api.api.api_endpoint
}

output "lambda_function_name" {
  value = aws_lambda_function.api.function_name
}

output "lambda_function_arn" {
  value = aws_lambda_function.api.arn
}

output "table_names" {
  value = {
    users          = aws_dynamodb_table.users.name
    signals        = aws_dynamodb_table.signals.name
    signal_history = aws_dynamodb_table.signal_history.name
    coach_sessions = aws_dynamodb_table.coach_sessions.name
    coach_messages = aws_dynamodb_table.coach_messages.name
    deals          = aws_dynamodb_table.deals.name
    deal_interests = aws_dynamodb_table.deal_interests.name
    campaigns      = aws_dynamodb_table.campaigns.name
  }
}
