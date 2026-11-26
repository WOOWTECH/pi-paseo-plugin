# Tasks 主機封裝

Agent Connect 0.1.27-rc.5 在官方 npm Paseo 0.17.5 的內建清單加入 Better Paseo，並固定 phone-board selected state 修正。它沿用官方 CLI、server、SDK 與既有身分修補；沒有替換 Smart 網頁，也沒有啟用使用者另外安裝的外掛。

## 固定來源與建置

- Smart 整合：`WOOWTECH/woowtech-smart` commit `a7bfd65a3f39076cf664e28687818c24952e261c` 的 `plugins/better-paseo`，peer build provenance 固定五個輸出檔與 source hash。
- Better Paseo：1.7.0，原始 commit `e9ac5216185988ce99574b3e2f04f178020204f1`。
- 產物：`runtime/better-paseo/provenance.json` 固定每個檔案的 SHA-256，`builtin-build.json` 固定依賴 lockfile 與 Tasks chunk。

在固定來源的隔離 checkout 執行：

```sh
cd plugins/better-paseo
npm ci --omit=dev --workspaces=false --no-audit --no-fund
npm run build:builtin --workspaces=false
```

比對 `builtin-build.json` 與每個產物的雜湊後，更新本 repo 的 payload、provenance 與 `src/smart-tasks-patch.mjs` 固定值；依賴不會在 daemon 啟動時下載。rc.4 的 Tasks chunk ID 是 `f9f9101d9d59ec1a`。a7 只更新 phone-board builtin；Smart Web 仍固定 2b，Paseo npm 仍為 0.17.5。Tasks chunk 的元件匯出修正屬於此整合，不能以未修正的上游套件替換。

新 runtime 在安裝階段驗證官方 registry 的精確來源，再加入外掛。ready receipt 同時核對 registry、外掛所有檔案與來源清單；缺檔或修改會拒絕啟動。只有新版本目錄會寫入，既有 daemon 的 runtime、config 與資料不在修補範圍。

## 升級、設定與回復

Tasks 預設開啟；聊天增強及自動更新檢查預設關閉。使用者已有的明確偏好優先。外掛的 Git/npm 自行更新入口停用，由 Agent Connect 發版管理。繁中、MIT 與打包依賴的授權文字一起發布。

升級套件後，舊 0.17.5-r1 daemon 繼續服務並顯示需要重啟。完成進行中的工作後，在 Agent Connect 設定頁停止再啟動，即改用 0.17.5-r2。server ID、配對金鑰、對話與設定仍使用原資料目錄。

回復時先停止新 daemon，還原配套的 Agent Connect／Pi Web 發行套件，再啟動保留的 0.17.5-r1。保留 Tasks 資料目錄，重新升級時仍可使用；不要透過清空 `PASEO_HOME` 處理版本回復。

## 驗證範圍

`node scripts/verify-smart-tasks.mjs` 在臨時目錄安裝固定官方 SDK，驗證實際出貨 bundle 的預設值、明確偏好、繁中、Tasks 匯出初始化、資料重新載入與自行更新停用。它不啟動 daemon，也不呼叫模型。

發布驗收還要使用實際 daemon，讀取外掛 catalog、呼叫 Tasks RPC，並在兩個 Smart 品牌確認看板開啟與重新整理；來源測試不代表實機驗收。Smart 原始碼分支的完整 CI 狀態，與這份外掛在 Agent Connect 的封裝驗證分開記錄。
