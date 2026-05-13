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

# Pull outputs FIRST so VITE_API_BASE can be baked into the build.
# Without this, the production bundle ships with API_BASE="" and every fetch
# hits the admin CloudFront origin instead of the API origin — SPA-fallback
# returns index.html as a 200 (non-JSON body) and every API call breaks.
echo "→ Reading terraform outputs from ${TF_DIR}…"
cd "$TF_DIR"
BUCKET=$(AWS_PROFILE="$PROFILE" terraform output -raw admin_bucket_name)
DIST_ID=$(AWS_PROFILE="$PROFILE" terraform output -raw admin_distribution_id)
URL=$(AWS_PROFILE="$PROFILE" terraform output -raw admin_cloudfront_url)
API_URL=$(AWS_PROFILE="$PROFILE" terraform output -raw cloudfront_url)
echo "  bucket=$BUCKET  distribution=$DIST_ID  api=$API_URL"

echo "→ Building Vite bundle (VITE_API_BASE=$API_URL)…"
cd "$SCRIPT_DIR"
VITE_API_BASE="$API_URL" npm run build

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
