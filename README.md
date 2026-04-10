# Dovecote

Agent notification infrastructure — an MCP server deployed on Cloudflare Workers that receives messages from agents and forwards them to configured notification channels.

## Features

- **MCP over Streamable HTTP** — compatible with Claude Code, Claude web connector, and any MCP client
- **Multi-channel notifications** — Telegram Bot API, Discord Webhook, Slack Webhook
- **Bearer token auth** — only authorized agents can send notifications
- **Encrypted channel config** — webhook credentials stored in Cloudflare KV with AES-256-GCM encryption

## Architecture

```
Agent (Claude Code / claude.ai / any MCP client)
  │
  ▼  MCP over SSE (Bearer token)
Dovecote (Cloudflare Worker)
  │
  ├──▶ Telegram Bot API
  ├──▶ Discord Webhook
  └──▶ Slack Webhook
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `send_notification` | Send a message to a specified notification channel |
| `list_channels` | List all available notification channels |

## Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript)
- **Transport**: Streamable HTTP (SSE)
- **Storage**: Cloudflare KV (encrypted)
- **Auth**: Bearer token via Worker Secrets

## Development

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create `.dev.vars` file with your credentials:
   ```env
   MCP_AUTH_TOKEN=your-secret-token
   TELEGRAM_BOT_TOKEN=your-telegram-bot-token
   TELEGRAM_CHAT_ID=your-telegram-chat-id
   DISCORD_WEBHOOK_URL=your-discord-webhook-url
   ```

3. Run locally:
   ```bash
   bun run dev
   ```

4. Run tests:
   ```bash
   # Run all tests
   bun test

   # Run E2E tests only (local mode)
   bun test test/e2e/
   ```

## Deployment

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- Cloudflare account

### Steps

1. **Login to Cloudflare**
   ```bash
   wrangler login
   ```

2. **Deploy the worker**
   ```bash
   ./scripts/deploy.sh
   # or
   bun run deploy
   ```

   Note the worker URL from the output (e.g., `https://dovecote.your-subdomain.workers.dev`)

3. **Set secrets**
   ```bash
   ./scripts/setup-worker-vars.sh
   # or
   bun run deploy:secrets
   ```

   This will prompt you to enter secrets. If `.dev.vars` exists, it will use values from there as defaults.

   Required:
   - `MCP_AUTH_TOKEN` - Bearer token for MCP authentication

   Optional (for notification channels):
   - `TELEGRAM_BOT_TOKEN` - Telegram bot token
   - `TELEGRAM_CHAT_ID` - Telegram chat ID to send messages to
   - `DISCORD_WEBHOOK_URL` - Discord webhook URL

4. **Verify deployment**
   ```bash
   MCP_AUTH_TOKEN=your-token ./scripts/verify-deployment.sh https://dovecote.your-subdomain.workers.dev
   # or
   export MCP_AUTH_TOKEN=your-token
   bun run deploy:verify https://dovecote.your-subdomain.workers.dev
   ```

5. **Run E2E tests against production** (optional)
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_AUTH_TOKEN=your-token \
   bun test test/e2e/
   ```

## Testing

### Local E2E Tests

By default, E2E tests run in local mode using `app.fetch()` (in-process testing):

```bash
bun test test/e2e/
```

Requires `.dev.vars` with valid credentials.

### Remote E2E Tests

To test against a deployed worker, set environment variables:

```bash
TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
TEST_AUTH_TOKEN=your-production-token \
bun test test/e2e/
```

In remote mode:
- Tests use actual HTTP requests via global `fetch()`
- Tests that require custom environment configurations are skipped (they only apply to in-process testing)

## License

MIT
