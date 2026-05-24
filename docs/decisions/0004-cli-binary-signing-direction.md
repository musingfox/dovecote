---
status: accepted
date: 2026-05-25
decision-makers: "musingfox"
tags:
  - adr
  - dovecote
  - distribution
  - security
---

# dovecote CLI v0.2 binary signing：採用 cosign-keyless（Sigstore）

## Context and Problem Statement

[ADR 0003](./0003-cli-binary-distribution.md) 將 v0.1 binary 透過 GitHub Releases 發布，且明示「macOS Developer ID signing / notarization 與 Windows code signing」延後至 v0.2 處理（ADR 0003 §More Information → Signing follow-up）。Phase 4 task title「重新評估時機與 trust model」要求 v0.2 規劃前選定簽章方向，避免 v0.2 開工時再被選擇癱住。

v0.1 釋出時，macOS 使用者首次執行需要手動 `xattr -d com.apple.quarantine ./dovecote`，Windows 使用者在 SmartScreen 提示「unrecognized publisher」。除了 UX 摩擦外，目前 binary **沒有任何來源真偽證明**：使用者只能用 `SHA256SUMS` 驗證 archive 與 release 頁上的 hash 相符，但無法驗證該 hash 真的由 musingfox/dovecote 的 release pipeline 產出（攻擊者只要能改動 release，hash 與 binary 可以同時被換掉）。

本 ADR **僅決定 v0.2 簽章方向**。實作（CI workflow 修改、cosign 嵌入、release notes 範例）將另起 issue / PR 處理；本 ADR 之 out-of-scope 與 ADR 0003 一致：CLI entrypoint、build pipeline 細節皆視為先決條件。

## Decision Drivers

* **可驗證性（verifiability）**：使用者要能在不信任 GitHub UI 的情況下驗證 binary 真的來自 musingfox/dovecote 的 release pipeline
* **vendor lock-in 風險**：v0.2 audience 尚未穩定，不希望把驗證機制綁死在單一商業 CA 或單一作業系統廠商
* **直接金錢成本**：個人 maintainer 預算敏感；任何方案的年費若 > USD 100 都需要有驗證得到的 audience 才值得
* **維運面積**：CI workflow 已含 5 個 build target + GH Release publish；新增的簽章流程必須在同一個 workflow 跑完，不引入額外 self-hosted runner 或 build host
* **可逆性**：v0.2 的決策必須能在 v0.3 / v0.4 平行加入 native signing 而不破壞既有驗證鏈
* **OS 對稱**：方案最好同時涵蓋 macOS / Linux / Windows 三平台，避免「只簽 macOS」這類偏頗

## Considered Options

* **cosign-keyless（Sigstore + GitHub Actions OIDC，chosen for v0.2）** — release workflow 內以 cosign 對每個 archive 簽章，憑證由 Sigstore 公共 Fulcio CA 即時簽發，透明 log 寫入 Rekor。release 頁面附 `.sig` + `.pem` sidecar 與既有 `SHA256SUMS` 並列
* **Apple Developer ID + notarization**（rejected for v0.2）— 需向 Apple Developer Program 申請 USD 99/yr 帳號、於 release workflow 整合 `codesign` + `xcrun notarytool`，且 build host 必須是 macOS runner
* **Windows code signing（EV cert / Azure Trusted Signing）**（rejected for v0.2）— EV 證書年費約 USD 300-700，Azure Trusted Signing 月費約 USD 10 起。需 KMS / Key Vault 整合，CI 流程顯著複雜化
* **Apple + Windows native（雙平台原生簽章）**（rejected for v0.2）— 兩者疊加，年費約 USD 400+
* **cosign + Apple + Windows（完整覆蓋）**（rejected for v0.2）— 三者並行，最高維運面積與成本
* **進一步延後至 v0.3+**（rejected）— v0.1 已 ship，xattr workaround 已在 release notes 公開存在，若 v0.2 仍無任何簽章作為，會被視為「永遠的 trade-off」而非「v0.1 暫時取捨」

## Decision Outcome

Chosen option: **cosign-keyless（Sigstore）**。v0.2 在 release workflow 加入 cosign 簽章步驟，對每個 archive 與 `SHA256SUMS` 出 `.sig` + `.pem`，附加於 GitHub Release 頁。**不**做 Apple Developer ID signing / notarization，**不**做 Windows code signing；xattr workaround 與 SmartScreen 提示在 v0.2 仍然存在，並繼續於 release notes 與 [setup-dovecote-runbook.md](../setup-dovecote-runbook.md) 中說明。

