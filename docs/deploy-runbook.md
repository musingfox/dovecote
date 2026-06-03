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
   - `OAUTH_PASSWORD`
   - `COOKIE_ENCRYPTION_KEY` (min 32 bytes)
   - `ADMIN_REVOKE_TOKEN`
   - Channel-specific credentials (if using notifications)

## Seeding Users

dovecote authenticates users against KV records keyed by `user:<username>`.
The legacy single-`OAUTH_PASSWORD` deployment (one operator account, full
scope set) still works for back-compat, but new deployments should seed
explicit users so per-user scope, audit trail, and revoke can be reasoned
about cleanly.

### 1. Seed a user via `scripts/seed-user.mjs`

The helper hashes the password with PBKDF2-SHA256 (100k iterations, fresh
random salt) using `HMAC_PEPPER` as a server-side secret. The output is a
single-line `wrangler kv key put` command, ready to paste:

```bash
node scripts/seed-user.mjs \
  --username alice \
  --password "$ALICE_PASSWORD" \
  --scopes dovecote:notify \
  --pepper "$HMAC_PEPPER"
```

Pipe that to a shell to actually apply it:

```bash
eval "$(node scripts/seed-user.mjs --username alice --password "$ALICE_PASSWORD" --scopes dovecote:notify --pepper "$HMAC_PEPPER")"
```

Username charset: lowercase letters, digits, `_`, `-`, 1–64 chars.
Anything else is rejected client-side (script exits non-zero) and
server-side (the `/authorize` form returns 403 without a KV read).

> **Migration tip**: KV-seeded users receive ONLY the scopes listed in
> `--scopes`. The legacy operator inherited the full set
> (`dovecote:notify`, `dovecote:admin`). When seeding
> a replacement user, remember to enumerate every scope your existing
> workflows depend on — otherwise tokens issued to that user will be
> rejected at scope-check time.

### 2. Available scopes

- `dovecote:notify` – send notifications
- `dovecote:admin` – admin actions (revoke, bootstrap)

A user can only successfully complete an `/authorize` request for scopes
listed in their KV record. Requesting a scope the user lacks → 403
Insufficient scope.

### 3. Legacy single-operator deployments

If `OAUTH_PASSWORD` is set and no KV `user:<name>` record matches the
submitted username, the server falls back to a single legacy operator
account:

- Default username: `operator` (override via `LEGACY_OPERATOR_USERNAME`)
- Password: `OAUTH_PASSWORD`
- Granted scopes: all (`dovecote:notify`, `dovecote:admin`)

This back-compat path lets existing single-tenant installs keep working.
To retire it, seed real users into KV and unset `OAUTH_PASSWORD`.

### 4. `OAUTH_ADMIN_PASSWORD` retirement

The previous dual-password admin gate (`OAUTH_ADMIN_PASSWORD`) is
**removed**: admin authority is now expressed by the per-user
`dovecote:admin` scope in the KV record. The `OAUTH_ADMIN_PASSWORD` env
is no longer read by the server. Remove it from your worker config when
convenient:

```bash
wrangler secret delete OAUTH_ADMIN_PASSWORD
```

### 5. Required envs for the new auth path

- `HMAC_PEPPER` (required) – password hashing pepper; if missing or empty,
  password verify throws and authentication fails closed.
- `OAUTH_PASSWORD` (optional) – legacy fallback only.
- `LEGACY_OPERATOR_USERNAME` (optional) – override legacy username default.

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

Filter by event type (requires `jq`):

```bash
wrangler kv key list --binding OAUTH_KV --prefix "audit:" | \
  jq -r '.[] | .name' | \
  while read key; do
    wrangler kv key get --binding OAUTH_KV "$key" | jq 'select(.event == "env.read")'
  done
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
