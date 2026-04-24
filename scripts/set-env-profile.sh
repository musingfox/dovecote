#!/usr/bin/env bash
set -euo pipefail

# Usage: set-env-profile.sh <profile> <file-path>
# Optional: WRANGLER_ENV environment variable

if [ $# -ne 2 ]; then
  echo "Usage: $0 <profile> <file-path>" >&2
  echo "Example: $0 production .env.production" >&2
  echo "Optional: Set WRANGLER_ENV to specify the environment" >&2
  exit 1
fi

PROFILE="$1"
FILE="$2"

if [ ! -f "$FILE" ]; then
  echo "Error: File '$FILE' does not exist" >&2
  exit 1
fi

# Build wrangler command with optional --env flag
WRANGLER_CMD="wrangler kv key put --binding OAUTH_KV --remote"

if [ -n "${WRANGLER_ENV:-}" ]; then
  WRANGLER_CMD="$WRANGLER_CMD --env $WRANGLER_ENV"
fi

WRANGLER_CMD="$WRANGLER_CMD env:${PROFILE} --path ${FILE}"

# Execute the command
$WRANGLER_CMD

echo "Successfully uploaded profile '$PROFILE' from '$FILE' to KV"
