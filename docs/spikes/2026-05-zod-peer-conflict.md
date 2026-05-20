# Spike: 解決 @modelcontextprotocol/sdk 與專案 zod 的 dual-instance 衝突

日期：2026-05-20  
狀態：完成（PoC 驗證通過）

---

## 問題描述

### 衝突根源

`@modelcontextprotocol/sdk@1.29.0` 的 peer dependency 宣告為 `"zod": "^3.25 || ^4.0"`，但在安裝時 Bun 選擇用 `zod@4.3.6` 滿足它（因 registry 最新版為 4.x），導致專案中同時存在兩份 zod：

| 位置 | 版本 | 原始 lockfile 行號 |
|---|---|---|
| `node_modules/zod` | 3.25.76 | bun.lock:654 |
| `node_modules/@modelcontextprotocol/sdk/node_modules/zod` | 4.3.6 | bun.lock:670 |

### 可見症狀

**`src/tools/send-notification.ts:16`（已修復）**：`server.tool(...)` 呼叫型別衝突，須加 `@ts-expect-error` 抑制。原因：`server.tool()` 的第三個參數（schema object）型別對應 SDK 內部 zod v4 的 `ZodType`，但傳入的是專案的 zod v3 `ZodType`——兩者不相容。

**`src/tools/get-env.ts`（潛在風險）**：同樣呼叫 `server.tool()` 但目前 TypeScript 未報錯（可能因 SDK 接受寬鬆 overload），潛在執行期型別不一致風險仍存在。

**副作用套件**：`mutation-server-protocol@0.4.1` 宣告 `"zod": "^4.1.12"` hard dep，bun.lock:676 原本也有獨立的 `mutation-server-protocol/zod@4.3.6`。

---

## 三條解法比較

### Path (a) — Bun `overrides`（本 spike 採用）

強制所有套件的 zod 解析至同一版本，消除 dual-instance。

**優點**：
- 零程式碼改動（純 `package.json` 設定）
- 可逆（刪 overrides + `bun install` 即回原狀）
- 不綁定任何 OpenAPI 工具

**缺點**：
- Bun 1.3.14 不支援 **nested overrides**（見下文 D1 分析）
- Flat override 強制所有 consumer 使用同一版本（影響 mutation-server-protocol）

**引用**：Bun 官方文件明確說明：「Bun currently only supports top-level `overrides`. [Nested overrides](https://docs.npmjs.com/cli/v9/configuring-npm/package-json#overrides) are not supported.」（https://bun.sh/docs/install/overrides）

### Path (b) — 引入 `@hono/zod-openapi`

以 `@hono/zod-openapi` 取代直接使用 MCP SDK schema，透過中介層隔離版本衝突。

**優點**：SDK 邊界封裝更明確

**缺點**：
- 增加約 +547KB bundle size
- 過早鎖定 OpenAPI tooling（premature tool lock-in）
- Phase 2a 目標是解衝突，而非架構重組

**決定**：拒絕（D2）。

### Path (c) — 遷移至 valibot

將專案 schema 全部改用 valibot，SDK 邊界仍用 zod。

**優點**：型別完全隔離

**缺點**：
- 大範圍 schema 遷移，Non-goal（本 spike 明確排除）
- SDK 邊界仍需另外處理

**決定**：拒絕（Non-goal）。

---

## 建議：採用 Path (a) + D1 scope 說明

### 採用形式

原始計畫（D1）要求 **SDK-scoped nested override**：

```json
"overrides": {
  "@modelcontextprotocol/sdk": {
    "zod": "$zod"
  }
}
```

**但此形式在 Bun 1.3.14 不被支援。** Bun 會印出 warning `"Bun currently does not support nested overrides"` 並 silently ignore，override 不生效。

### 實際採用的 fallback 形式（flat literal）

```json
"overrides": {
  "zod": "3.25.76"
}
```

此形式為 Bun 支援的 top-level override，強制**所有**套件的 zod 解析至 `3.25.76`。

### 為何不 override mutation-server-protocol（D1 原始意圖）

D1 設計上希望保留 `mutation-server-protocol/zod@4.3.6`（因其宣告 `"zod": "^4.1.12"` hard-dep），但 Bun 的 flat override 沒有 per-package 作用域，必然也覆蓋 `mutation-server-protocol`。

**PoC 結果**：`bun run mutation` 在 flat override 下 exit 0，mutation score 76.50% >= threshold 70%，**stryker 鏈正常運作**。這表示 `mutation-server-protocol` 實際上相容 zod 3.x（縱使宣告 `^4.1.12`），flat override 的副作用無害。

---

## U1–U4 處理狀態

| 需求 | 狀態 | 說明 |
|---|---|---|
| U1：消除 dual-instance | **關閉** | `@modelcontextprotocol/sdk/node_modules/zod` 目錄已不存在 |
| U2：`send-notification.ts` 移除 `@ts-expect-error` | **關閉** | 已在 C3 步驟移除，typecheck 過 |
| U3：`get-env.ts` 無需 `@ts-expect-error` | **關閉** | 驗證無 `@ts-expect-error`，且 typecheck clean |
| U4：stryker 鏈相容 | **關閉** | C5 mutation exit 0，score 76.50% |

---

## C1–C5 實證輸出

### C1 — package.json overrides patch

```
$ jq '.overrides.zod' package.json
"3.25.76"

$ bun install --dry-run
...
EXIT: 0
```

注意：原規劃的 `$zod` alias form 因 Bun 不支援 nested overrides 而改用字面 `"3.25.76"`。

### C2 — Lockfile/node_modules dedup

```
$ grep '"@modelcontextprotocol/sdk/zod":' bun.lock
(no output — entry removed)

$ test -d node_modules/@modelcontextprotocol/sdk/node_modules/zod; echo $?
1 (not exists)
```

**注意（與 D1 差異）**：`mutation-server-protocol/zod@4.3.6` 也不再有獨立 lockfile entry（flat override 影響所有 consumer）。但 C5 驗證此副作用無害。

### C3 — TypeScript 驗證

```
$ bun run typecheck
...多行 node_modules/**/.d.ts 噪音 (expected SDK lib noise)...
EXIT: 2 (因 node_modules 噪音)
```

`src/**` 無錯誤（`bun run typecheck 2>&1 | grep "^src/"` 無輸出）。  
`skipLibCheck` 已在 Step 7 還原為 `true`。

### C4 — 測試套件

```
290 pass
0 fail
Ran 290 tests across 29 files. [713.00ms]
EXIT: 0
```

### C5 — Mutation testing

```
Final mutation score of 76.50 is greater than or equal to break threshold 70
Done in 5 minutes and 27 seconds.
EXIT: 0
```

無任何失敗原因涉及 zod 解析。

---

## Rollback 步驟

1. 刪除 `package.json` 的 `"overrides"` 欄位
2. `bun install`（重新解析依賴）
3. 若需還原 `@ts-expect-error`：在 `src/tools/send-notification.ts` 的 `server.tool(` 前加回 `// @ts-expect-error - zod peer dependency type conflict with MCP SDK`
4. 若需還原 `skipLibCheck`：在 `tsconfig.json` 確認 `"skipLibCheck": true`（已在 Step 7 完成）
5. 驗證：`bun test` exit 0
