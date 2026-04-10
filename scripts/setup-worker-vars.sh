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

# Optional: TELEGRAM_BOT_TOKEN
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Setting TELEGRAM_BOT_TOKEN..."
  echo "$TELEGRAM_BOT_TOKEN" | wrangler secret put TELEGRAM_BOT_TOKEN
else
  read -p "Enter TELEGRAM_BOT_TOKEN (optional, press Enter to skip): " TELEGRAM_BOT_TOKEN
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
    echo "$TELEGRAM_BOT_TOKEN" | wrangler secret put TELEGRAM_BOT_TOKEN
  fi
fi

# Optional: TELEGRAM_CHAT_ID
if [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "Setting TELEGRAM_CHAT_ID..."
  echo "$TELEGRAM_CHAT_ID" | wrangler secret put TELEGRAM_CHAT_ID
else
  read -p "Enter TELEGRAM_CHAT_ID (optional, press Enter to skip): " TELEGRAM_CHAT_ID
  if [[ -n "$TELEGRAM_CHAT_ID" ]]; then
    echo "$TELEGRAM_CHAT_ID" | wrangler secret put TELEGRAM_CHAT_ID
  fi
fi

# Optional: DISCORD_WEBHOOK_URL
if [[ -n "${DISCORD_WEBHOOK_URL:-}" ]]; then
  echo "Setting DISCORD_WEBHOOK_URL..."
  echo "$DISCORD_WEBHOOK_URL" | wrangler secret put DISCORD_WEBHOOK_URL
else
  read -p "Enter DISCORD_WEBHOOK_URL (optional, press Enter to skip): " DISCORD_WEBHOOK_URL
  if [[ -n "$DISCORD_WEBHOOK_URL" ]]; then
    echo "$DISCORD_WEBHOOK_URL" | wrangler secret put DISCORD_WEBHOOK_URL
  fi
fi

echo ""
echo "Secrets set successfully!"
