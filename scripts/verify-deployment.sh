#!/usr/bin/env bash
set -euo pipefail

WORKER_URL="${1:-${WORKER_URL:-}}"
MCP_AUTH_TOKEN="${MCP_AUTH_TOKEN:-}"

if [[ -z "$WORKER_URL" ]]; then
  echo "Error: WORKER_URL is required"
  echo "Usage: $0 <WORKER_URL>"
  echo "   or: WORKER_URL=<url> $0"
  exit 1
fi

if [[ -z "$MCP_AUTH_TOKEN" ]]; then
  echo "Error: MCP_AUTH_TOKEN environment variable is required"
  exit 1
fi

# Remove trailing slash if present
WORKER_URL="${WORKER_URL%/}"

echo "Verifying deployment at: $WORKER_URL"
echo ""

# Test 1: Health check
echo "Test 1: GET /health"
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$WORKER_URL/health")
HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | tail -1)
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')

if [[ "$HEALTH_STATUS" != "200" ]]; then
  echo "FAILED: Expected status 200, got $HEALTH_STATUS"
  echo "Response: $HEALTH_BODY"
  exit 1
fi

if ! echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  echo "FAILED: Expected status=ok in response"
  echo "Response: $HEALTH_BODY"
  exit 1
fi

echo "PASSED: Health check returned 200 OK"
echo ""

# Test 2: Auth rejection
echo "Test 2: POST /mcp without auth"
AUTH_FAIL_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' \
  "$WORKER_URL/mcp")
AUTH_FAIL_STATUS=$(echo "$AUTH_FAIL_RESPONSE" | tail -n 1)

if [[ "$AUTH_FAIL_STATUS" != "401" ]]; then
  echo "FAILED: Expected status 401, got $AUTH_FAIL_STATUS"
  exit 1
fi

echo "PASSED: Auth rejection returned 401"
echo ""

# Test 3: MCP initialize with auth
echo "Test 3: POST /mcp with auth + initialize"
INIT_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify-script","version":"1.0.0"}},"id":1}' \
  "$WORKER_URL/mcp")

# Extract SSE data line
INIT_DATA=$(echo "$INIT_RESPONSE" | grep '^data: ' | sed 's/^data: //')

if [[ -z "$INIT_DATA" ]]; then
  echo "FAILED: No SSE data line found in response"
  echo "Response: $INIT_RESPONSE"
  exit 1
fi

if ! echo "$INIT_DATA" | grep -q '"serverInfo"'; then
  echo "FAILED: Expected serverInfo in response"
  echo "Response: $INIT_DATA"
  exit 1
fi

if ! echo "$INIT_DATA" | grep -q '"capabilities"'; then
  echo "FAILED: Expected capabilities in response"
  echo "Response: $INIT_DATA"
  exit 1
fi

echo "PASSED: Initialize returned valid MCP response"
echo ""

echo "All tests passed! Deployment is verified."
