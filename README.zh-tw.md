# Dovecote

[English](./README.md)

Agent 通知基礎設施 — 部署在 Cloudflare Workers 上的 MCP server，接收 agent 發送的訊息並轉發到指定的通知頻道。

## 特色

- **MCP over Streamable HTTP** — 相容 Claude Code、Claude web connector 與任何 MCP client
- **OAuth 2.1 + PKCE** — Claude.ai web connector 登入流程，支援 Dynamic Client Registration (RFC 7591) 與 Protected Resource Metadata (RFC 9728)
- **Multi-instance channels** — Telegram / Discord 可透過 `TELEGRAM_INSTANCES` / `DISCORD_INSTANCES` JSON 陣列設定多個 instance
- **CSRF 保護** — HMAC-SHA256 搭配 HttpOnly/Secure cookie

## 架構

```
Agent (Claude Code / claude.ai / 任何 MCP client)
  │
  ▼  MCP over Streamable HTTP (OAuth 2.1 + PKCE)
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
- **認證**：`@cloudflare/workers-oauth-provider`（OAuth 2.1）

## 開發

1. 安裝依賴：
   ```bash
   bun install
   ```

2. 建立 `.dev.vars`（可參考 `.dev.vars.example`）：
   ```env
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
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev bun run deploy:verify
   ```

   會跑 smoke tests 驗證 OAuth metadata、關閉的 DCR、端點可用性。詳細部署流程（包含 client provisioning）見 [docs/deploy-runbook.md](./docs/deploy-runbook.md)。

### Claude.ai Web Connector（OAuth）

在 Claude.ai 新增 connector 時，請填入 MCP 端點 URL，**務必包含 `/mcp` 後綴**（例如 `https://dovecote.<sub>.workers.dev/mcp`）。若只填 base URL，OAuth discovery 會失敗，畫面上會看到「Authorization with the MCP server failed.」。Claude 會跳轉到 `/authorize` 要求輸入 `OAUTH_PASSWORD`，通過後透過 OAuth 2.1 + PKCE 取得 access token，之後的 MCP 呼叫會自動帶上 Bearer。

5. **對 production 執行 E2E 測試**（選用）
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   bun test:e2e:remote
   ```

   要一併驗證通知頻道：
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
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
bun test test/e2e/
```

Remote 模式下：
- 透過全域 `fetch()` 發真正的 HTTP 請求
- 需要客製 env 的測試會被跳過（那些只在 in-process 有意義）

## 安全性

dovecote 實作多層防禦安全控制：

- **OAuth 2.1 + PKCE**：授權流程要求 S256 code challenge（拒絕 plain challenge）
- **關閉動態客戶端註冊**：公開 DCR 已停用；客戶端透過 operator-only `/admin/bootstrap-client` 端點配置
- **CSRF 保護**：授權表單送出時驗證 HMAC 簽章 cookie
- **速率限制**：admin 端點每 IP 60 秒內限 5 次請求
- **稽核軌跡**：所有授權與特權操作記錄至 KV，保留 90 天
- **防點擊劫持標頭**：`/authorize` 端點回傳 `Content-Security-Policy: frame-ancestors 'none'` 與 `X-Frame-Options: DENY`
- **基於 Scope 的存取控制**：
  - `dovecote:notify` – 透過已設定通道發送通知
  - `dovecote:env:read` – **高權限**：從 KV 儲存讀取環境設定檔。授予時需謹慎。

### 漏洞通報

請透過 [GitHub Security Advisories](https://github.com/musingfox/dovecote/security/advisories/new) 私下回報安全漏洞，請勿開立公開 issue 討論安全問題。

## License

MIT
