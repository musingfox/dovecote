---
status: accepted
date: 2026-05-15
decision-makers: ""
tags:
  - adr
  - dovecote
  - architecture
---

# HTTP API 為主幹、MCP 為 adapter；OAuth 與 API token 雙軌認證

## Context and Problem Statement

Dovecote 既有形態是 Cloudflare Worker 上的 MCP server，僅暴露 `/mcp`（OAuth 2.1 + PKCE）給 MCP-aware client（Claude Code、Claude web）。但實際上需要送通知的「agent」包含 CI/CD pipeline、cron、shell script、Python LLM agent、edge function 等多數不具 MCP 能力的環境。

為了讓任意 agent 都能用 dovecote 送通知，必須回答兩個問題：

1. 對外暴露的「主要介面」應該是 MCP，還是更通用的東西？
2. 既有 OAuth + PKCE 流程是否能服務 headless 環境（CI / cron），還是需要另一條認證路徑？兩條路徑該怎麼共存？

詳細落地規劃由 maintainer 持續維護（內部 planning 文件，不公開）。

## Decision Drivers

* 各種 agent 環境的最低共同點是 HTTP，不是 MCP
* CI/headless 場景無法跑 OAuth 互動 flow
* 既有 `@cloudflare/workers-oauth-provider` 已綁定 `/mcp` 的認證行為
* `sendToChannel` 等領域邏輯已在 `src/channels/registry.ts` 抽出，與 MCP 解耦
* 不希望未來新介面（SDK、Relay）每次都得碰 MCP server 本體
* 認證憑證生命週期不同：OAuth access token 短期、API token 長期（CI 需要 90 天等級）

## Considered Options

* **Option A** — 維持 MCP 為主，CLI 包裝成 MCP client，HTTP 不公開
* **Option B** — 加 REST 端點，視為 MCP 的「對外輔助」（次要介面）
* **Option C** — 翻轉定位：HTTP API 為主幹，MCP 是其上 adapter；OAuth 與 API token 透過拓樸分流共存（路徑 B）
* **Option D** — 同 C 的定位，但 API token 透過 `workers-oauth-provider` 的 `resolveExternalToken` hook 在 lib 內部分流（路徑 A）
* **Option E** — 另起 Relay server，CLI 打 Relay、Relay 打 MCP

## Decision Outcome

Chosen option: **Option C**，因為它正面回應「最大化 agent 接入面」的本質需求（HTTP 是最低共同點），同時把 OAuth 與 API token 兩種生命週期完全不同的認證機制拆乾淨、各自演進不互相牽動。

具體拓樸決定：

* `src/index.ts` 從 `export default new OAuthProvider(...)` 改為 `export default Hono root app`
* Hono root 內路徑分流：
  * `/mcp`、`/authorize`、`/token`、`/.well-known/*` → 委派給 `OAuthProvider` wrapper
  * `/v1/*` → 自家 `bearerMiddleware`（`src/auth/bearer.ts`）
* 兩條路徑下游都組出統一 `AuthCtx { userId, scopes[], authMethod, tokenId?, grantId? }`
* Service layer (`src/services/*`) 對協議無感，由各 adapter 翻譯回應形狀

### Consequences

* Good, because 任何 agent 環境（curl、Python、CI、cron、edge function）只要能發 HTTP 就能用
* Good, because OAuth 與 API token 解耦，未來其中一條（如升級 OAuthProvider 版本）不影響另一條
* Good, because audit、rate-limit、錯誤格式對 `/v1/*` 完全自主，不受 lib 401 行為限制
* Good, because `authMethod` 自然分流，不必硬塞進 OAuth `props`
* Good, because MCP 路徑邏輯零變動，向後相容既有 Claude Code / Claude web 使用者
* Neutral, because 多一層 Hono root 分流，但程式碼集中、可測試性提升
* Bad, because 兩條認証路徑各自的 AuthCtx 注入方式不同（ctx.props vs Hono `c.var`），下游需要相容層
* Bad, because OpenAPI / zod-to-openapi 受 MCP SDK 內部 zod peer dep 衝突影響，必須先解（見 Phase 2a）
* Bad, because KV 最終一致導致 token revoke 有 ≤60s 視窗，需在文件明示

