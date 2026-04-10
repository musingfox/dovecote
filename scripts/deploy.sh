#!/usr/bin/env bash
set -euo pipefail

echo "Checking wrangler authentication..."
if ! wrangler whoami &>/dev/null; then
  echo "Error: Not authenticated. Run 'wrangler login' first."
  exit 1
fi

echo "Deploying to Cloudflare Workers..."
wrangler deploy

echo ""
echo "Deployment successful!"
echo ""
echo "Worker URL can be found in the output above."
echo "Next steps:"
echo "  1. Set secrets: ./scripts/set-secrets.sh"
echo "  2. Verify deployment: ./scripts/verify-deployment.sh <WORKER_URL>"
