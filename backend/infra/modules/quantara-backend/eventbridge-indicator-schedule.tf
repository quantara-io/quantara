# ---------------------------------------------------------------------------
# EventBridge schedule — trigger indicator-handler every minute
#
# cron(* * * * ? *) = every minute, every day.
# The handler internally detects which timeframes (15m, 1h, 4h, 1d) just closed
# within the last 60-second window and only processes those TFs.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "indicator_schedule" {
  name                = "${local.prefix}-indicator-schedule"
  description         = "Trigger indicator handler every minute for TF-close detection"
  schedule_expression = "cron(* * * * ? *)"
}

resource "aws_cloudwatch_event_target" "indicator_handler" {
  rule = aws_cloudwatch_event_rule.indicator_schedule.name
  arn  = aws_lambda_function.indicator_handler.arn
}

resource "aws_lambda_permission" "allow_eventbridge_indicator" {
  statement_id  = "AllowEventBridgeIndicator"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.indicator_handler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.indicator_schedule.arn
}
