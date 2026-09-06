#!/usr/bin/env bash
set -euo pipefail

echo "Setting secrets for Cloudflare Worker..."
echo ""

# Check if .dev.vars exists for reading defaults
DEV_VARS_PATH=".dev.vars"
if [[ -f "$DEV_VARS_PATH" ]]; then
  echo "Reading defaults from $DEV_VARS_PATH..."
  source <(grep -v '^#' "$DEV_VARS_PATH" | sed 's/^/export /')
fi

# HMAC_PEPPER is required (dvct_* token hashing)
if [[ -z "${HMAC_PEPPER:-}" ]]; then
  read -p "Enter HMAC_PEPPER (required, generate with: openssl rand -base64 32): " HMAC_PEPPER
  if [[ -z "$HMAC_PEPPER" ]]; then
    echo "Error: HMAC_PEPPER is required"
    exit 1
  fi
fi

echo "Setting HMAC_PEPPER..."
echo "$HMAC_PEPPER" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} HMAC_PEPPER

# Optional: ADMIN_REVOKE_TOKEN
if [[ -n "${ADMIN_REVOKE_TOKEN:-}" ]]; then
  echo "Setting ADMIN_REVOKE_TOKEN..."
  echo "$ADMIN_REVOKE_TOKEN" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} ADMIN_REVOKE_TOKEN
else
  read -p "Enter ADMIN_REVOKE_TOKEN (optional, press Enter to skip): " ADMIN_REVOKE_TOKEN
  if [[ -n "$ADMIN_REVOKE_TOKEN" ]]; then
    echo "$ADMIN_REVOKE_TOKEN" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} ADMIN_REVOKE_TOKEN
  fi
fi

echo ""
echo "Secrets set successfully!"
