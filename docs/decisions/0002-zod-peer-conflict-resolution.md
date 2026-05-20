---
status: proposed
date: 2026-05-20
decision-makers: ""
tags:
  - adr
  - dovecote
  - dependencies
---

# Resolve zod peer dependency conflict via Bun overrides

## Context and Problem Statement

`@modelcontextprotocol/sdk@1.29.0` 宣告 peer dependency `"zod": "^3.25 || ^4.0"`，Bun 預設解析至 `zod@4.3.6` 並在 `node_modules/@modelcontextprotocol/sdk/node_modules/zod` 建立獨立副本（dual-instance）。此衝突是 ADR 0001 所標注的 Phase 2a blocker（見 0001 Consequences 段落：「OpenAPI / zod-to-openapi 受 MCP SDK 內部 zod peer dep 衝突影響，必須先解（見 Phase 2a）」）。

衝突的直接可見症狀為 `src/tools/send-notification.ts` 需要 `@ts-expect-error` 抑制型別衝突；潛在風險為執行期兩套 zod 實例各自驗證導致 schema 判斷不一致。

## Decision Drivers

* **Bundle size**：避免引入不必要的大型套件（如 `@hono/zod-openapi` +547KB）
* **可逆性**：應能以最小代價回滾，不引入深層架構改動
* **OpenAPI 工具無關性**：不過早綁定特定 OpenAPI tooling
* **Stryker 相容性**：`mutation-server-protocol@0.4.1` 宣告 `"zod": "^4.1.12"` hard-dep，解法不得破壞 mutation testing 鏈

## Considered Options

* **Path (a)** — Bun `overrides` 強制單一 zod 版本
* **Path (b)** — 引入 `@hono/zod-openapi` 作為 schema bridge
* **Path (c)** — 遷移 schema 至 valibot

## Decision Outcome

Chosen option: **Path (a) — Bun `overrides`**，因為它以最小代價直接消除 dual-instance，不引入新的 tooling 依賴，且 PoC 驗證通過（見 spike doc）。

### 實作細節

原規劃的 SDK-scoped nested override（`"@modelcontextprotocol/sdk": { "zod": "$zod" }`）在 Bun 1.3.14 不被支援（Bun 只支援 top-level overrides）。PoC 改用 flat literal override：

```json
"overrides": {
  "zod": "3.25.76"
}
```

此形式強制所有 consumer 使用 `zod@3.25.76`，包含 `mutation-server-protocol`。Spike PoC 驗證 stryker 在此設定下正常運作（mutation score 76.50%，exit 0），D1 原始的「不影響 mutation-server-protocol」目標雖未能透過 scoped override 達成，但實際相容性測試確認無害。

### Consequences

* Good, because dual-instance 消除後 `src/tools/send-notification.ts` 的 `@ts-expect-error` 可安全移除
* Good, because 單一 zod 實例確保 schema 驗證行為一致，消除潛在執行期不一致風險
* Good, because 完全可逆：刪除 `overrides` + `bun install` 即可回滾
* Good, because 無新增 runtime dependencies，bundle size 不變
* Neutral, because Bun 不支援 nested overrides，flat override 影響範圍比原設計更廣（所有 consumer 共用一版本）
* Neutral, because 若 Bun 未來支援 nested overrides，可縮小 override 作用域以降低影響面
* Bad, because `mutation-server-protocol` 宣告 `^4.1.12` 但實際接到 3.25.76，兩者語意差距大——若未來 `mutation-server-protocol` 嚴格依賴 zod 4.x 特性，可能出現執行期錯誤

## Pros and Cons of the Options

### Path (a) — Bun `overrides`

* Good, because 零 runtime 新增、不改 source code（除移除 `@ts-expect-error`）
* Good, because 可逆、侵入性最低
* Good, because 直接消除 lockfile dual-instance（C2 驗證）
* Bad, because Bun 不支援 nested overrides，無法做到 SDK-scoped 精準控制
* Bad, because flat override 的 zod 版本選擇（3.x 或 4.x）必須兼顧所有 consumer

### Path (b) — `@hono/zod-openapi`

* Good, because SDK 邊界封裝更明確，型別系統更完整
* Bad, because +547KB bundle size
* Bad, because 過早鎖定 OpenAPI tooling，Phase 2a 尚未定 API schema 策略
* Bad, because 引入新的抽象層，增加維護複雜度

### Path (c) — 遷移至 valibot

* Good, because 從根本上隔離型別空間
* Bad, because 大範圍 schema 遷移，成本高
* Bad, because SDK 邊界問題依然存在，並未解決

## More Information

* Spike 文件（含 C1–C5 完整實證輸出）：[docs/spikes/2026-05-zod-peer-conflict.md](../spikes/2026-05-zod-peer-conflict.md)
* Bun overrides 文件：https://bun.sh/docs/install/overrides
* 相關 blocker context：[ADR 0001](0001-http-api-trunk-and-dual-auth.md)（Phase 2a 說明）
