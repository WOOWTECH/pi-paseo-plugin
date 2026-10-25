# Pi7 併裝驗收：Paseo 0.1.4、Omnigent 0.3.5 → 0.3.6

2026-10-25 在 Pi7 持久化容器安裝兩個公開 Git tag，執行 `pi-omnigent install-ui` 建置共用 Pi Web 0.10.0 介面，重啟工作負載。當次 Pod 就緒且重啟數為 0；Paseo daemon 由插件管理並可連線。初始化對話「Paseo 連線初始化」只建立一筆，重啟後仍存在。兩個 repo 的 GitHub `private` 欄位均為 `false`。

- [Paseo v0.1.4 CI](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/40158799457) 通過；[Omnigent v0.3.5 CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40160314218) 的 Node 22.19、Node 22.23、原生 UI 與共用 UI 工作均通過。
- 桌面版設定列按 **MCP → Omnigent → Paseo** 顯示；手機 390 px 選單含 `Paseo`，文件沒有水平溢出，兩者均無瀏覽器 JavaScript 錯誤。修正了 v0.3.4 實際顯示 `settings.paseo` 的標籤問題。
- 設定面板產生 `https://app.paseo.sh` 官方配對連結；儲存配對資訊的私人檔案權限為 0600。公開狀態 API 回傳 `private, no-store`，沒有輸出配對連結。Pi Web 外層未授權請求回傳 401，內層跨站寫入回傳 403。
- 固定 Paseo 0.11.2 的動態模型目錄當下列出 Claude 17、Codex 8、Pi 53 個模型，模式分別為 5、3、0。這些數量會隨上游及帳號狀態變動。
- Pi provider 使用 `litellm/openrouter/free` 完成首輪與續聊兩次實際回覆，驗收 agent 已歸檔；最後一次檢查為 `2026-10-25T04:11:35Z`。
- Pi7 的 Claude Code 與 Codex 官方 CLI 均顯示未登入。實際兩輪驗收分別回報 `PROVIDER_AUTH_REQUIRED`、`PROVIDER_TURN_FAILED`，因此這兩個 provider **尚未通過 Pi7 對話驗收**。Omnigent server 此容器亦尚未登入。
- 官方 relay 的配對連結已生成，但尚未在另一端完成 Connect；`relayVerified` 仍為 false。完成官方登入與 Connect 後，需重跑三個 provider 的首輪、續聊、模型選擇及遠端連線驗收，才能將 Pi7 標記為完整上線。

同日將 Omnigent 升至公開 `v0.3.6`，其 [發行 CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40161080957) 與 [main CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40161080793) 均通過。Pi7 共用介面 receipt 為 `omnigent+paseo`，包含 `mcp`、`omnigent`、`paseo` 三個設定區，仍以固定 Pi Web commit 建置。新 Pod 就緒、重啟數 0，初始化對話與私人配對檔案均留存，Paseo daemon 可達。

- 桌面與 390 px 手機重新驗證設定列、Paseo 分頁及無 JavaScript 錯誤；手機無水平溢出。
- 分別從原生設定面板按「讀取 Claude Code／Codex／Pi 模型」，三次 API 均回傳 200 並更新介面；模型數為 17／8／53，模式數為 5／3／0。
- 新 Pod 的 Pi provider 再次完成兩輪實際對話與測試 agent 歸檔，時間為 `2026-10-25T04:18:18Z`。Claude／Codex 登入與 Paseo Remote Connect 仍待完成；relay 即時連線未知，歷史驗證為 false。

# 0.1.3 商業部署驗證

2026-10-11，以 `471bbbb` 的 0.1.0 為基準，在獨立 checkout 及 Pi 5 實測。

- 插件測試 94/94、安裝與 bootstrap 測試 42/42、主機整合與安全 route 測試 91/91。
- TypeScript、主機 lint、production 建置、發行包檢查、無 dev/peer 依賴的全新 production 安裝通過。
- 插件、主機、固定 Paseo runtime 的執行依賴 `npm audit --omit=dev` 均為 0 項已知弱點；另核對實際安裝的 Pi SDK 私有依賴為 `brace-expansion` 5.0.12。
- 固定修補 runtime revision：`0.11.2-r1-b60170bb6826`。Paseo 0.11.2 API 相容性及 CLI 啟動通過。
- 真實故障注入後自動復原約 56.5 秒；手動停止後觀察 16 秒不會自行啟動，再啟用沿用相同初始化對話。
- CI 曾因測試僅允許 20 ms 啟動 `flock` 而偶發失敗；回收測試使用 2 秒完整操作時限，避免 CPU 排程速度左右斷言，正式服務時限不變。其後補上截止時間耗盡的錯誤分類；3 個確定性重現修正前失敗、修正後通過，獨立工具失敗仍保留專用錯誤代碼。
- 三項跨程序鎖回收重現測試修正前失敗、修正後通過。缺少 Linux `flock`、不安全路徑及取消操作會以固定代碼停止。
- 初始化對話在真實 ID 確認後立即存檔；命名、prompt 或 shutdown 失敗仍保留同一對話。
- 更新採不可變 source/runtime 版本目錄、核心鎖、時限與程序群組清理；發布中斷後可依 hash receipt 恢復。回滾保留已偵測的外部改動。

Pi 5 同一環境連續 5 組、每組 4 個並行 runtime 狀態讀取：0.1.0 P50 2,190 ms、P95 3,225 ms；最終部署的 0.1.3 暖快取 P50 3 ms、P95 4 ms。此數字為 runtime 函式量測，並非外部 HTTP 延遲；冷查詢仍需 provider 探測。快取使用單調時鐘，校時不延長上限 3 秒；停止及程序身分變更每次重新確認。

