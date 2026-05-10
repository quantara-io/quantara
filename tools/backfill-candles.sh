#!/usr/bin/env bash
# Invoke the quantara-dev-backfill Lambda for a given exchange/pair/timeframe.
#
# Usage:
#   tools/backfill-candles.sh --exchange kraken --pair BTC/USDT --timeframe 1h --days 30
#   tools/backfill-candles.sh --exchange kraken --pair BTC/USDT --timeframe 1h --days 130 --force
#
# --force: bypass the saved cursor and use the requested --days lookback from now.
#          Equivalent to deleting the backfill:<exchange>:<pair>:<timeframe> cursor
#          row in ingestion-metadata before running.
set -euo pipefail

FUNCTION_NAME="${BACKFILL_FUNCTION:-quantara-dev-backfill}"
AWS_PROFILE="${AWS_PROFILE:-quantara-dev}"
AWS_REGION="${AWS_REGION:-us-west-2}"

exchange=""
pair=""
timeframe="1h"
days=7
force=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exchange)  exchange="$2";   shift 2 ;;
    --pair)      pair="$2";       shift 2 ;;
    --timeframe) timeframe="$2";  shift 2 ;;
    --days)      days="$2";       shift 2 ;;
    --force)     force=true;      shift   ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 --exchange <id> --pair <pair> [--timeframe <tf>] [--days <n>] [--force]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$exchange" || -z "$pair" ]]; then
  echo "Error: --exchange and --pair are required" >&2
  exit 1
fi

PAYLOAD=$(jq -n \
  --arg  exchange   "$exchange" \
  --arg  pair       "$pair" \
  --arg  timeframe  "$timeframe" \
  --argjson days    "$days" \
  --argjson force   "$force" \
  '{exchange: $exchange, pair: $pair, timeframe: $timeframe, days: $days, force: $force}')

echo "Invoking $FUNCTION_NAME with payload:"
echo "$PAYLOAD" | jq .

aws lambda invoke \
  --profile "$AWS_PROFILE" \
  --region  "$AWS_REGION" \
  --function-name "$FUNCTION_NAME" \
  --payload "$PAYLOAD" \
  --cli-binary-format raw-in-base64-out \
  /dev/stdout
