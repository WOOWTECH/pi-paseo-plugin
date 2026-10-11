# 0.1.2 商業部署驗證

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

Pi 5 同一環境連續 5 組、每組 4 個並行 runtime 狀態讀取：0.1.0 P50 2,190 ms、P95 3,225 ms；0.1.1 暖快取 P50 3 ms、P95 4 ms。此數字為 runtime 函式量測，並非外部 HTTP 延遲；冷查詢仍需 provider 探測。快取使用單調時鐘，校時不延長上限 3 秒；停止及程序身分變更每次重新確認。

在 Pi 5 的獨立測試 daemon 使用上述修補 runtime 與現有帳號，完成以下真實驗收；每項有新的續聊回覆，並在最後歸檔測試 agent、停止測試 daemon。

| Provider | 驗收模型 | 初次回覆 | 續聊 | 測試資源清理 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-opus-5-5` | 通過 | 通過 | 通過 |
| Codex | `gpt-6.1-sol` | 通過 | 通過 | 通過 |
| Pi | `openai-codex/gpt-5.6-sol` | 通過 | 通過 | 通過 |

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