從驗收主機連續發出 20 次已登入的正式 HTTPS 狀態請求，P50 750 ms、P95 2,375 ms、最大 2,626 ms；包含入口代理、網路及快取過期後的冷探測。因此此次尚未證明外部端到端 P95 顯著下降。

在 Pi 5 的獨立測試 daemon 使用上述修補 runtime 與現有帳號，完成以下真實驗收；每項有新的續聊回覆，並在最後歸檔測試 agent、停止測試 daemon。

| Provider | 驗收模型 | 初次回覆 | 續聊 | 測試資源清理 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-opus-5-5` | 通過 | 通過 | 通過 |
| Codex | `gpt-6.1-sol` | 通過 | 通過 | 通過 |
| Pi | `openai-codex/gpt-5.6-sol` | 通過 | 通過 | 通過 |

已將 Pi 5 正式部署切換到公開 `v0.1.3`，固定 source commit `415e0aa37b6244a63270c216087325d4a944f8b7`。正式主機建置使用固定 Pi Web 基底，完整 prebuilt 的 65,153 個檔案大小、SHA-256 或 symlink 目標均經核對。原安裝及建置保留供回滾；Pi package 登記已替換為單一新來源。

- 兩個 0.1.3 發行 CI 都通過：[main](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/38175896202)、[tag](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/38175896089)。
- 正式服務重啟及入口防護更新後，再次完成上述三種 provider 的首輪、續聊與歸檔；最後一次驗收時間為 `2026-10-11T21:51:41.897Z`。測試保留對話紀錄，只歸檔此次建立的 agent。
- 沿用原初始化對話，沒有重複建立；重啟後容器就緒，重啟數為 0。一次觀察記憶體約 1,433 MiB，低於 4 GiB 限制，這不是容量上限測試。
- 正式設定頁回應 200；桌面 1,440 px 與手機 390 px 沒有水平溢位或 JavaScript 錯誤。
- 從設定頁生成配對、開啟官方 Paseo 並完成 Connect；透過 relay 讀取本容器工作區。更新入口防護後重新配對仍通過。
- 在官方 Paseo 實際選取 Claude `Opus 5.5`、Codex `GPT-6.1-Sol`、Pi `GPT-5.6 Sol`。目錄分別為 17/7/9 個模型、5/3/0 個 provider 權限模式；Pi 此版本沒有額外權限模式選單，提供模型思考設定。
- Claude 模式選单實際顯示 Plan mode、Always ask、Accept file edits、Auto mode、Bypass，並成功選取 Always ask。
- 官方 Paseo UI 選取 Codex 的 Default permissions 後，送出兩輪訊息並收到正確的記憶回覆；沒有 JavaScript 錯誤，測試 agent 已歸檔。
- 外部 API 拒絕無效 JSON 400、內容類型 415、無效 action 400、超過 16 KiB 的 body 413，以及不可存取工作目錄 404；回應帶 `private, no-store` 與 `no-referrer`。

外部驗收另發現既有 Nginx 登入代理會清空 Origin：直連插件後端為 403 的異站請求，經代理卻回傳 200。已在代理加入僅針對 Paseo API 的來源檢查，通過 `nginx -t`、重新部署並重跑原始重現；異站 Origin 與瀏覽器 cross-site 現在均回傳 403，且具有上述隱私標頭。原 ConfigMap 留存於私人部署備份；部署方式見 [代理來源防護](proxy-origin.md)。

驗收範圍為 Linux 單一 Pi Web 使用者環境；尚未以長期 soak 或大量並行模型對話建立容量/SLA 承諾。狀態快取和歷史對話驗證不能代替目前 provider 登入、額度及實際連線。外部非合作寫入者的最後檔案 rename race、刻意逃離 session 的程序需由部署管理及 OS/容器隔離處理。

# 0.1.0 驗證紀錄

2026-10-11 在目標 Pi 容器使用公開 GitHub 網址完成直接安裝，重新啟動後驗證正式 Pi Web 整合層。

- 插件測試：45 項通過。
- 安裝器測試：12 項通過。
- Pi Web 整合及 route 測試：44 項通過。
- TypeScript、production 安裝（略過開發及 peer 依賴）、發行包及 GitHub CI：通過。
- Pi Web 正式建置、設定頁與插件 API：通過；桌面／手機版沒有水平溢位或 JavaScript 錯誤。
- 首次啟動建立初始化對話；重複啟動沿用相同對話。
- 從插件配對入口開啟官方 Paseo，完成 Connect 後透過 relay 讀取本容器工作區。

| Provider | 動態模型數 | 驗收模型 | 初次回覆 | 續聊 |
| --- | ---: | --- | --- | --- |
| Claude Code | 17 | `claude-opus-5-5` | 通過 | 通過 |
| Codex | 7 | `gpt-6.1-sol` | 通過 | 通過 |
| Pi | 9 | `openai-codex/gpt-5.6-sol` | 通過 | 通過 |

模型與帳號狀態會隨執行環境改變；以上是此次實際驗證結果。新裝置仍需由受保護設定頁產生自己的配對連結。

此次修正了 production 安裝缺少 Pi SDK、更新時誤啟動已停止服務，以及容器建置記憶體不足的問題。安裝器將 Next.js 建置 worker 限制為兩個；目標容器的 4 GiB 記憶體限制下重試建置成功。完整安裝及首次 Pi Web 重啟步驟見 [README](../README.md)。
