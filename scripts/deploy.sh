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
echo "  2. Verify deployment: ./scripts/verify-deployment.sh $WORKER_URL"

exit 0
