# Pi4 帳號與模型路由驗證（2026-10-25）

> 2026-10-26 複驗：Codex、Pi 的既有登入仍可完成 SDK 兩輪對話；Claude gateway 的兩個已設定模型均回 HTTP 402。Pi Web 狀態 API 回 200、服務健康、初始化已完成，所有此次測試 agent 已歸檔，未更換任何憑證。版本維持公開 `v0.1.8`，剩餘磁碟約 11.4 GiB。今日沒有重跑瀏覽器測試，下方網頁成功紀錄仍屬 10 月 25 日。[今日非機密回條](evidence/pi4-recheck-2026-10-26.json)

## 最新結果：Codex 新授權成功（18:48 UTC）

Codex 已由使用者完成官方裝置授權，並在 Pi4 套用新的 ChatGPT 登入。`gpt-6.1-sol` 使用 Default Permissions 模式通過 SDK 兩輪記憶驗證；官方 `app.paseo.sh` 也完成模型與模式選擇、兩輪對話及重新整理驗證。單次首輪約 4.0 秒、續聊約 2.4 秒，沒有 JavaScript 錯誤，SDK 與網頁測試 agent 均已歸檔。

Pi 原生 OAuth 的兩輪驗證於 `2026-10-25T18:48:23.508Z` 再次通過。Claude gateway 同次複驗仍回 `PROVIDER_BILLING_REQUIRED`（HTTP 402）。目前 Codex、Pi 可對話，三引擎整體驗收仍未完成；剩餘處理是恢復 Claude gateway 額度，或由使用者選擇已有的官方訂閱重新授權。

本次只在官方授權成功後替換 Pi4 的 Codex 登入，登入檔權限為 0600；其他六個既有登入、模型、初始化及配對關鍵檔案的校驗值一致，暫存登入目錄已清理。未更換其他環境的帳號，也未修改 Pi 預設模型。程式版本維持已部署的 `v0.1.8`。最新非機密回條見[驗證結果](evidence/pi4-account-recovery-2026-10-25.json)。

## 重新授權前的紀錄

下列 401、登入待完成及三引擎失敗描述是本次成功授權之前的歷史狀態；Codex 現況以上方最新結果為準。

Pi 已透過 Pi4 原有的 OpenAI Codex OAuth 恢復可用對話。選取 `openai-codex/gpt-6.1-sol`，SDK 驗收的首輪標記及第二輪記憶回覆均通過，驗證時間為 `2026-10-25T17:33:09.945Z`。沒有從其他容器搬移憑證，也沒有修改 Pi 的預設模型或 gateway 設定。

接著以隔離瀏覽器開啟官方 `app.paseo.sh`，沿用原有私有配對，從模型選單選取同一原生 OAuth 模型。首輪回覆約 8.1 秒，續聊約 2.4 秒；重新整理後仍顯示兩輪回覆，JavaScript 錯誤為 0。兩個本次測試 agent 都已歸檔。這是單次驗證，不是效能或容量承諾。[非機密結果](evidence/pi4-account-recovery-2026-10-25.json) 不包含登入、配對連結或對話內容。

原先的 Pi `litellm/chatgpt/gpt-6.1-sol` gateway 路由未通過。原生 OAuth 與 gateway 是不同的授權來源；原生路由成功不表示 gateway 額度已恢復，也不表示 Codex CLI 使用的另一份登入已更新。

本次重測 Claude gateway 仍回 HTTP 402 帳務拒絕；Codex 的 Paseo 兩輪驗收仍失敗。已在 Pi4 的實際 Codex HOME 啟動官方裝置登入，等待使用者在官方網站完成。Claude gateway 帳務恢復或改用官方訂閱，仍需由使用者提供可用的授權來源。三引擎整體驗收維持未通過。

## 0.1.8 錯誤分類修正

實測發現 Claude gateway 可能把 HTTP 402 放在 assistant 回覆中，原先的一般聊天結果會誤標為 `completed`。新增回歸測試先重現失敗，再修正為 `error` 與 `PROVIDER_BILLING_REQUIRED`。同時辨識 `usage_limit_reached`、HTTP 429 速率限制與 HTTP 401 登入錯誤；一般文字中的數字 402／429 不會誤判。錯誤分類只回傳固定代碼，不保存帳號資訊。

本次本機驗證為 119 項測試、TypeScript 檢查及發行包檢查通過。[main CI](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/40217671368) 與 [v0.1.8 CI](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/40218032677) 的套件檢查及完整主機建置均成功。

## 0.1.8 部署後複驗

Pi4 已安裝公開 `v0.1.8`，固定 commit `3d330e31623bc61e81e7b487cb87d78f2b94d5b6`，確認無進行中對話後重啟工作負載。兩個容器就緒、重啟計數為 0；原配對與初始化紀錄保留，七個原登入與模型等關鍵檔案的校驗值一致，磁碟仍為 32 GiB，約有 11.5 GiB 可用。本機語音設定、已下載模型及持久化 bzip2 亦正常。儲存與語音原始復原見[既有紀錄](pi4-storage-recovery-2026-10-25.md)。

新版 SDK 對 Claude 現場 402 回覆回報 `PROVIDER_BILLING_REQUIRED`；Pi Web 狀態 API 回 200 並呈現同一錯誤碼。Pi 的原生 OAuth 再次通過兩輪驗證。重新啟動後，官方 Web 沿用原配對連線、選模型、兩輪回覆及重新整理均通過，單次約 8.7 秒／2.4 秒，沒有 JavaScript 錯誤，測試 agent 已歸檔。

第一次 Codex 裝置登入等候逾時，且觀察到 CLI 在授權完成前會清除原登入快取；已從本次私有備份恢復原授權，校驗值一致。後續流程改在 Pi4 私有暫存 `CODEX_HOME` 登入，只有官方授權成功且現用登入未被其他操作更動時才原子替換；逾時不移除現用登入。登入碼不公開存放。尚未完成新授權前，不能將此流程準備完成視為 Codex 對話驗收通過。

新版部署後另以官方 Web 複驗 Codex，回報 `workspace routing discovery unauthorized (401)`，測試 agent 已歸檔，插件最新狀態改為 `PROVIDER_AUTH_REQUIRED`。已確認 Codex 使用原生 OpenAI provider，沒有自訂模型路由覆寫；登入檔存在不代表遠端授權仍有效，因此最新阻塞應表述為需要重新授權，不能只沿用先前「額度耗盡」的診斷。
