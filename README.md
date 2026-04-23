# Dovecote

[繁體中文](./README.zh-tw.md)

Agent notification infrastructure — an MCP server deployed on Cloudflare Workers that receives messages from agents and forwards them to configured notification channels.

## Features

- **MCP over Streamable HTTP** — compatible with Claude Code, Claude web connector, and any MCP client
- **OAuth 2.1 + PKCE** — sign-in flow for the Claude.ai web connector, with Dynamic Client Registration (RFC 7591) and Protected Resource Metadata (RFC 9728)
- **Multi-instance channels** — configure multiple Telegram / Discord instances via `TELEGRAM_INSTANCES` / `DISCORD_INSTANCES` JSON arrays
- **CSRF protection** — HMAC-SHA256 with HttpOnly/Secure cookie

## Architecture

```
Agent (Claude Code / claude.ai / any MCP client)
  │
  ▼  MCP over Streamable HTTP (OAuth 2.1 + PKCE)
Dovecote (Cloudflare Worker + OAUTH_KV)
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

- **Runtime**: Cloudflare Workers (TypeScript, Hono)
- **Transport**: Streamable HTTP (SSE)
- **Storage**: Cloudflare KV (`OAUTH_KV` — OAuth clients/grants/tokens + encrypted channel config)
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1)

## Development

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create a `.dev.vars` file (see `.dev.vars.example`):
   ```env
   OAUTH_PASSWORD=your-authorize-page-password
   COOKIE_ENCRYPTION_KEY=$(openssl rand -base64 32)
   TELEGRAM_INSTANCES=[{"id":"default","botToken":"...","chatId":"..."}]
   DISCORD_INSTANCES=[{"id":"default","webhookUrl":"..."}]
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

2. **Set secrets**
   ```bash
   ./scripts/setup-worker-vars.sh
   # or
   bun run deploy:secrets
   ```

   This will prompt you to enter secrets. If `.dev.vars` exists, it will use values from there as defaults.

   Required:
   - `OAUTH_PASSWORD` — password shown on the `/authorize` page (Claude.ai OAuth flow)
   - `COOKIE_ENCRYPTION_KEY` — HMAC key for the CSRF cookie (base64, 32 bytes)

   Optional (notification channels, JSON arrays):
   - `TELEGRAM_INSTANCES` — `[{"id":"default","botToken":"...","chatId":"..."}]`
   - `DISCORD_INSTANCES` — `[{"id":"default","webhookUrl":"..."}]`

   For the staging environment: `WRANGLER_ENV=staging ./scripts/setup-worker-vars.sh`.

   Also create a KV namespace in the Cloudflare dashboard and write its id into the `[[kv_namespaces]]` block of `wrangler.toml` (binding `OAUTH_KV`).

3. **Deploy the worker**
   ```bash
   ./scripts/deploy.sh
   # or
   bun run deploy
   ```

   The script will output the worker URL (e.g., `https://dovecote.your-subdomain.workers.dev`)

4. **Verify deployment**
   ```bash
   ./scripts/verify-deployment.sh https://dovecote.your-subdomain.workers.dev
   # or
   bun run deploy:verify https://dovecote.your-subdomain.workers.dev
   ```

   This runs a health check (GET /health → 200 OK)

### Claude.ai Web Connector (OAuth)

When adding a connector on Claude.ai, fill in the worker URL (e.g., `https://dovecote.<sub>.workers.dev`). Claude redirects to `/authorize`, which asks for `OAUTH_PASSWORD`; on success it completes the OAuth 2.1 + PKCE flow to obtain an access token, and subsequent MCP calls carry the Bearer token automatically.

5. **Run E2E tests against production** (optional)
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   bun test:e2e:remote
   ```

   For testing notification channels on production:
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_TELEGRAM_INSTANCES='[{"id":"default","botToken":"...","chatId":"..."}]' \
   TEST_DISCORD_INSTANCES='[{"id":"default","webhookUrl":"..."}]' \
   bun test:e2e:remote
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
bun test test/e2e/
```

In remote mode:
- Tests use actual HTTP requests via global `fetch()`
- Tests that require custom environment configurations are skipped (they only apply to in-process testing)

## License

MIT
