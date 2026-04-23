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

# MCP_AUTH_TOKEN is required
if [[ -z "${MCP_AUTH_TOKEN:-}" ]]; then
  read -p "Enter MCP_AUTH_TOKEN (required): " MCP_AUTH_TOKEN
  if [[ -z "$MCP_AUTH_TOKEN" ]]; then
    echo "Error: MCP_AUTH_TOKEN is required"
    exit 1
  fi
fi

echo "Setting MCP_AUTH_TOKEN..."
echo "$MCP_AUTH_TOKEN" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} MCP_AUTH_TOKEN

# Optional: TELEGRAM_INSTANCES (JSON array)
if [[ -n "${TELEGRAM_INSTANCES:-}" ]]; then
  echo "Setting TELEGRAM_INSTANCES..."
  echo "$TELEGRAM_INSTANCES" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} TELEGRAM_INSTANCES
else
  read -p "Enter TELEGRAM_INSTANCES JSON (optional, press Enter to skip): " TELEGRAM_INSTANCES
  if [[ -n "$TELEGRAM_INSTANCES" ]]; then
    echo "$TELEGRAM_INSTANCES" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} TELEGRAM_INSTANCES
  fi
fi

# Optional: DISCORD_INSTANCES (JSON array)
if [[ -n "${DISCORD_INSTANCES:-}" ]]; then
  echo "Setting DISCORD_INSTANCES..."
  echo "$DISCORD_INSTANCES" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} DISCORD_INSTANCES
else
  read -p "Enter DISCORD_INSTANCES JSON (optional, press Enter to skip): " DISCORD_INSTANCES
  if [[ -n "$DISCORD_INSTANCES" ]]; then
    echo "$DISCORD_INSTANCES" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} DISCORD_INSTANCES
  fi
fi

# OAUTH_PASSWORD is required
if [[ -z "${OAUTH_PASSWORD:-}" ]]; then
  read -p "Enter OAUTH_PASSWORD (required): " OAUTH_PASSWORD
  if [[ -z "$OAUTH_PASSWORD" ]]; then
    echo "Error: OAUTH_PASSWORD is required"
    exit 1
  fi
fi

echo "Setting OAUTH_PASSWORD..."
echo "$OAUTH_PASSWORD" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} OAUTH_PASSWORD

# COOKIE_ENCRYPTION_KEY is required
if [[ -z "${COOKIE_ENCRYPTION_KEY:-}" ]]; then
  read -p "Enter COOKIE_ENCRYPTION_KEY (required, generate with: openssl rand -base64 32): " COOKIE_ENCRYPTION_KEY
  if [[ -z "$COOKIE_ENCRYPTION_KEY" ]]; then
    echo "Error: COOKIE_ENCRYPTION_KEY is required"
    exit 1
  fi
fi

echo "Setting COOKIE_ENCRYPTION_KEY..."
echo "$COOKIE_ENCRYPTION_KEY" | wrangler secret put ${WRANGLER_ENV:+--env $WRANGLER_ENV} COOKIE_ENCRYPTION_KEY

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
