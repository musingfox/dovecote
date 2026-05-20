---
status: proposed
date: 2026-05-20
decision-makers: ""
tags:
  - adr
  - dovecote
  - distribution
---

# dovecote CLI binary v0.1 distribution via GitHub Releases only

## Context and Problem Statement

dovecote 計畫於 v0.1 對外發布 CLI binary，讓使用者以單一 self-contained 可執行檔操作後端的 HTTP API（依 [ADR 0001](./0001-http-api-trunk-and-dual-auth.md)，CLI 為純 HTTP client，僅呼叫 `/v1/*`）。我們必須選定 v0.1 的發布通路（distribution channel）：是僅透過 GitHub Releases 提供 binary、追加 Homebrew tap、發行 npm 套件，還是以 Docker image 為主？

注意：本 ADR **僅決定 distribution channel**。CLI entrypoint 本身（`src/cli.ts`、`package.json` 的 `bin` 欄位、`bun build --compile` build pipeline）為先決條件（precondition），目前 repo 尚未建立，屬本 ADR 之 **out-of-scope**，將於另一份規格與 PR 處理。本 ADR 假設該先決條件成立後，binary artifact 已可由 build pipeline 產出。

## Decision Drivers

* **維運面積（operational surface）**：v0.1 audience 尚未驗證，希望最小化額外 registry / tap / formula 的維運成本
* **可逆性（reversibility）**：v0.1 的通路決策必須能在 v0.2/v0.3 增加 Homebrew / npm / Docker 而不破壞現有使用者
* **Audience size 未驗證**：v0.1 視為 early adopter 通路，尚不需要主流 package manager 的 `upgrade` 流暢度
* **OS 覆蓋**：需同時涵蓋 macOS（arm64 / x64）、Linux（x64 / arm64）、Windows（x64）
* **Signing 成本**：macOS Developer ID + notarization 流程在 v0.1 不擬投入；Windows code signing 同樣延後

## Considered Options

* **GitHub Releases only**（chosen for v0.1）— 透過 git tag 觸發 build pipeline，將 5 個跨平台 binary artifact 附加於 GH release 頁面
* **Homebrew tap**（rejected for v0.1）— 需另建 `homebrew-dovecote` tap repo、維護 formula、跟 binary release cadence 同步；v0.1 audience 尚未證實值得這份額外維運面積，且未驗證使用者是否需要 `brew upgrade` 體驗
* **npm publish**（rejected for v0.1）— 受三項限制阻擋：(1) 本 repo `package.json` 第 5 行 `"private": true` 直接阻擋 `npm publish`；(2) dovecote runtime 為 Bun，npm 套件慣例假設 `node` shebang 與 Node ABI，套用至 Bun-compiled binary 不自然；(3) 單一 binary 約 60–100 MB（embedded Bun runtime），不適合 npm registry 的 tarball 取向
* **Docker image as primary channel**（rejected for v0.1）— Docker 對 MCP client 本地端 dev 過重（需 daemon、需處理 stdio bridge / volume mount），與 CLI 預期的 one-shot binary 互動形態不符

## Decision Outcome

Chosen option: **GitHub Releases only**。v0.1 不發 Homebrew tap、不發 npm 套件、不以 Docker 為主通路。

具體範圍：

* v0.1 透過 GitHub Releases 發 5 個跨平台 binary artifact：
  * `dovecote-darwin-arm64`
  * `dovecote-darwin-x64`
  * `dovecote-linux-x64`（glibc）
  * `dovecote-linux-arm64`（glibc）
  * `dovecote-windows-x64.exe`
* binary 由 Bun `build --compile` 產出，單一 self-contained 檔案、embedded Bun runtime
* macOS binary **不做 Developer ID signing / notarization**；release notes 附手動 workaround：
  ```
  xattr -d com.apple.quarantine ./dovecote
  ```
* artifact 同步附 SHA256 checksum 檔，由 GH 主機分發（不另設 CDN）

### Consequences

* Good, because **零額外 registry / tap 維運**：不需 `homebrew-dovecote` tap repo、不需 npm 帳號 / 2FA / publish workflow
* Good, because **完全可逆**：v0.2 可加 Homebrew formula / npm wrapper / Docker image，皆不破壞既有 GH Releases 通路
* Good, because **artifact 隨 git tag 自動 attach**，release cadence 與 source tag 一致，無第三方 registry propagation delay
* Good, because **Bun cross-compile 一條 build pipeline 涵蓋 5 平台**（`bun build --compile --target=bun-<os>-<arch>`），CI 維護成本低
* Bad, because **macOS 首次執行需手動 `xattr -d com.apple.quarantine ./dovecote`**，被 Gatekeeper 標為 quarantine 時無法雙擊執行；此為 v0.1 已知 UX trade-off，於 release notes 明示
* Bad, because **無 `brew upgrade` 體驗**：使用者需手動下載新版 binary，無 in-place upgrade、無自動更新通路
* Bad, because **v0.1 僅提供 glibc Linux binary，無 musl 變體**，Alpine 等 musl-based distro 使用者目前無對應 artifact
* Neutral, because **每個 binary 約 60–100 MB**（embedded Bun runtime），相較純 Node CLI tar 大一個數量級，但對 GitHub Releases artifact 而言仍在可接受範圍
* Neutral, because **Windows `.exe` 的 icon / version resource metadata 在 Bun 跨平台編譯下有限制**（無法以 macOS / Linux build host 注入 PE resource 中的完整 icon 與 version block），v0.1 接受空白 metadata
* Neutral, because **artifact 由 GitHub 主機分發 + checksum**，無自家 CDN 成本但下載速度受 GH 區域影響
* Neutral, because **CLI entrypoint 尚未建立**（`src/cli.ts`、`package.json` `bin` 欄位）為先決條件，屬另一份規格 / PR 範圍，不在本 ADR 內

## More Information

* **未來通路（future-considered）**：
  * **Homebrew tap**：俟 audience size 成長到值得額外 tap 維運（評估依據：GH Releases 下載量、issue 中對 `brew install` 的需求量）時再 re-evaluate；可於 v0.2 / v0.3 引入
  * **npm publish**：需先翻轉 `package.json` 的 `"private": true`、並設計 npm-wrapper 形態（npm package 內含小 launcher，自 GH Releases 下載對應 platform binary，避免 npm tarball 直接夾帶 60–100 MB binary）；同樣依 audience size 再評估
  * **Docker image**：若未來出現 server-side / container-based 使用情境再行評估，v0.1 不涵蓋
* **Signing follow-up（v0.2）**：
  * macOS Developer ID signing + notarization（apple-codesign / `codesign` + `xcrun notarytool`），消除 `xattr` workaround
  * Windows code signing（EV cert / Azure Trusted Signing），減少 SmartScreen 警告
* **Cross-reference**：
  * [ADR 0001](./0001-http-api-trunk-and-dual-auth.md) — CLI 為純 HTTP client，僅呼叫 `/v1/*`，為本 ADR 的架構前提
* **Out-of-scope precondition**：CLI entrypoint（`src/cli.ts`）、`package.json` `bin` 欄位、`bun build --compile` build pipeline 尚未建立，屬本 ADR 範圍外的先決條件
