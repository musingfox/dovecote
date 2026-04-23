# OAuth Client Bootstrap SOP

This document describes the Standard Operating Procedure for creating OAuth clients in Dovecote after DCR (Dynamic Client Registration) has been closed.

## Prerequisites

- Admin token (`ADMIN_REVOKE_TOKEN`) must be set in the environment
- Access to Cloudflare Workers secrets management (via `wrangler`)
- Production deployment URL

## Procedure

### Step 1: Enable Bootstrap Endpoint

Set the feature flag to enable the bootstrap endpoint:

```bash
wrangler secret put ENABLE_CLIENT_BOOTSTRAP
```

When prompted, enter: `1`

### Step 2: Create OAuth Client

Use the admin bootstrap endpoint to create a new OAuth client:

```bash
curl -X POST https://<your-deployment-url>/admin/bootstrap-client \
  -H "Authorization: Bearer $ADMIN_REVOKE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "My MCP Client",
    "redirectUris": ["https://claude.ai/api/mcp/auth_callback"]
  }'
```

**Example response:**

```json
{
  "client_id": "abc123..."
}
```

**Save the `client_id`** — you will need it for the next steps.

### Step 3: Disable Bootstrap Endpoint

Immediately delete the feature flag to disable the endpoint:

```bash
wrangler secret delete ENABLE_CLIENT_BOOTSTRAP
```

### Step 4: Verify Security

Confirm that the bootstrap endpoint is no longer accessible:

```bash
curl -i https://<your-deployment-url>/admin/bootstrap-client \
  -X POST \
  -H "Authorization: Bearer $ADMIN_REVOKE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected result:** `404 Not Found` with plain text response (not JSON)

### Step 5: Configure Client

Paste the `client_id` into the Claude.ai MCP connector configuration:

1. Open Claude.ai
2. Navigate to MCP Settings
3. Add new server configuration
4. Paste the `client_id` in the "OAuth Client ID" field (Advanced settings)
5. Save configuration

## Fallback: Temporary DCR Window

If the bootstrap endpoint fails or is unavailable, you may temporarily re-enable DCR:

1. **Remove the DCR restriction** (code change required):
   - In `src/index.ts`, temporarily comment out `disallowPublicClientRegistration: true`
   - Deploy the change
2. **Use DCR** within a 5-minute window:
   ```bash
   curl -X POST https://<your-deployment-url>/register \
     -H "Content-Type: application/json" \
     -d '{
       "client_name": "My MCP Client",
       "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
       "token_endpoint_auth_method": "none"
     }'
   ```
3. **Immediately restore the restriction**:
   - Uncomment `disallowPublicClientRegistration: true`
   - Redeploy

**Note:** This fallback increases attack surface. Use only when the bootstrap endpoint is unavailable.

## Security Considerations

- **Rate limit:** 5 requests per 60 seconds per IP address (separate from revoke endpoint)
- **Auth token:** Same token as revoke endpoint (`ADMIN_REVOKE_TOKEN`), timing-safe comparison
- **Audit trail:** All bootstrap attempts (success and failure) are logged with reason codes
- **Flag-gated:** Endpoint returns 404 (indistinguishable from catch-all) when flag is not set to `"1"`
- **Public clients only:** Bootstrap creates clients with `tokenEndpointAuthMethod: "none"` (no secret)

## Threat Model Reference

This procedure addresses:

- **T16:** Public DCR abuse risk (OQ-A resolution: close DCR, operator-provisioned clients only)

## Related Documentation

- [OAuth 2.1 Authorization](../README.md#oauth-21-authorization)
- [Admin Revoke Endpoint](./admin-revoke.md) (if exists)
