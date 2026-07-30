# Deployment Runbook

This runbook covers deployment procedures, client provisioning, and operational verification for dovecote.

## Pre-Deployment Checklist

Before deploying to production:

1. **Run all tests locally**:
   ```bash
   bun test
   ```
   Ensure all tests pass (current baseline: 461 pass / 0 fail).

2. **Verify Wrangler authentication**:
   ```bash
   wrangler whoami
   ```
   Confirm you're authenticated with the correct Cloudflare account.

3. **Review secrets configuration**:
   Ensure all required secrets are set via `wrangler secret put`:
   - `HMAC_PEPPER`
   - `ADMIN_REVOKE_TOKEN`
   - Channel-specific credentials (if using notifications)

## Users and Tokens (M1 auth model)

dovecote's root credential is the `dvct_*` API token. There is no password
login anywhere: browser OAuth (`/authorize`) asks the user to paste a
`dvct_*` token, the CLI logs in with `dovecote auth login --token`, and CI
exchanges a GitHub Actions OIDC id_token via `/v1/auth/github-oidc`.

### 1. First token — setup wizard

`bun run setup` mints the first token locally (step 6): it reuses the
server's `issueToken` over a `wrangler kv key put --remote` adapter, writes
the three KV index keys (`apitoken:`, `apitoken_hash:`, `apitoken_user:`),
and saves the token to `~/.config/dovecote/config.json`. The scope prompt
defaults to `dovecote:notify,dovecote:admin` so the bootstrap token can call
admin-scoped endpoints.

### 2. User records

User records live at `user:<username>` and carry the user's granted scopes.
Records are auto-provisioned with `algo:"oidc"` (placeholder, no credential
material) by the OIDC exchange, or written by the wizard (step 5).

Username charset: lowercase letters, digits, `_`, `-`, 1–64 chars.

### 3. Available scopes

- `dovecote:notify` – send notifications
- `dovecote:admin` – admin actions (revoke, bootstrap, token listing)

### 4. Required envs for the auth path

- `HMAC_PEPPER` (required) – `dvct_*` token hashing pepper; if missing,
  token issue/verify fails closed.
- `ADMIN_REVOKE_TOKEN` (optional) – enables `/admin/revoke` and
  `/admin/bootstrap-client`.
- `GITHUB_OIDC_EXPECTED_AUD` / `GITHUB_OIDC_ALLOWED_OWNER` (optional) –
  required only for the GitHub Actions OIDC exchange (L2).

### 5. Retired secrets (safe to delete)

Secrets belonging to auth mechanisms removed in M1 are no longer read by
the worker. List them with `wrangler secret list` and delete any that are
not in the required set above (`wrangler secret delete <name>`).

## First-Time Client Provisioning

For the initial OAuth client setup, use this flip-switch deployment sequence (DP3):

1. **Enable bootstrap endpoint**:
   ```bash
   wrangler secret put ENABLE_CLIENT_BOOTSTRAP
   # Enter value: 1
   ```

2. **Deploy with bootstrap enabled**:
   ```bash
   wrangler deploy
   ```

3. **Provision the OAuth client** (set `$ADMIN_TOKEN` to the `ADMIN_REVOKE_TOKEN` value first):
   ```bash
   curl -X POST https://dovecote.your-subdomain.workers.dev/admin/bootstrap-client \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "clientName": "claude-desktop",
       "redirectUris": ["https://claude.ai/api/mcp/auth_callback"]
     }'
   ```

   Save the returned `client_id` and `client_secret` (if applicable) securely.

4. **Disable bootstrap endpoint**:
   ```bash
   wrangler secret delete ENABLE_CLIENT_BOOTSTRAP
   ```

5. **Deploy with bootstrap disabled**:
   ```bash
   wrangler deploy
   ```

6. **Run smoke tests** (see Section 3 below).

## Smoke Test Verification

After any deployment, verify basic functionality:

```bash
TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
bun test test/e2e/smoke.test.ts
```

Or use the script shorthand (requires `TEST_BASE_URL`):

```bash
TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev bun run deploy:verify
```

Expected results:
- OAuth metadata endpoint returns valid configuration
- DCR endpoint is closed (returns 4xx)
- Bootstrap endpoint is gated (returns 404 when disabled)

Note: Full flow tests (C5, C6) only run in local mode with MockKV.

## Observability

### Real-Time Logs

Stream live Worker logs during traffic:

```bash
wrangler tail
```

For structured JSON output:

```bash
wrangler tail --format=json
```

### Audit Trail Inspection

List all audit events in KV:

```bash
wrangler kv key list --binding OAUTH_KV --prefix "audit:"
```

Retrieve a specific audit entry:

```bash
wrangler kv key get --binding OAUTH_KV "audit:1714320000:abc-def-123"
```

## 30-Day Rolling Baseline Metrics (DP5)

Establish operational baseline within 30 days post-deployment:

### 1. Audit Event Volume

Measure daily audit event creation rate:

```bash
# Count total audit entries
wrangler kv key list --binding OAUTH_KV --prefix "audit:" | jq '. | length'

# Divide by days since deployment to get avg daily rate
```

Typical baseline for single-user setup: 5-20 events/day (varies by MCP tool usage).

### 2. Rate Limit Triggers

Identify rate-limited requests via `wrangler tail`:

```bash
wrangler tail --format=json | jq 'select(.logs[] | contains("rate_limited"))'
```

Or inspect audit trail for `reason: "rate_limited"` in `admin.revoke` or `admin.bootstrap` events.

Expected baseline: 0 triggers under normal operation.

### 3. Token Refresh Rotation Failures

**Status**: Deferred to Phase 2 (`env-audit-structured-logger`, DP4=C).

Current observability: Manual inspection via `wrangler tail` for token-related errors. No structured metric available yet.

Future: Will add explicit failure tracking for refresh token rotation flows.

## Backfilling apitoken_user: index

Phase 4.3 added a per-user token index (`apitoken_user:<userId>:<tokenId>`)
enabling fast self-listing via `GET /v1/tokens`. Tokens issued before this
phase exist only at `apitoken:<tokenId>` and need a one-shot backfill so
they show up in the self-list path. (Admin-all listing always scans
`apitoken:` directly and therefore works without backfill.)

```bash
# 1. Preview which index keys would be written (default, non-mutating):
bun scripts/backfill-apitoken-user-index.mjs --dry-run

# 2. Apply the writes:
bun scripts/backfill-apitoken-user-index.mjs --apply
```

Final stdout is a JSON line of the form:
`{"scanned":N,"wouldWrite":W,"written":X,"skipped":S,"errored":E,"mode":"apply"}`

The script is idempotent — re-running `--apply` is safe and will not double
any state. Exit code 2 indicates wrangler was not on PATH.

### Post-rollout verification (real-KV smoke)

After deploying 4.1 to staging, run a real-KV smoke test:

- Issue 1 token, then `GET /v1/tokens` with that bearer.
- If the deployment has >900 tokens for a single user, confirm
  `truncated:true` behavior matches expectation.
- MockKV emits `list_complete: false` at `keys.length === limit`; real CF
  KV may differ at the exact boundary. Cross-check the truncated flag
  against `wrangler kv key list --binding OAUTH_KV --prefix apitoken_user:<user>:`.

## Related Documentation

- [Client Bootstrap Guide](./client-bootstrap.md) – Detailed OAuth client setup instructions
- [Audit Trail Schema](../src/auth/audit.ts) – AuditEvent type definitions
- [E2E Test Configuration](../test/e2e/config.ts) – Local vs remote test modes
