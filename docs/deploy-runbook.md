# Deployment Runbook

This runbook covers deployment procedures, client provisioning, and operational verification for dovecote.

## Pre-Deployment Checklist

Before deploying to production:

1. **Run all tests locally**:
   ```bash
   bun test
   ```
   Ensure all tests pass (current baseline: 229 pass / 1 skip / 0 fail).

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

Or use the npm script shorthand:

```bash
bun run deploy:verify
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

## Related Documentation

- [Client Bootstrap Guide](./client-bootstrap.md) – Detailed OAuth client setup instructions
- [Audit Trail Schema](../src/auth/audit.ts) – AuditEvent type definitions
- [E2E Test Configuration](../test/e2e/config.ts) – Local vs remote test modes