### Confirmation

* `src/index.ts` 不再直接 `export default new OAuthProvider(...)`；root 為 Hono app
* `/v1/*` route 經自家 `bearerMiddleware`，不經 `OAuthProvider`
* `/mcp` 行為向後相容：既有 E2E (`test/e2e/`) 不破
* Service layer 函式簽名不含 MCP / HTTP 專屬型別
* CLI / curl / MCP client 三種 entry 對同一 channel 發訊息結果一致（contract test）

## Pros and Cons of the Options

### Option A — MCP-only，CLI 為 MCP client

* Good, because 沒有新對外 surface，維護面最小
* Bad, because CI / shell / 任意語言 agent 仍卡在 MCP 協議能力
* Bad, because OAuth 互動 flow 在 headless 環境無法跑
* Bad, because CLI 要包 SSE / JSON-RPC / session 管理，binary 重且複雜

### Option B — REST 為 MCP 的次要介面

* Good, because 比 A 多服務一群 agent
* Bad, because 定位模糊（什麼該走 MCP、什麼該走 REST 不清楚）
* Bad, because 文件、SDK、版本化都會分裂在兩個一級概念上
* Bad, because 「先做 MCP，再補 REST」的心態會讓 REST 永遠是次等公民

### Option C — HTTP 為主幹、MCP 為 adapter；路徑 B 拓樸

* Good, because 對外定位清楚：「dovecote 是 HTTP API，MCP 是其中一個 adapter」
* Good, because 兩條認証路徑各自封裝，演進不互相牽動
* Good, because 路徑 B 的 `bearerMiddleware` 完全自主控制(rate-limit、audit、錯誤格式)
* Bad, because Hono root 多一層分流，要正確把 OAuth 路徑的 request 委派
* Bad, because `AuthCtx` 注入方式分歧（props vs `c.var`），需相容處理

### Option D — 同 C，但 API token 走 `resolveExternalToken` hook（路徑 A）

* Good, because 程式碼更少，只多一個 hook，不動 root 拓樸
* Good, because 兩種 token 都自動填 `ctx.props`，下游無感
* Bad, because API token 邏輯被夾在 OAuth lib 的 hook 內，模組邊界不清
* Bad, because OAuthProvider 版本升級會牽動 API token 系統
* Bad, because audit / rate-limit / 錯誤格式受 lib 預設行為限制，401 形狀無法完全自訂
* Bad, because `authMethod` 區分必須在 hook 內手動標，較易遺漏

### Option E — Relay server 中繼 CLI → MCP

* Good, because dovecote 本體不長新對外 surface
* Bad, because Relay 是 thin proxy，不解決任何本質問題（傳輸、認證痛點都搬家而非消失）
* Bad, because Relay 自己要扛 OAuth token / refresh token 保管，多一個敏感資料保管點
* Bad, because 雙跳 = 兩倍失敗模式、兩倍延遲、兩倍 observability
* Bad, because 除非 Relay 扛 queue / retry / fan-out 等實質工作，否則不創造價值

## More Information

* 相關既有實作：
  * `src/index.ts` — 現有 `OAuthProvider` export 根節點，本決定要重構
  * `src/api.ts` — MCP handler，本決定要改為 service layer adapter
  * `src/channels/registry.ts` — 已抽出的領域邏輯，未來 service 層基礎
  * `src/auth/scopes.ts` — Scope 模型，本決定新增 `dovecote:admin`
* 後續預定 ADR 主題：
  * API token 簽發 / 撤銷 / hash 儲存機制
  * Admin password 與一般授權 password 拆分
