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
    users              = aws_dynamodb_table.users.name
    signals            = aws_dynamodb_table.signals.name
    signal_history     = aws_dynamodb_table.signal_history.name
    coach_sessions     = aws_dynamodb_table.coach_sessions.name
    coach_messages     = aws_dynamodb_table.coach_messages.name
    deals              = aws_dynamodb_table.deals.name
    deal_interests     = aws_dynamodb_table.deal_interests.name
    campaigns          = aws_dynamodb_table.campaigns.name
    prices             = aws_dynamodb_table.prices.name
    candles            = aws_dynamodb_table.candles.name
    news_events        = aws_dynamodb_table.news_events.name
    ingestion_metadata = aws_dynamodb_table.ingestion_metadata.name
    indicator_state    = aws_dynamodb_table.indicator_state.name
    signals_v2         = aws_dynamodb_table.signals_v2.name
    embedding_cache        = aws_dynamodb_table.embedding_cache.name
    sentiment_aggregates   = aws_dynamodb_table.sentiment_aggregates.name
  }
}

output "data_archive_bucket" {
  value = aws_s3_bucket.data_archive.id
}

output "backfill_function_name" {
  value = aws_lambda_function.backfill.function_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.ingestion.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.ingestion.name
}

output "ecs_service_name" {
  value = aws_ecs_service.ingestion.name
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.api.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.api.id
}

output "sqs_queue_urls" {
  value = {
    enrichment    = aws_sqs_queue.enrichment.url
    market_events = aws_sqs_queue.market_events.url
    enriched_news = aws_sqs_queue.enriched_news.url
  }
}
