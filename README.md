# Dovecote

[![CI](https://github.com/musingfox/dovecote/actions/workflows/ci.yml/badge.svg)](https://github.com/musingfox/dovecote/actions/workflows/ci.yml)

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

   Optional (admin scope):
   - `OAUTH_ADMIN_PASSWORD` — separate password required when a client requests the `dovecote:admin` scope. If this secret is not configured and an admin scope is requested, the authorize endpoint returns 503. Regular `OAUTH_PASSWORD` is never used as a fallback for admin requests.

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
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev bun run deploy:verify
   ```

   This runs smoke tests to verify OAuth metadata, closed DCR, and endpoint availability. For detailed deployment procedures including client provisioning, see [docs/deploy-runbook.md](./docs/deploy-runbook.md).

### Claude.ai Web Connector (OAuth)

When adding a connector on Claude.ai, fill in the MCP endpoint URL **including the `/mcp` suffix** (e.g., `https://dovecote.<sub>.workers.dev/mcp`). The bare base URL will fail OAuth discovery and surface as "Authorization with the MCP server failed." Claude redirects to `/authorize`, which asks for `OAUTH_PASSWORD`; on success it completes the OAuth 2.1 + PKCE flow to obtain an access token, and subsequent MCP calls carry the Bearer token automatically.

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

## CLI

The dovecote CLI ships as a standalone binary for 5 platforms; releases are tagged `cli-v<semver>` and published as GitHub Releases with a `SHA256SUMS` sidecar.

### Deploy your own (5 minutes)

```bash
git clone https://github.com/musingfox/dovecote.git
cd dovecote
bun install
wrangler login          # one-time browser OAuth
bun run setup           # interactive wizard
```

The wizard pushes 4 secrets to your Cloudflare Worker, configures at least one
notification channel (Telegram or Discord), deploys, seeds your first user,
mints a CLI token, and runs `bun run verify` end-to-end. Secrets are recorded
to `~/.dovecote/secrets-<env>.txt` (mode 0600) — move them to your password
manager and delete the file.

See [docs/setup-dovecote-runbook.md](./docs/setup-dovecote-runbook.md) for the
GH Actions consumer side.

### Use from another Claude Code session

Once `bun run setup` has minted a token into `~/.config/dovecote/config.json`,
other Claude Code sessions can shell out to the `dovecote` CLI to send
notifications. Install the bundled skill for explicit discovery:

```bash
mkdir -p ~/.claude/skills
cp -R .claude/skills/dovecote-notify ~/.claude/skills/
```

The skill (defined in [.claude/skills/dovecote-notify/SKILL.md](./.claude/skills/dovecote-notify/SKILL.md))
triggers on phrases like *"notify me"*, *"send to Telegram"*, *"ping ops"*,
*"alert when X finishes"*, etc. — your agent will pick the right channel,
shell out to `dovecote notify`, and handle errors (token expired, channel
unknown, rate-limit) without further prompting.

### Install in a GitHub Actions workflow

```yaml
- uses: musingfox/dovecote/.github/actions/setup-dovecote@cli-v0.1.0
  with:
    version: "0.1.0"
    server-url: https://dovecote.your-subdomain.workers.dev
  env:
    DOVECOTE_TOKEN: ${{ secrets.DOVECOTE_TOKEN }}

- run: dovecote notify ops --text "deploy complete"
```

For end-to-end CI consumer setup (token provisioning, supported triples, troubleshooting), see [docs/setup-dovecote-runbook.md](./docs/setup-dovecote-runbook.md).

### Local install

Download the archive for your platform from the [latest release](https://github.com/musingfox/dovecote/releases), verify the SHA256, extract, and place the binary on your `PATH`. Then run:

```bash
export DOVECOTE_CLIENT_ID=<id from POST /admin/bootstrap-client>
dovecote auth login --server-url https://dovecote.your-subdomain.workers.dev
dovecote ping
dovecote notify ops --text "hello from cli"
```

The runtime token is stored under `$XDG_CONFIG_HOME/dovecote/config.json` (mode 0600). The CLI auto-renews tokens that have <14 days remaining on every request.

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

## Security

dovecote implements defense-in-depth security controls:

- **OAuth 2.1 + PKCE**: Authorization flow requires S256 code challenge (plain challenge rejected)
- **Closed Dynamic Client Registration**: Public DCR disabled; clients provisioned via operator-only `/admin/bootstrap-client` endpoint
- **CSRF Protection**: HMAC-signed cookie validation on authorization form submission
- **Rate Limiting**: 5 requests per 60 seconds per IP address on admin endpoints
- **Audit Trail**: All authorization and privileged operations logged to KV with 90-day TTL
- **Anti-Clickjacking Headers**: `/authorize` endpoint serves `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
- **Scope-Based Access Control**:
  - `dovecote:notify` – Send notifications via configured channels
  - `dovecote:env:read` – **High privilege**: Read environment profiles from KV storage. Grant with caution.
  - `dovecote:admin` – **Admin privilege**: Execute admin-level operations. Requires `OAUTH_ADMIN_PASSWORD` (separate from `OAUTH_PASSWORD`). Any authorization request containing `dovecote:admin` (even mixed with other scopes) is validated against the admin password; the regular password is not accepted. If `OAUTH_ADMIN_PASSWORD` is not configured, the endpoint returns 503 immediately — there is no silent fallback.

### Vulnerability Reporting

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/musingfox/dovecote/security/advisories/new). Do not file public issues for security problems.

## License

MIT
