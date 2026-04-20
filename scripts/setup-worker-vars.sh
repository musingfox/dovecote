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
echo "$MCP_AUTH_TOKEN" | wrangler secret put MCP_AUTH_TOKEN

# Optional: TELEGRAM_INSTANCES (JSON array)
if [[ -n "${TELEGRAM_INSTANCES:-}" ]]; then
  echo "Setting TELEGRAM_INSTANCES..."
  echo "$TELEGRAM_INSTANCES" | wrangler secret put TELEGRAM_INSTANCES
else
  read -p "Enter TELEGRAM_INSTANCES JSON (optional, press Enter to skip): " TELEGRAM_INSTANCES
  if [[ -n "$TELEGRAM_INSTANCES" ]]; then
    echo "$TELEGRAM_INSTANCES" | wrangler secret put TELEGRAM_INSTANCES
  fi
fi

# Optional: DISCORD_INSTANCES (JSON array)
if [[ -n "${DISCORD_INSTANCES:-}" ]]; then
  echo "Setting DISCORD_INSTANCES..."
  echo "$DISCORD_INSTANCES" | wrangler secret put DISCORD_INSTANCES
else
  read -p "Enter DISCORD_INSTANCES JSON (optional, press Enter to skip): " DISCORD_INSTANCES
  if [[ -n "$DISCORD_INSTANCES" ]]; then
    echo "$DISCORD_INSTANCES" | wrangler secret put DISCORD_INSTANCES
  fi
fi

echo ""
echo "Secrets set successfully!"
