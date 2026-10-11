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
