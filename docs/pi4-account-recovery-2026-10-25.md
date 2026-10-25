# Pi4 帳號與模型路由驗證（2026-10-25）

Pi 已透過 Pi4 原有的 OpenAI Codex OAuth 恢復可用對話。選取 `openai-codex/gpt-6.1-sol`，SDK 驗收的首輪標記及第二輪記憶回覆均通過，驗證時間為 `2026-10-25T17:33:09.945Z`。沒有從其他容器搬移憑證，也沒有修改 Pi 的預設模型或 gateway 設定。

接著以隔離瀏覽器開啟官方 `app.paseo.sh`，沿用原有私有配對，從模型選單選取同一原生 OAuth 模型。首輪回覆約 8.1 秒，續聊約 2.4 秒；重新整理後仍顯示兩輪回覆，JavaScript 錯誤為 0。兩個本次測試 agent 都已歸檔。這是單次驗證，不是效能或容量承諾。[非機密結果](evidence/pi4-account-recovery-2026-10-25.json) 不包含登入、配對連結或對話內容。

原先的 Pi `litellm/chatgpt/gpt-6.1-sol` gateway 路由未通過。原生 OAuth 與 gateway 是不同的授權來源；原生路由成功不表示 gateway 額度已恢復，也不表示 Codex CLI 使用的另一份登入已更新。

本次重測 Claude gateway 仍回 HTTP 402 帳務拒絕；Codex 的 Paseo 兩輪驗收仍失敗。已在 Pi4 的實際 Codex HOME 啟動官方裝置登入，等待使用者在官方網站完成。Claude gateway 帳務恢復或改用官方訂閱，仍需由使用者提供可用的授權來源。三引擎整體驗收維持未通過。

## 0.1.8 錯誤分類修正

實測發現 Claude gateway 可能把 HTTP 402 放在 assistant 回覆中，原先的一般聊天結果會誤標為 `completed`。新增回歸測試先重現失敗，再修正為 `error` 與 `PROVIDER_BILLING_REQUIRED`。同時辨識 `usage_limit_reached`、HTTP 429 速率限制與 HTTP 401 登入錯誤；一般文字中的數字 402／429 不會誤判。錯誤分類只回傳固定代碼，不保存帳號資訊。

本次本機驗證為 119 項測試、TypeScript 檢查及發行包檢查通過。Pi 原生 OAuth 的網頁成功紀錄是在既有 0.1.7 部署取得，不將它當成 0.1.8 已部署的證據。儲存與語音復原另見[既有紀錄](pi4-storage-recovery-2026-10-25.md)。
