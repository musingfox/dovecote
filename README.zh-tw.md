# Dovecote

[English](./README.md)

Agent 通知基礎設施 — 部署在 Cloudflare Workers 上的 MCP server，接收 agent 發送的訊息並轉發到指定的通知頻道。

## 特色

- **MCP over Streamable HTTP** — 相容 Claude Code、Claude web connector 與任何 MCP client
- **OAuth 2.1 + PKCE** — Claude.ai web connector 登入流程，支援 Dynamic Client Registration (RFC 7591) 與 Protected Resource Metadata (RFC 9728)
- **Legacy bearer token** — 舊客戶端可繼續使用 `MCP_AUTH_TOKEN` 直連
- **Multi-instance channels** — Telegram / Discord 可透過 `TELEGRAM_INSTANCES` / `DISCORD_INSTANCES` JSON 陣列設定多個 instance
- **CSRF 保護** — HMAC-SHA256 搭配 HttpOnly/Secure cookie

## 架構

```
Agent (Claude Code / claude.ai / 任何 MCP client)
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

| Tool | 說明 |
|------|------|
| `send_notification` | 發送訊息到指定的通知頻道 |
| `list_channels` | 列出所有可用的通知頻道 |

## 技術棧

- **Runtime**：Cloudflare Workers（TypeScript、Hono）
- **Transport**：Streamable HTTP (SSE)
- **儲存**：Cloudflare KV（`OAUTH_KV` — OAuth clients/grants/tokens 與加密後的 channel 設定）
- **認證**：`@cloudflare/workers-oauth-provider`（OAuth 2.1）＋ legacy bearer fallback

## 開發

1. 安裝依賴：
   ```bash
   bun install
   ```

2. 建立 `.dev.vars`（可參考 `.dev.vars.example`）：
   ```env
   MCP_AUTH_TOKEN=your-legacy-bearer-token
   OAUTH_PASSWORD=your-authorize-page-password
   COOKIE_ENCRYPTION_KEY=$(openssl rand -base64 32)
   TELEGRAM_INSTANCES=[{"id":"default","botToken":"...","chatId":"..."}]
   DISCORD_INSTANCES=[{"id":"default","webhookUrl":"..."}]
   ```

3. 本地啟動：
   ```bash
   bun run dev
   ```

4. 執行測試：
   ```bash
   # 全部測試
   bun test

   # 只跑 E2E（local 模式）
   bun test test/e2e/
   ```

## 部署

### 前置需求

- 已安裝 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare 帳號

### 步驟

1. **登入 Cloudflare**
   ```bash
   wrangler login
   ```

2. **設定 secrets**
   ```bash
   ./scripts/setup-worker-vars.sh
   # 或
   bun run deploy:secrets
   ```

   script 會提示輸入 secrets；若 `.dev.vars` 存在，會以其值作為預設。

   必要：
   - `MCP_AUTH_TOKEN` — 給不走 OAuth 的舊客戶端使用的 bearer token
   - `OAUTH_PASSWORD` — `/authorize` 頁面要求輸入的密碼（Claude.ai OAuth 流程）
   - `COOKIE_ENCRYPTION_KEY` — CSRF cookie 的 HMAC 金鑰（base64、32 bytes）

   選用（通知頻道，JSON 陣列）：
   - `TELEGRAM_INSTANCES` — `[{"id":"default","botToken":"...","chatId":"..."}]`
   - `DISCORD_INSTANCES` — `[{"id":"default","webhookUrl":"..."}]`

   Staging 環境：`WRANGLER_ENV=staging ./scripts/setup-worker-vars.sh`。

   同時在 Cloudflare dashboard 建立 KV namespace，並把 id 寫入 `wrangler.toml` 的 `[[kv_namespaces]]`（binding `OAUTH_KV`）。

3. **部署 worker**
   ```bash
   ./scripts/deploy.sh
   # 或
   bun run deploy
   ```

   輸出會包含 worker URL（例如 `https://dovecote.your-subdomain.workers.dev`）。

4. **驗證部署**
   ```bash
   MCP_AUTH_TOKEN=your-token ./scripts/verify-deployment.sh https://dovecote.your-subdomain.workers.dev
   # 或
   export MCP_AUTH_TOKEN=your-token
   bun run deploy:verify https://dovecote.your-subdomain.workers.dev
   ```

   會跑三項檢查：
   - 健康檢查（GET /health → 200 OK）
   - 錯誤 token 被拒絕（POST /mcp 帶無效 Bearer → 401）
   - 合法 MCP initialize（POST /mcp 帶正確 Bearer → 200 OK 含 serverInfo）

### Claude.ai Web Connector（OAuth）

在 Claude.ai 新增 connector 時填入 worker URL（例如 `https://dovecote.<sub>.workers.dev`）。Claude 會跳轉到 `/authorize` 要求輸入 `OAUTH_PASSWORD`，通過後透過 OAuth 2.1 + PKCE 取得 access token，之後的 MCP 呼叫會自動帶上 Bearer。

5. **對 production 執行 E2E 測試**（選用）
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_AUTH_TOKEN=your-token \
   bun test:e2e:remote
   ```

   要一併驗證通知頻道：
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_AUTH_TOKEN=your-token \
   TEST_TELEGRAM_INSTANCES='[{"id":"default","botToken":"...","chatId":"..."}]' \
   TEST_DISCORD_INSTANCES='[{"id":"default","webhookUrl":"..."}]' \
   bun test:e2e:remote
   ```

## 測試

### Local E2E

預設使用 `app.fetch()` 做 in-process 測試：

```bash
bun test test/e2e/
```

需要有效的 `.dev.vars`。

### Remote E2E

要打真正部署好的 worker，設定環境變數：

```bash
TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
TEST_AUTH_TOKEN=your-production-token \
bun test test/e2e/
```

Remote 模式下：
- 透過全域 `fetch()` 發真正的 HTTP 請求
- 需要客製 env 的測試會被跳過（那些只在 in-process 有意義）

## License

MIT
