#!/usr/bin/env bash
set -euo pipefail

echo "Checking wrangler authentication..."
if ! wrangler whoami &>/dev/null; then
  echo "Error: Not authenticated. Run 'wrangler login' first."
  exit 1
fi

echo "Deploying to Cloudflare Workers..."
DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# Parse worker URL from output
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.workers\.dev' | head -1)

echo ""
echo "Deployment successful!"
if [[ -n "$WORKER_URL" ]]; then
  echo "Worker URL: $WORKER_URL"
fi
echo ""
echo "Next steps:"
echo "  1. Set secrets: ./scripts/setup-worker-vars.sh"
if [[ -n "$WORKER_URL" ]]; then
  echo "  2. Verify deployment: TEST_BASE_URL=$WORKER_URL bun run deploy:verify"
else
  echo "  2. Verify deployment: TEST_BASE_URL=<worker-url> bun run deploy:verify"
fi

exit 0
