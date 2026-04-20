# Dovecote

Agent notification infrastructure — an MCP server deployed on Cloudflare Workers that receives messages from agents and forwards them to configured notification channels.

## Features

- **MCP over Streamable HTTP** — compatible with Claude Code, Claude web connector, and any MCP client
- **OAuth 2.1 + PKCE** — Claude.ai web connector登入流程，支援 Dynamic Client Registration (RFC 7591) 與 Protected Resource Metadata (RFC 9728)
- **Legacy bearer token** — 舊客戶端可繼續使用 `MCP_AUTH_TOKEN` 直連
- **Multi-instance channels** — Telegram / Discord 可設定多個 instance (`TELEGRAM_INSTANCES` / `DISCORD_INSTANCES` JSON 陣列)
- **CSRF protection** — HMAC-SHA256 + HttpOnly/Secure cookie

## Architecture

```
Agent (Claude Code / claude.ai / any MCP client)
  │
  ▼  MCP over Streamable HTTP
  │   ├─ OAuth 2.1 + PKCE (Claude.ai web connector)
  │   └─ Bearer token (legacy MCP_AUTH_TOKEN)
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
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1) + legacy bearer fallback

## Development

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create `.dev.vars` file (參考 `.dev.vars.example`)：
   ```env
   MCP_AUTH_TOKEN=your-legacy-bearer-token
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
   - `MCP_AUTH_TOKEN` — legacy bearer token for MCP clients that don't do OAuth
   - `OAUTH_PASSWORD` — password shown on `/authorize` page (Claude.ai OAuth flow)
   - `COOKIE_ENCRYPTION_KEY` — HMAC key for CSRF cookie (base64, 32 bytes)

   Optional (notification channels, JSON arrays):
   - `TELEGRAM_INSTANCES` — `[{"id":"default","botToken":"...","chatId":"..."}]`
   - `DISCORD_INSTANCES` — `[{"id":"default","webhookUrl":"..."}]`

   Staging 環境：設 `WRANGLER_ENV=staging ./scripts/setup-worker-vars.sh`。

   同時在 Cloudflare dashboard 建立 KV namespace 並把 id 寫入 `wrangler.toml` 的 `[[kv_namespaces]]`（binding `OAUTH_KV`）。

3. **Deploy the worker**
   ```bash
   ./scripts/deploy.sh
   # or
   bun run deploy
   ```

   The script will output the worker URL (e.g., `https://dovecote.your-subdomain.workers.dev`)

4. **Verify deployment**
   ```bash
   MCP_AUTH_TOKEN=your-token ./scripts/verify-deployment.sh https://dovecote.your-subdomain.workers.dev
   # or
   export MCP_AUTH_TOKEN=your-token
   bun run deploy:verify https://dovecote.your-subdomain.workers.dev
   ```

   This runs three tests:
   - Health check (GET /health → 200 OK)
   - Wrong token rejected (POST /mcp with invalid Bearer token → 401)
   - Authorized MCP initialize (POST /mcp with Bearer token → 200 OK with serverInfo)

### Claude.ai Web Connector (OAuth)

在 Claude.ai 新增 connector 時填入 worker URL（如 `https://dovecote.<sub>.workers.dev`）。Claude 會跳轉到 `/authorize` 要求輸入 `OAUTH_PASSWORD`，通過後透過 OAuth 2.1 + PKCE 拿到 access token，後續 MCP 呼叫自動帶 Bearer。

5. **Run E2E tests against production** (optional)
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_AUTH_TOKEN=your-token \
   bun test:e2e:remote
   ```

   For testing notification channels on production:
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_AUTH_TOKEN=your-token \
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
TEST_AUTH_TOKEN=your-production-token \
bun test test/e2e/
```

In remote mode:
- Tests use actual HTTP requests via global `fetch()`
- Tests that require custom environment configurations are skipped (they only apply to in-process testing)

## License

MIT
