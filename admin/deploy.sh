#!/usr/bin/env bash
# Builds the admin SPA and syncs to S3, then invalidates CloudFront.
# Reads bucket name + distribution id from terraform outputs.
#
#   Usage:  ./deploy.sh [dev|prod]   (default: dev)

set -euo pipefail

ENV="${1:-dev}"
case "$ENV" in
  dev)  PROFILE="quantara-dev" ;;
  prod) PROFILE="quantara-prod" ;;
  *)    echo "Usage: $0 [dev|prod]"; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../backend/infra/$ENV"

echo "→ Building Vite bundle…"
cd "$SCRIPT_DIR"
npm run build

echo "→ Reading terraform outputs from ${TF_DIR}…"
cd "$TF_DIR"
BUCKET=$(terraform output -raw admin_bucket_name)
DIST_ID=$(terraform output -raw admin_distribution_id)
URL=$(terraform output -raw admin_cloudfront_url)
echo "  bucket=$BUCKET  distribution=$DIST_ID"

echo "→ Syncing dist/ to s3://${BUCKET} …"
cd "$SCRIPT_DIR"
aws s3 sync dist/ "s3://$BUCKET/" \
  --delete \
  --profile "$PROFILE" \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "index.html"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --profile "$PROFILE" \
  --cache-control "public, max-age=0, must-revalidate" \
  --content-type "text/html; charset=utf-8"

echo "→ Invalidating CloudFront…"
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --profile "$PROFILE" \
  --output text >/dev/null

echo "✓ Deployed: $URL"
