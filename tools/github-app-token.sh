#!/usr/bin/env bash
# github-app-token.sh — Mint a GitHub App installation access token.
#
# Required env vars:
#   REVIEWER_APP_ID            GitHub App ID (numeric)
#   REVIEWER_INSTALLATION_ID   GitHub App installation ID (numeric)
#   REVIEWER_APP_KEY_PATH      Path to the App's RS256 private key (.pem)
#
# Outputs: the installation access token to stdout (nothing else).
# Diagnostics go to stderr.
# Exits non-zero on any failure.

set -euo pipefail

# --- Validate env vars -------------------------------------------------------
missing=()
[[ -z "${REVIEWER_APP_ID:-}" ]]            && missing+=("REVIEWER_APP_ID")
[[ -z "${REVIEWER_INSTALLATION_ID:-}" ]]   && missing+=("REVIEWER_INSTALLATION_ID")
[[ -z "${REVIEWER_APP_KEY_PATH:-}" ]]      && missing+=("REVIEWER_APP_KEY_PATH")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "github-app-token.sh: missing required env var(s): ${missing[*]}" >&2
  exit 1
fi

if [[ ! -f "$REVIEWER_APP_KEY_PATH" ]]; then
  echo "github-app-token.sh: key file not found: $REVIEWER_APP_KEY_PATH" >&2
  exit 1
fi

APP_ID="$REVIEWER_APP_ID"
INSTALLATION_ID="$REVIEWER_INSTALLATION_ID"
PEM_PATH="$REVIEWER_APP_KEY_PATH"

# --- Build RS256 JWT ----------------------------------------------------------
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 540))

b64url() { base64 | tr -d '=\n' | tr '/+' '_-'; }

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | b64url)
SIG=$(printf '%s.%s' "$HEADER" "$PAYLOAD" | openssl dgst -sha256 -sign "$PEM_PATH" -binary | b64url)
JWT="${HEADER}.${PAYLOAD}.${SIG}"

echo "github-app-token.sh: JWT minted (iat=$IAT exp=$EXP iss=$APP_ID)" >&2

# --- Exchange JWT for installation token -------------------------------------
RESPONSE=$(curl -sS -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens") || {
  echo "github-app-token.sh: curl failed (network error or non-zero exit)" >&2
  exit 1
}

TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.token // empty')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "github-app-token.sh: response did not contain a token" >&2
  echo "github-app-token.sh: API response: $RESPONSE" >&2
  exit 1
fi

echo "github-app-token.sh: installation token obtained successfully" >&2

# Output token to stdout ONLY
printf '%s' "$TOKEN"
