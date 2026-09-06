# Dovecote

[![CI](https://github.com/musingfox/dovecote/actions/workflows/ci.yml/badge.svg)](https://github.com/musingfox/dovecote/actions/workflows/ci.yml)

[繁體中文](./README.zh-tw.md)

Agent notification infrastructure — an MCP server deployed on Cloudflare Workers that receives messages from agents and forwards them to configured notification channels.

## Features

- **MCP over Streamable HTTP** — compatible with Claude Code, Claude web connector, and any MCP client
- **OAuth 2.1 + PKCE** — sign-in flow for the Claude.ai web connector, with Dynamic Client Registration (RFC 7591) and Protected Resource Metadata (RFC 9728)
- **Multi-instance channels** — each Telegram / Discord instance is a `channel:<service>-<id>` KV record, added with `bun run channel:add`

## Architecture

```
Agent (Claude Code / claude.ai / any MCP client)
  │
  ▼  MCP over Streamable HTTP (OAuth 2.1 + PKCE)
Dovecote (Cloudflare Worker + OAUTH_KV)
  │
  ├──▶ Telegram Bot API
  └──▶ Discord Webhook
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `send_notification` | Send a message to a specified notification channel |
| `list_channels` | List all available notification channels |

## Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript, Hono)
- **Transport**: Streamable HTTP (SSE)
- **Storage**: Cloudflare KV (`OAUTH_KV` — OAuth clients/grants/tokens + one plaintext record per notification channel)
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1)

## Development

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create a `.dev.vars` file (see `.dev.vars.example`):
   ```env
   HMAC_PEPPER=...
   ```

   Channels are not read from `.dev.vars` — the worker resolves them from
   `channel:<service>-<id>` records in `OAUTH_KV`.

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
   - `HMAC_PEPPER` — HMAC pepper for `dvct_*` token hashing; `/authorize` shows a form to paste a pre-issued `dvct_*` token

   Notification channels are no longer secrets. Each channel is a
   `channel:<service>-<id>` record in `OAUTH_KV`: add one with
   `bun run channel:add -- --env production`, or move a saved JSON array over
   in one shot with `bun run channel:migrate -- --env production --file backup.json`.

   Upgrading a deployment whose channels still live in worker secrets? Follow
   [Channel Cutover](./docs/deploy-runbook.md#channel-cutover-worker-secrets-to-kv-records)
   in order — migrating after you deploy, or deleting the old secrets first,
   drops every channel.

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

When adding a connector on Claude.ai, fill in the MCP endpoint URL **including the `/mcp` suffix** (e.g., `https://dovecote.<sub>.workers.dev/mcp`). The bare base URL will fail OAuth discovery and surface as "Authorization with the MCP server failed." Claude redirects to `/authorize`, which shows a form to paste a `dvct_*` token (issued via wizard or exchange); on POST success it completes the OAuth 2.1 + PKCE flow to obtain an access token, and subsequent MCP calls carry the Bearer token automatically.

5. **Run E2E tests against production** (optional)
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   bun test:e2e:remote
   ```

   To also assert which channels the deployment exposes, list their ids:
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_EXPECTED_CHANNELS='telegram-default,discord-ops' \
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
- **Token-paste authorization**: `/authorize` accepts only a POSTed `dvct_*` token — the token itself is the anti-forgery secret (no ambient cookie credential exists), and submissions are rate-limited per IP
- **Rate Limiting**: 5 requests per 60 seconds per IP address on admin endpoints
- **Audit Trail**: All authorization and privileged operations logged to KV with 90-day TTL
- **Anti-Clickjacking Headers**: `/authorize` endpoint serves `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
- **Scope-Based Access Control**:
  - `dovecote:notify` – Send notifications via configured channels
  - `dovecote:admin` – **Admin privilege**: Execute admin-level operations. Requires the `dovecote:admin` scope on the issuing user record.

### Vulnerability Reporting

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/musingfox/dovecote/security/advisories/new). Do not file public issues for security problems.

## License

MIT
