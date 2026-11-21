# Agent Connect 三品牌功能一致性驗收

這份標準適用於 Woowtech Smart、Apporo Smart、Paseo，涵蓋 Windows WSL2、macOS、Ubuntu、k3s/PaaS、HA add-on。每次驗收必須宣告實際測試的平台及主機；尚未執行的版本不能隨其他版本標記通過。可機器讀取的要求位於 [`contract.json`](../tests/smart-parity/contract.json)。

## 使用 Craft Anything

使用 [Craft Anything](https://github.com/storytold/craft-anything) 官方 CLI **v0.6.1**，固定 archive SHA256 `83ec0730c9117f399122b315c63ed4c3a8d31ac55bddd74cb8b33cd2f76ef704`。來源研究 checkout 為 `e64d7cb73d7f39323b7040a984e0f9b3f7981146`，不代表此 checkout 建置的二進位；執行檔取自官方版本發布並另外驗證雜湊。

驗收工具在 Linux x86_64 runner 執行，不需裝在每台受測主機。安裝 Node 22+、Playwright 及 Chromium 後，在 repo 根目錄執行：

```sh
python3 tests/smart-parity/setup-craft.py artifacts/smart-parity/tools
node --test tests/smart-parity/*.test.mjs
node tests/smart-parity/baseline.mjs
```

可用 `CRAFT_CLI`、`PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE`、`PARITY_OUTPUT` 指定既有工具與輸出位置。只有受限容器確實無法啟用 Chromium sandbox 時才設定 `PARITY_NO_SANDBOX=1`。

基線會真正打開三個網站的配對視窗，檢查輸入框、取消與配對控制項，執行 `web-walkthrough-check`、`web-walkthrough-record` 與三組 `web-snapshots-compare`。這項基線只驗證配對視窗，**不表示已驗證模型、主機連線或部署**。

每個 PR 的既有 CI 都執行驗收判定器測試。另有手動 `Smart web public parity baseline` workflow，可重跑三個公開網站並保留七天證據；不建立排程、不帶主機憑證，也不啟動模型。完整主機/provider 驗收使用私人 runner，避免將配對或對話資料上傳到公開 CI artifact。

完整測試匯入 [`craft.mjs`](../tests/smart-parity/craft.mjs) 的 `Craft.record()`，附接同一個 Playwright/CDP 瀏覽器，讓 Craft 記錄真實操作。每個動作有穩定 `step_id`。結果必須完整、未中止且每一步成功；CLI exit code 0 本身不足以判定成功。每個情境還須用 Playwright 或後端快照檢查操作後的實際狀態。

比較使用同一 Craft project 保留的 evidence ID，避免 JavaScript 重新序列化浮點時間戳導致內容雜湊不符。保存 `.cany` 專案及原始 JSON；不要修改原始證據以消除差異。

完成紀錄後執行 `node tests/smart-parity/audit.mjs PRIVATE_EVIDENCE_DIRECTORY/matrix.json`。matrix 宣告 `platform`、`scope`、`hosts[{id,dataIdentity,runtimeIdentity}]`，每筆 `results` 使用 `host`、`brand`、`provider`、`case`、`status` 及 `evidence[{path,sha256}]`。host 層級案例省略 brand/provider；host × brand 案例省略 provider。`model-switch` 還必須記錄 `models{initial,alternate,actual}`，前兩者須不同且 actual 等於 alternate。工具依 contract 展開每個必要案例，缺項、blocked、證據遺失或雜湊變動均回傳非零。這是矩陣完整性及證據完整性檢查；`passed` 不能單獨代表功能已通過，仍須審閱各項證據中的實際操作與工具事件。

## 完整驗收矩陣

每個受測平台至少兩台獨立主機。每台同時只連一個品牌，依序切換三品牌；切換後同一主機的資源與記憶必須保留，各主機資料必須獨立。

| 層級 | 必要檢查 | 證據 |
|---|---|---|
| 品牌 × 主機 | 真實配對、兩台同時顯示、重新連線、切換目標 | Craft 操作紀錄 + 實際 server ID + 狀態斷言 |
| 品牌 × 主機 × Claude/Codex/Pi | 建立對話、實際回答、切換兩個支援模型 | Web 操作 + provider ID、requested/actual model、完成回合 |
| 品牌 × 主機 × provider | 執行共同 MCP、讀取共同 skill、讀寫共同記憶 | 實際完成 tool_call 事件及非提示內提供的隨機標記 |
| 同一主機跨 provider/品牌 | A 寫入，B 及下一品牌讀取相同內容 | writer/reader 身分 + MCP 事件 + 獨立檔案內容驗證 |
| 不同主機 | 讀取對方實際寫入的 key 得到不存在 | foreign key + 真實 MCP read 結果 |
| CLI / MCP | 建立專案、工作區與對話；封存/刪除；對話協調 | 命令/API 結果 + 再查詢 + 接收端回合及協調結果 |
| 部署 | 來源、映像、volume、健康、重啟後持續存在 | commit、image digest、host ID、獨立資料卷、驗證時間 |

Paseo 0.11.2 的工作區操作提供封存，對話 CLI 提供刪除，MCP 提供封存；必須記錄真實能力，不把封存標成實體刪除。模型切換透過 `update_agent(settings.model)` 與 Web 執行，不能使用不存在的 CLI `--model` 更新參數。

## 判定與差異

- 狀態只有 `pass`、`fail`、`blocked`、`unrun`。缺少、失敗、中止、截斷或尚未執行的證據均不能通過。
- 圖片相似、DOM 相似、相同套件版本、模型自稱讀過記憶、設定檔存在，都不能代替功能證據。
- 只正規化已宣告的品牌名稱、網域及個別說明的變動 ID；保留版本、缺少控制項、錯誤、工具結果、未支援功能。
- Craft 的結構差異與功能結果分開記錄。零個變動步驟不保證 DOM 或所有功能相同。
- 獨立臨時主機的通過結果不能算成現有正式 PaaS 主機部署完成。正式映像須遵循來源 repo 的人員簽署/發布流程。

證據預設私人權限，停用 request/response bodies 與 header values，將配對 offer、token 等加入 `hidden_values`，不要提交瀏覽器登入狀態或使用者對話。測試只建立帶唯一 acceptance 前綴的資源；清理必須限定本次建立的 ID。
