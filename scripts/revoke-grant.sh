#!/usr/bin/env bash
set -euo pipefail

# revoke-grant.sh - Revoke an OAuth grant via admin endpoint
# Usage: ./revoke-grant.sh <grantId>

if [ $# -ne 1 ]; then
  echo "Usage: $0 <grantId>" >&2
  exit 1
fi

GRANT_ID="$1"

if ! [[ "$GRANT_ID" =~ ^[a-z0-9-]{20,}$ ]]; then
  echo "Error: grantId must match ^[a-z0-9-]{20,}$" >&2
  exit 1
fi

# Read environment variables
if [ -z "${DOVECOTE_URL:-}" ]; then
  echo "Error: DOVECOTE_URL environment variable is not set" >&2
  echo "Example: export DOVECOTE_URL=https://dovecote.example.com" >&2
  exit 1
fi

if [ -z "${ADMIN_REVOKE_TOKEN:-}" ]; then
  echo "Error: ADMIN_REVOKE_TOKEN environment variable is not set" >&2
  echo "Example: export ADMIN_REVOKE_TOKEN=your-secret-token" >&2
  exit 1
fi

# Make POST request to revoke endpoint
echo "Revoking grant: $GRANT_ID"
echo "URL: $DOVECOTE_URL/admin/revoke"

response=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $ADMIN_REVOKE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"grantId\":\"$GRANT_ID\"}" \
  "$DOVECOTE_URL/admin/revoke")

# Split response body and status code
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

echo ""
echo "HTTP Status: $http_code"
echo "Response:"
echo "$body" | jq . 2>/dev/null || echo "$body"

# Exit with error if not 200
if [ "$http_code" != "200" ]; then
  exit 1
fi
