# ---------------------------------------------------------------------------
# API Gateway WebSocket API — realtime push channel (design v6, §16)
#
# Clients connect with:
#   wss://<endpoint>/$default?pairs=BTC%2FUSDT,ETH%2FUSDT&token=<JWT>
#
# Routes:
#   $connect    → ws-connect Lambda (JWT verify + registry write)
#   $disconnect → ws-disconnect Lambda (registry delete)
#   $default    → ws-default Lambda (no-op for v1; clients don't send messages)
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${local.prefix}-websocket"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_cloudwatch_log_group" "websocket_api_gateway" {
  name              = "/aws/apigateway/${local.prefix}-websocket"
  retention_in_days = 30
}

resource "aws_apigatewayv2_stage" "websocket_default" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    logging_level          = "INFO"
    data_trace_enabled     = false
    throttling_burst_limit = 500
    throttling_rate_limit  = 100
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.websocket_api_gateway.arn
    format = jsonencode({
      requestId    = "$context.requestId"
      connectionId = "$context.connectionId"
      eventType    = "$context.eventType"
      routeKey     = "$context.routeKey"
      status       = "$context.status"
      error        = "$context.error.message"
    })
  }
}

# ---------------------------------------------------------------------------
# $connect route
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_integration" "ws_connect" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_connect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "ws_connect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_connect.id}"
}

# depends_on + replace_triggered_by mirror the pattern established in
# lambda-higher-tf-poller.tf (issues #260 and #289): when the Lambda is
# replaced (its replace_triggered_by = [terraform_data.ingestion_build] in
# lambda-websocket.tf:91-96 will cycle the function on every source-hash
# change), the old resource policy is wiped; both this permission and the
# Lambda must be destroyed and recreated in the same apply to keep API
# Gateway invoke access intact, otherwise WebSocket clients see 5xx.
resource "aws_lambda_permission" "ws_connect_api_gateway" {
  statement_id  = "AllowWebSocketConnectAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"

  depends_on = [aws_lambda_function.ws_connect]

  lifecycle {
    replace_triggered_by = [aws_lambda_function.ws_connect]
  }
}

# ---------------------------------------------------------------------------
# $disconnect route
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_integration" "ws_disconnect" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_disconnect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_disconnect.id}"
}

# Same depends_on + replace_triggered_by pattern as ws_connect_api_gateway
# above. lambda-websocket.tf:164-169 replaces ws_disconnect on every source
# hash change; the permission must cycle in lockstep.
resource "aws_lambda_permission" "ws_disconnect_api_gateway" {
  statement_id  = "AllowWebSocketDisconnectAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"

  depends_on = [aws_lambda_function.ws_disconnect]

  lifecycle {
    replace_triggered_by = [aws_lambda_function.ws_disconnect]
  }
}

# ---------------------------------------------------------------------------
# $default route (no-op for v1 — clients don't send messages)
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_route" "ws_default" {
  api_id                              = aws_apigatewayv2_api.websocket.id
  route_key                           = "$default"
  route_response_selection_expression = "$default"
  target                              = "integrations/${aws_apigatewayv2_integration.ws_connect.id}"
}