具體範圍（將於 follow-up issue 細化）：

* release workflow `release-cli.yml` 在 5 個 build target 完成後、`Publish GitHub Release` 之前，加一段 cosign 簽章步驟：對每個 `dovecote-bun-*.tar.gz` / `dovecote-bun-*.zip` 與 `SHA256SUMS` 各簽一份，輸出 `<artifact>.sig` + `<artifact>.pem`
* 使用 `sigstore/cosign-installer@v3` action 安裝 cosign；簽章使用 `cosign sign-blob --yes --output-signature ... --output-certificate ...` 透過 GH Actions 內建 OIDC token，免管私鑰
* `.sig` / `.pem` sidecar 與既有 `SHA256SUMS` 並列附加於 GH Release，由 `softprops/action-gh-release@v2` 一併上傳
* `setup-dovecote` composite action（在 v0.2 release 之後）增加 optional `verify: cosign` 輸入；當 caller 傳入時 `cosign verify-blob` 對下載的 archive 驗證；預設關閉（保持向後相容，且 v0.1 release 沒有 sidecar）
* runbook 補一段 cosign manual verify 範例，給 self-hosted / 不用 setup-dovecote 的 consumer

### Consequences

* Good, because **零年費、零 vendor lock**：Sigstore Fulcio / Rekor 由 Linux Foundation 運營，cosign 為 OSS。即使 Sigstore 服務遷移或停運，已生成的 `.pem` 仍可離線用 transparency log 對照驗證
* Good, because **OS-symmetric**：linux/macos/windows 三平台 archive 都簽，不偏袒任何單一作業系統
* Good, because **cryptographic provenance**：使用者可確認 binary 由 `musingfox/dovecote/.github/workflows/release-cli.yml` 在 `cli-v*` tag 觸發下產生（cosign 憑證內嵌 OIDC claims 含 repo + workflow + ref）；單獨換 binary 無法重做簽章
* Good, because **release pipeline 一次跑完**：cosign 步驟在 ubuntu runner 內幾秒完成，不需額外 macOS host 或長時程 notarization wait
* Good, because **與 native signing 完全 orthogonal**：v0.3 / v0.4 可平行加 Apple Developer ID / Windows EV 而不改動 cosign 流程，consumer 同時擁有 cryptographic provenance 與 native UX
* Bad, because **macOS xattr workaround 與 Windows SmartScreen 提示 v0.2 仍然存在**：cosign 不影響 OS 原生信任鏈；UX 摩擦續存
* Bad, because **cosign 對非技術使用者不直觀**：需手動 `cosign verify-blob` 或仰賴 `setup-dovecote@<tag>` 整合，無 Gatekeeper / SmartScreen 那種「靜默就過」體驗
* Neutral, because **Sigstore 服務可用性**：Fulcio + Rekor 為公共服務，若 release 當下 Sigstore 短暫不可用，workflow 會 fail；release 需 re-run 而非降級
* Neutral, because **新增兩類 sidecar（`.sig` + `.pem`）**：release 頁面 asset 數量從 6（5 archive + SHA256SUMS）增至 18（5 archive + SHA256SUMS + 6 個 `.sig` + 6 個 `.pem`）

### Confirmation

決策落實的判準：

1. v0.2 release workflow PR 合併且首個 v0.2 tag 推送後，release 頁面包含完整 `.sig` + `.pem` sidecar
2. `cosign verify-blob` 對任意 archive 通過（GH workflow OIDC claims 對齊 repo + ref）
3. `setup-dovecote` action 有 `verify: cosign` 開關且預設關閉
4. setup-dovecote-runbook 加上 cosign manual verify 章節

不通過判準 = 視為 v0.2 簽章未完成，應於 release notes 註明，並考慮 hotfix 補上。

## Pros and Cons of the Options

### cosign-keyless（Sigstore + GitHub Actions OIDC）

OIDC 即時憑證 + transparency log，零私鑰管理，CI workflow 幾行就完成。

* Good, because 零年費；無 CA 私鑰外洩風險
* Good, because OS-symmetric 三平台一致
* Good, because 與 native signing orthogonal，未來可疊加
* Good, because cryptographically tied to GitHub Actions OIDC（repo + workflow + ref claims），偽造門檻高
* Bad, because 不解決 macOS Gatekeeper / Windows SmartScreen UX 摩擦
* Bad, because verify 需要使用者主動執行（非 OS 內建）
* Bad, because 依賴 Sigstore 公共基礎設施（Fulcio + Rekor）

