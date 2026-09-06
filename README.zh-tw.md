# Dovecote

[English](./README.md)

Agent 通知基礎設施 — 部署在 Cloudflare Workers 上的 MCP server，接收 agent 發送的訊息並轉發到指定的通知頻道。

## 特色

- **MCP over Streamable HTTP** — 相容 Claude Code、Claude web connector 與任何 MCP client
- **OAuth 2.1 + PKCE** — Claude.ai web connector 登入流程，支援 Dynamic Client Registration (RFC 7591) 與 Protected Resource Metadata (RFC 9728)
- **Multi-instance channels** — 每個 Telegram / Discord instance 都是一筆 `channel:<service>-<id>` KV 記錄，用 `bun run channel:add` 新增

## 架構

```
Agent (Claude Code / claude.ai / 任何 MCP client)
  │
  ▼  MCP over Streamable HTTP (OAuth 2.1 + PKCE)
Dovecote (Cloudflare Worker + OAUTH_KV)
  │
  ├──▶ Telegram Bot API
  └──▶ Discord Webhook
```

## MCP Tools

| Tool | 說明 |
|------|------|
| `send_notification` | 發送訊息到指定的通知頻道 |
| `list_channels` | 列出所有可用的通知頻道 |

## 技術棧

- **Runtime**：Cloudflare Workers（TypeScript、Hono）
- **Transport**：Streamable HTTP (SSE)
- **儲存**：Cloudflare KV（`OAUTH_KV` — OAuth clients/grants/tokens，以及每個通知頻道一筆明文記錄）
- **認證**：`@cloudflare/workers-oauth-provider`（OAuth 2.1）

## 開發

1. 安裝依賴：
   ```bash
   bun install
   ```

2. 建立 `.dev.vars`（可參考 `.dev.vars.example`）：
   ```env
   HMAC_PEPPER=...
   ```

   頻道不從 `.dev.vars` 讀取 — worker 改從 `OAUTH_KV` 的
   `channel:<service>-<id>` 記錄解析。

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
   - `HMAC_PEPPER` — `dvct_*` token 雜湊用 pepper；`/authorize` 顯示貼上 `dvct_*` token 的表單

   通知頻道已不再是 secret。每個頻道是 `OAUTH_KV` 裡的
   `channel:<service>-<id>` 記錄：用 `bun run channel:add -- --env production` 新增，
   或用 `bun run channel:migrate -- --env production --file backup.json` 一次匯入舊的 JSON 陣列。

   若是升級既有部署、頻道還放在 worker secret 裡？請照
   [Channel Cutover](./docs/deploy-runbook.md#channel-cutover-worker-secrets-to-kv-records)
   的順序做 — 先部署再 migrate，或先刪舊 secret，都會讓所有頻道消失。

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

在 Claude.ai 新增 connector 時，請填入 MCP 端點 URL，**務必包含 `/mcp` 後綴**（例如 `https://dovecote.<sub>.workers.dev/mcp`）。若只填 base URL，OAuth discovery 會失敗，畫面上會看到「Authorization with the MCP server failed.」。Claude 會跳轉到 `/authorize` 顯示貼上 `dvct_*` token 的表單，POST 成功後透過 OAuth 2.1 + PKCE 取得 access token，之後的 MCP 呼叫會自動帶上 Bearer。

5. **對 production 執行 E2E 測試**（選用）
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   bun test:e2e:remote
   ```

   要一併斷言部署應該暴露哪些頻道，列出它們的 id：
   ```bash
   TEST_BASE_URL=https://dovecote.your-subdomain.workers.dev \
   TEST_EXPECTED_CHANNELS='telegram-default,discord-ops' \
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
- **貼 token 授權**：`/authorize` 只接受 POST 的 `dvct_*` token——token 本身即防偽 secret（無 cookie 環境憑證），並對每個 IP 施加提交頻率限制
- **速率限制**：admin 端點每 IP 60 秒內限 5 次請求
- **稽核軌跡**：所有授權與特權操作記錄至 KV，保留 90 天
- **防點擊劫持標頭**：`/authorize` 端點回傳 `Content-Security-Policy: frame-ancestors 'none'` 與 `X-Frame-Options: DENY`
- **基於 Scope 的存取控制**：
  - `dovecote:notify` – 透過已設定通道發送通知
  - `dovecote:admin` – **Admin 權限**：執行 admin 等級操作。需要 user 記錄具備 `dovecote:admin` scope。

### 漏洞通報

請透過 [GitHub Security Advisories](https://github.com/musingfox/dovecote/security/advisories/new) 私下回報安全漏洞，請勿開立公開 issue 討論安全問題。

## License

MIT
