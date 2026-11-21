# Pi Agent / Pi Web 共用連線優化調查

本次把既有 `@woowtech/pi-paseo` 通用化為 **Agent Connect／代理連線**。GUI 可選擇 Woowtech Smart、Apporo Smart、Paseo；保留 npm 名稱、工具 ID、舊設定與路由。舊安裝預設仍為 Paseo；一次使用一個標的，可切換。使用者已確認此命名、既有 npm 名稱與單一標的切換方式。

## Repository 與平台關係

| 平台／用途 | 權威來源 | 本次調查基準 |
|---|---|---|
| 共用連線 runtime 與獨立 Pi Web adapter | [pi-paseo-plugin](https://github.com/WOOWTECH/pi-paseo-plugin) | `42ed67b020f190f7e91609801cb56b603de461d5`，0.1.16 |
| native/k3s 使用的 Pi Web 整合介面 | [pi-omnigent-plugin](https://github.com/WOOWTECH/pi-omnigent-plugin) | `2bfdd7d302b075ddfbcdbd1ff1d8cf656d1d145a`，0.3.32 |
| Ubuntu、macOS、Windows WSL2 | [Woow_native_os_pi_agent](https://github.com/WOOWTECH/Woow_native_os_pi_agent) | `91800299ca6b5f408746ddf59e02b8f7b8645262` |
| k3s | [Gitea Woow_k3s_pi_agent_package](https://git-prod.woowtech.io/woow-paas/Woow_k3s_pi_agent_package) | `97a4cdaae4adcc2b05931d5cedd83122f8877d62` |
| Home Assistant Add-on | [Woow_ha_pi_agent_add_on](https://github.com/WOOWTECH/Woow_ha_pi_agent_add_on) | `c56cdd5da5e7e5ea22e5ed5f777ab9cf02df7683` |
| 共用 CLI、skills、MCP 安裝 | [pi-agent-shared-runtime](https://github.com/WOOWTECH/pi-agent-shared-runtime) | 0.1.4；與這次品牌選擇無直接修改需求 |
| Smart 品牌協定與預設值 | [woowtech-smart](https://github.com/WOOWTECH/woowtech-smart) | main `9214c6ea87`；品牌 manifest 與 protocol 實作 |

k3s 的 GitHub repo 是單向鏡像；本次平台候選變更在 Gitea origin 的 checkout。其 `paas/` 子目錄亦為鏡像，不直接改寫。Windows 現有 README 描述 WSL2 使用 Linux 安裝路徑；使用者已確認本次只涵蓋現有 WSL2，不包含新增原生 Win32 安裝器。

native 與 k3s 使用 Pi Web 0.10.0 的 combined adapter；HA 已使用官方 Pi Web 0.12.0 與獨立 Unix socket bridge。這次兩條 GUI 都有實作，沒有把舊 adapter 套進 HA。

## 參考對話

- [Apporo／Woowtech Smart 對話一](https://omnigent.woowtech.io/c/53a4073da97a49aea3844f299c59f590?message=codex_01a1f703-c2db-72f2-9ca7-d6f5afcfc155)
- [Apporo／Woowtech Smart 對話二](https://omnigent.woowtech.io/c/b3b8beec301b4899817b2ea7a7780ed7?message=codex_01a1f886-6f68-7891-8ea7-8e4b5d5e3b76)

已讀取可取得的對話歷史；歷史尾段未包含指定 message ID，因此品牌端點與協定以 `woowtech-smart` 原始碼及實際 relay 驗證交叉確認。

## 連線合約

| 標的 ID | GUI | Web app | relay |
|---|---|---|---|
| `woowtech` | Woowtech Smart | `https://smart.woowtech.io` | `relay.woowtech.io:443` |
| `apporo` | Apporo Smart | `https://smart.apporo.ai` | `relay.apporo.ai:443` |
| `paseo` | Paseo | 官方 `https://app.paseo.sh`；Pi 內提供 `/paseo-web` | `relay.paseo.sh:443` |

三者使用 V2 offer，含 server ID、daemon public key 與 TLS relay endpoint。共用 Paseo 0.11.2 runtime 的實際設定 schema 已驗證接受 `app.baseUrl`、`daemon.relay`、CORS 設定。

儲存標的會清除舊配對與 relay 驗證狀態。執行中的 daemon 不會被偷偷停止；GUI 顯示待套用，使用者停止並啟動服務後套用新標的。配對與設定寫入共用 runtime lock；配對回傳必須符合選定品牌、固定 origin、offer 格式及 relay endpoint。未儲存草稿、過期輪詢與跨品牌回覆不能恢復舊配對按鈕或連結。偏好檔損毀時拒絕啟動，不自動回退至其他品牌。

## 候選交付與發行界線

- `@woowtech/pi-paseo` 候選版本：**0.1.17**。
- `@woowtech/pi-omnigent-plugin` 候選版本：**0.3.33**。
- 確切 tarball、SHA-256、各平台候選 pin 與驗證證據位於[候選產物清單](../../artifacts/candidates.json)及相鄰平台 checkout。
- 這些是可供審查的本機候選原始碼與套件，尚未代表 GitHub/npm 發布、OS installer 重建、容器映像發布或正式環境部署。
- 發行順序：共用連線套件 → Omnigent combined adapter → native/k3s/HA pins → 各平台 build／升級驗收。

## 已驗證與尚待驗收

已執行 backend 213 項測試、實際 Paseo schema 檢查、獨立 Pi Web adapter 79 項跨套件測試與 TypeScript，以及 HA bridge/API、官方 0.12 compiled patch 測試。React GUI 與 HA GUI 均用 Chromium 執行桌面與手機三標的流程；API 使用 fixture，不把這些結果當作正式 relay 完整配對證明。combined adapter 的 117 項功能／host 合約測試、12 項 metadata／verifier 測試、生產 build、TypeScript、實際打包安裝器與 13 個 production 瀏覽器驗收情境通過。

另外已用確切的 0.1.17 tarball 對 Woowtech 與 Apporo 公開 relay 執行隔離測試：品牌配對 URL／offer 驗證、加密 SDK 連線與 daemon status RPC 均成功。全部 providers 停用、零模型對話，測試 daemon 與暫存目錄已清理；[無憑證驗證結果](../../artifacts/relay-smoke-results.json)可供核對。此結果仍未涵蓋品牌瀏覽器／手機的完整配對與 provider 對話流程。

Combined plugin 最後一次完整 Node 測試為 **261/262 通過**；獨立 installer 重跑為 **61/62 通過**，兩次失敗的案例不同，涉及 `/proc` 程序觀測／退出後清理時序。相關 installer 實作與案例未修改；特定 receipt 案例單獨測試通過。此主機無法建立 private PID namespace，也沒有 Docker／Podman，發布前必須補跑 repo 既有的 private-PID CI；**不可宣稱完整測試全數通過**。其他 Node 200 項與 Python 130 項通過。[完整驗證摘要與原始失敗紀錄](../../artifacts/verification/combined-verification-summary.json)保留全部結果。

尚需平台主機實測：macOS arm64/Intel、Windows WSL2、實際 HA Supervisor ingress、k3s 映像啟動與升級。手機背景推播使用 Smart fork 的品牌 FCM sender，現行共用 runtime 僅切換連線設定，**不包含品牌手機推播支援**。

下一輪共用優化建議：先固定三種 GUI/runtime 合約與五平台的發行矩陣，再將目前散落各 repo 的版本 pin、guard 與 tarball 驗證集中為可重複的發行檢查。是否新增原生 Windows 安裝器與品牌推播，需要另立明確需求與平台驗收。

## 原始碼與交付入口

- [Native 候選整合說明](../../Woow_native_os_pi_agent/docs/AGENT_CONNECT_CANDIDATE.md)
- [k3s 候選整合說明](../../Woow_k3s_pi_agent_package/docs/AGENT_CONNECT_CANDIDATE.md)
- [HA 候選整合說明](../../Woow_ha_pi_agent_add_on/docs/AGENT_CONNECT_CANDIDATE.md)
- [Combined adapter 發行順序](../../pi-omnigent-plugin/docs/agent-connect-rollout.md)
- [桌面／手機 GUI 結果](../../artifacts/pi-web-browser/results.json)與[手機畫面](../../artifacts/pi-web-browser/agent-connect-390.png)