### Apple Developer ID + notarization

macOS 原生 trust chain；Gatekeeper 自動驗證後免去 xattr workaround。

* Good, because macOS 使用者無感（Gatekeeper 通過後直接執行）
* Good, because Apple 是 macOS 信任根，UX win 明顯
* Bad, because USD 99/yr Apple Developer Program
* Bad, because vendor lock-in（Apple 帳號被停 / 政策變動 → 整個 macOS 釋出鏈失效）
* Bad, because notarization 流程需 macOS build host 或 Apple-hosted notarytool API（額外 wall-clock + 失敗模式）
* Bad, because 只覆蓋 macOS，Windows + Linux 完全不受惠
* Bad, because 與 v0.1 audience 規模不對稱（USD 99 對於尚未驗證的使用群是 over-investment）

### Windows code signing（EV cert / Azure Trusted Signing）

Windows 原生 trust chain；SmartScreen 累積 reputation 後不再提示。

* Good, because Windows 使用者最終無 SmartScreen 警告（但需 reputation 累積期）
* Good, because Windows 是部分企業 CI / 工作站場景的硬需求
* Bad, because USD 300-700/yr（EV）或 USD 10+/月（Azure Trusted Signing）
* Bad, because vendor lock-in 比 Apple 更深（CA 私鑰 → KMS / HSM 整合 → CI workflow secret management）
* Bad, because EV cert 初期 reputation 期仍會被 SmartScreen 提示
* Bad, because 只覆蓋 Windows，macOS + Linux 不受惠
* Bad, because Azure Trusted Signing 將 release pipeline 綁到 Azure 服務（額外帳號 / 計費關係）

### Apple + Windows native（雙原生簽章）

兩者疊加；完整 OS 原生 UX。

* Good, because macOS + Windows 兩端原生 UX 同時 win
* Bad, because USD 400+/yr 直接成本
* Bad, because 雙 vendor 維護面（兩套 secret、兩條失敗模式、兩個續約節點）
* Bad, because Linux 仍無 cryptographic provenance
* Bad, because 與 v0.2 規模嚴重不匹配；應在 audience 證實後再考慮

### cosign + native（完整覆蓋）

cosign 提供 cross-platform attestation；native 處理各平台原生信任鏈。

* Good, because 最完整：cryptographic provenance + 原生 UX
* Bad, because 同時承擔上述 2 種方案的所有 Bad 項目
* Bad, because 維運面積最大；個人 maintainer 不適合在 v0.2 就承擔

### 進一步延後至 v0.3+

不在 v0.2 做任何簽章，繼續 v0.1 的 xattr workaround + SHA256 only。

* Good, because 零工作量
* Bad, because xattr workaround 已被 release notes 公開存在，v0.2 沒有任何改善等同放任 trust gap
* Bad, because `SHA256SUMS` 自身無 provenance，attack surface 不可忽視
* Bad, because v0.2 release notes 將難以解釋為何已知 trust gap 沒有任何處置

## More Information

* **Follow-up implementation issue**：[#1 v0.2 CLI binary signing: cosign-keyless implementation](https://github.com/musingfox/dovecote/issues/1) — release workflow + setup-dovecote `verify` input + runbook cosign section + rc-tag validation
* **Re-evaluation triggers（朝向 native signing）**：當以下任一條件成立，重新評估是否加開 Apple Developer ID / Windows code signing：
  * GH Releases CLI binary 月下載量 > 1000 持續 3 個月
  * Issue 中提及 `xattr` workaround 摩擦的回報 > 5 件
  * 企業使用者明確要求 Windows EV 簽章
* **Cross-reference**：
  * [ADR 0003](./0003-cli-binary-distribution.md) — v0.1 distribution channel，本 ADR 為其 Signing follow-up 之 v0.2 具體化
  * [setup-dovecote-runbook.md](../setup-dovecote-runbook.md) — consumer 端使用文件，v0.2 cosign verify 步驟將加在 macOS workaround 章節之前
* **Sigstore / cosign references**：
  * https://docs.sigstore.dev/
  * https://github.com/sigstore/cosign
  * https://github.com/sigstore/cosign-installer（GH Actions integration）
