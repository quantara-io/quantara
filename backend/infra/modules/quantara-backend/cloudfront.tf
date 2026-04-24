# ---------------------------------------------------------------------------
# CloudFront Distribution — edge CDN in front of API Gateway
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "${local.prefix}-api"
  price_class     = "PriceClass_100" # US, Canada, Europe only (cheapest)
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    domain_name = replace(aws_apigatewayv2_api.api.api_endpoint, "https://", "")
    origin_id   = "api-gateway"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "api-gateway"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Don't cache API responses — pass everything through
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
  }

  # Cache the docs page (static HTML)
  ordered_cache_behavior {
    path_pattern           = "/api/docs"
    target_origin_id       = "api-gateway"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      headers      = ["X-Forwarded-For"]
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 300 # 5 min cache for docs
    max_ttl     = 3600
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true # Use *.cloudfront.net cert for now
  }

  tags = {
    Name = "${local.prefix}-api-cdn"
  }
}
