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

   Notification channels are **not** secrets. Each channel is a
   `channel:<service>-<id>` record in `OAUTH_KV`; provision one with
   `bun run channel:add -- --env <env>`. Upgrading a deployment that still
   configures channels through worker secrets? Follow
   [Channel Cutover](#channel-cutover-worker-secrets-to-kv-records) below, in
   order.

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

One exception this blanket rule would otherwise sweep up:

- **The two secrets whose names end in `_INSTANCES`** are the live channel
  configuration on any environment that has not been migrated yet. Deleting
  them before the cutover opens a window in which the worker has no channels
  at all and every notification fails. Leave them until you have completed
  [Channel Cutover](#channel-cutover-worker-secrets-to-kv-records) below; that
  procedure deletes them itself, as its last step.

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

## Channel Cutover: worker secrets to KV records

Channels used to be configured through two worker secrets, one per service,
whose names end in `_INSTANCES`. They now live one-per-record in KV as
`channel:<service>-<id>` (`src/channels/registry.ts`). The worker has no
environment-variable fallback, so an existing deployment needs a one-time
cutover, run once per environment.

> Editing this file: the two legacy secret names are deliberately not spelled
> out. `test/removal/channel-env-surface.test.ts` scans every tracked file for
> them and fails the build, so no document can re-teach an operator to write a
> dead variable back into production. Get the exact names from
> `wrangler secret list`.

### Order of operations (do not reorder)

Run steps 1-7 against `staging` first, confirm it, then repeat the whole
sequence against `production`. The order matters in one direction only: the
worker must be able to read channels from KV **before** the secrets go away.
Deploying the KV-reading worker first, or deleting the secrets first, opens a
window in which the worker has no channels at all and every notification fails.

1. **Recover the current channel config.** Wrangler cannot read a secret back,
   so take the JSON from wherever it was originally authored (password manager,
   provisioning script, local `.env`) and save it as `backup.json`:

   ```json
   {
     "telegram": [{ "id": "ops", "botToken": "...", "chatId": "..." }],
     "discord":  [{ "id": "alerts", "webhookUrl": "https://discord.com/api/webhooks/..." }]
   }
   ```

   A service value may also be the raw secret body as a single JSON string; it
   is parsed a second time, so the old value can be pasted in verbatim without
   hand-unwrapping it.

2. **Dry-run the migration.** Nothing is written. Every entry is validated with
   the same parser the worker uses, and one bad entry aborts the whole run.

   ```bash
   bun run channel:migrate -- --env staging --file backup.json --dry-run
   ```

   Fix every reported record before continuing. Note the limit of the
   all-or-nothing promise: it covers *validation*, not *transport*. If wrangler
   fails partway through the real run, earlier keys stay written; re-running is
   safe and converges, because every write is an unconditional put.

3. **Migrate.**

   ```bash
   bun run channel:migrate -- --env staging --file backup.json
   ```

4. **Read the records back before touching the deployment.**

   ```bash
   wrangler kv key list --binding OAUTH_KV --prefix channel: --remote --env staging
   ```

   `--remote` is mandatory on wrangler 4.x. Without it you are inspecting a
   local cache and verifying nothing. Expect exactly one
   `channel:<service>-<id>` key per channel. Do not proceed until this list is
   correct — this is the last checkpoint before the deployment changes.

5. **Deploy the worker that reads KV.**

   ```bash
   wrangler deploy --env staging
   ```

6. **Verify through the live read path.** Only this step proves the deployed
   worker actually resolves the records, rather than that the keys exist:

   ```bash
   dovecote channels list
   ```

   Every expected channel must appear. A record that is corrupt or disagrees
   with its own key is skipped rather than failing the call, so a channel
   *missing* here means a bad record, not an empty namespace. The reason is
   logged by the worker instead of being returned to the CLI — run
   `wrangler tail --env staging` while repeating the call to see which record
   was rejected and why (`invalid JSON`, a parse error, or
   `record id '<id>' does not match its key`). Send one probe before moving on:

   ```bash
   dovecote channels test <channel-id>
   ```

7. **Only now, delete the legacy secrets.**

   ```bash
   wrangler secret list --env staging            # the two names ending in _INSTANCES
   wrangler secret delete <NAME> --env staging   # once per name
   ```

8. **Repeat 1-7 for `production`.** `channel:migrate` has no default
   environment: `--env` is mandatory, and a real write to production stops to
   ask you to type `production` before anything is put. Anything else typed
   aborts with `production not confirmed — nothing was written` and exit 1.
   Confirm you are aimed at the right environment — a missing key and a wrong
   namespace both surface as `404: Not Found`, so an environment mix-up reads
   as "this channel does not exist yet" and writes the credential into the
   wrong namespace.

   `--dry-run` is not prompted, because it writes nothing. The prompt is read
   from the terminal rather than from stdin, so it still works when the
   document is piped in; with no terminal at all (CI, `</dev/null`) production
   is refused rather than assumed, so run the production step by hand.

### Rollback

Through step 6, rollback is a redeploy of the previous worker version: the
secrets are still present and the old worker still reads them. The KV records
written in step 3 are inert to the old worker, so leave them in place. After
step 7 there is no deployment to roll back to — recovery means re-creating the
secrets from `backup.json` and redeploying the old version, which is why
`backup.json` must survive until production is verified.

### Handling `backup.json`

`--file backup.json` leaves a plaintext file containing every bot token and
webhook URL on disk. Treat it as a live credential for its whole lifetime.

- Keep it out of the repository and out of any directory that syncs to a cloud
  service (iCloud Drive, Dropbox, OneDrive, Google Drive).
- Destroy it as soon as production is verified. On macOS, `rm -P backup.json`
  overwrites before unlinking (best-effort on APFS); shredding is not a
  substitute for the file never having existed.
- To avoid the file entirely, omit `--file` and pipe the document in on stdin:

  ```bash
  <your secret manager's read command> | bun run channel:migrate -- --env staging
  ```

### The stored credentials are readable — the CF API token is the real credential

Channel records are stored as plaintext JSON in KV. This is an accepted posture,
not an oversight. Anyone holding a Cloudflare API token that can read the
`OAUTH_KV` namespace can retrieve a live bot token:

```bash
wrangler kv key get --binding OAUTH_KV --remote --env production "channel:telegram-<id>"
```

Operate accordingly:

- The Cloudflare API token is the credential of record. Guard it at least as
  tightly as the bot tokens, and scope it to the minimum set of namespaces.
- If that token is ever exposed, assume every channel credential is exposed.
  Rotate all Telegram bot tokens via BotFather, regenerate every Discord webhook
  URL, then write the new values back with
  `bun run channel:add -- --env <env> --force` or by re-running
  `channel:migrate`. Records are overwritten unconditionally, so a re-run is the
  rotation.
- Revoking the Cloudflare token alone is not sufficient: anything already read
  out of KV stays valid until the bot tokens themselves are rotated.

### Credentials pass through process arguments

`channel:add`, `channel:migrate` and the setup wizard all write via
`wrangler kv key put ... <value>`, so the credential is an argument to the
`wrangler` process. For the duration of that call, any other user on the same
machine can read it with `ps auxww`. Nothing is echoed to logs or stdout — argv
is the whole exposure. On a single-operator laptop this is acceptable; on a
shared host or a CI runner you do not control, run the cutover elsewhere.

## Related Documentation

- [Client Bootstrap Guide](./client-bootstrap.md) – Detailed OAuth client setup instructions
- [Audit Trail Schema](../src/auth/audit.ts) – AuditEvent type definitions
- [E2E Test Configuration](../test/e2e/config.ts) – Local vs remote test modes
