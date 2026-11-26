# Provider 與公開 Web 實際驗收

這些腳本是測試工具，不包含在 npm 套件中。它們會建立工作區、代理、測試 skill、全域 MCP 定義及主機內共享記憶，並產生計費模型回合。只可在已授權、由本次驗收擁有的隔離主機執行。先完成映像、資料卷、主機身分與憑證的外部驗證；這個目錄不負責部署、複製憑證或切換連線品牌。

需要 Node 22.19+、Agent Connect 管理的 Paseo runtime（0.1.24 起為 0.17.4）、啟用中的 shared-runtime 0.1.5，以及可使用兩個不同模型的 Claude Code、Codex、Pi。`PI_SHARED_PACKAGE_ROOT` 與 `PI_PASEO_PLUGIN_ROOT` 可覆寫套件位置；manifest 的 `root`、`cliRoot`、`daemonHome`、`mcpUrl` 可指定受測 runtime。MCP 如有要求驗證，使用環境變數 `PASEO_ACCEPTANCE_BEARER`，不得把憑證寫進 manifest 或命令列。

## 腳本與單元驗證

```sh
node --test tests/smart-parity/provider/*.test.mjs
```

測試包括舊工具事件、錯誤工具及路徑、錯誤 marker、失敗的 CAS、實際模型不符、缺少通訊路徑、重複 sender，以及驗證器的完整 prepare/verify 流程。這些測試通過代表判定器的契約通過，不代表任何品牌或主機已完成實際驗收。

## 每台主機的準備

把此目錄的五個非測試 `.mjs` 腳本放到受測主機的私人測試目錄。每台主機使用相同 RUN_ID、不同 HOST 與 FOREIGN_HOST；兩台主機必須有獨立 HOME 和資料根目錄。以下使用占位名稱，請替換成這次測試的值。

以此版本控制目錄為唯一腳本來源。複製前與受測主機複製後都計算五個檔案的 SHA-256，保存到該次驗收的私有 receipt；每次執行前重新比對。映像升級或容器重建後必須重新複製並驗證，不能假設 `/tmp` 中仍是同一版本。若另有 scratch 副本，必須逐位元組符合這裡的檔案；不符時先停止執行並釐清版本。

`VERIFIED_RUNTIME_IDENTITY` 必須來自外部驗證的部署身分：容器使用 `image:sha256:<64位小寫雜湊>`，原生安裝使用 `package-set:sha256:<64位小寫雜湊>`。它不是可任填的版本標籤。fixture manifest、provider report、Web jobs/checkpoint/verification 都保存相同 `runtimeIdentity`、`runId`、host、phase；缺漏或不一致會在連線 daemon 前失敗。升級時先完成資料保留的雜湊比對與舊代理清理，再明確更新 fixture manifest 的 runtime 身分；已封存的舊報告保持原樣，新映像使用新 phase 證據。

```sh
PASEO_ACCEPTANCE_RUNTIME_IDENTITY="$VERIFIED_RUNTIME_IDENTITY" node prepare-shared-fixtures.mjs RUN_ID HOST FOREIGN_HOST --execute
node run-provider-acceptance.mjs MANIFEST discover woowtech
```

第一步產生 `<home>/work/agent-connect-acceptance-RUN_ID/acceptance-manifest.json`，登記每個資源的清理所有權，並檢查共同 skill 已同步。marker 隨機產生，manifest 與證據為私人檔案。`discover` 只查詢實際 provider、profile 和模型清單，不啟動 provider 回合。

依實際查詢結果，在 manifest 加入 `providers` 陣列，剛好包含 `claude`、`codex`、`pi`。每筆使用 `{id, model, alternateModel}`，且兩個模型不同、都存在於該 provider 的清單。若測試主機要求權限模式，可加入已支援的 `modeId` 與 `thinkingOptionId`；不要假設不同 provider 的模式名稱相同。

## 每個品牌的流程

主控端先經 GUI 選擇品牌並在該品牌公開 Web 完成配對，確認兩台主機可見。得到實際回合授權後，在每台主機執行：

```sh
node run-provider-acceptance.mjs MANIFEST run woowtech
node observe-web-acceptance.mjs MANIFEST prepare woowtech
```

`run` 透過真正的 CLI/MCP 建立工作區與代理，逐一驗證共同 skill、全域 MCP、記憶讀寫、跨 provider/前一品牌的隱藏 marker，並切換模型。通訊使用 Codex→Claude、Pi→Codex、Claude→Pi 三條路徑，每條由新的 CLI sender 呼叫 `send_agent_prompt`，同時驗證接收方的實際回答。

`prepare` 產生品牌目錄下的 `web-jobs.json`，讓瀏覽器 runner 使用既有受測代理，在公開 Web 切換至 `targetModel` 並送出 `prompt`。搭配上層的 Craft 實際操作紀錄，不可由後端代替這次 UI 切換或送訊。`web-checkpoint.private.json` 保存準備時的模型、工具 ID 及預期讀取值。既有記憶、skill、MCP 的 marker 不會提供給瀏覽器 prompt；新寫入 marker 則是此次明確要求寫入的值。

完成真正的 Web 操作後執行：

```sh
node observe-web-acceptance.mjs MANIFEST verify woowtech
```

驗證器只查詢代理與記憶，不送訊、不變更模型、不修改記憶。它要求新的成功工具事件，讀取兩個 skill、全域 MCP、既有記憶，並以先讀取不存在、再 `expectedRevision:null` 的方式建立新的測試 key。寫入回傳版本必須符合獨立讀取的儲存版本。模型設定與實際 runtime 模型都要符合 UI 選擇；代理完成且回覆此次獨有完成 marker。成功的 Web 寫入會冪等登記到 manifest `writes`，供下一品牌實際讀取；同 key 的所有權衝突直接失敗。

兩台主機都產生實際寫入後，把對方 manifest `writes` 的 **key 名稱**放進本機 `foreignWrittenKeys`，不要複製內容或記憶檔案。再執行：

```sh
node run-provider-acceptance.mjs MANIFEST isolation woowtech
```

每個 provider 都必須實際讀取對方的 key，工具結果精確為 `{memory:null}`。最後清理該品牌的代理及工作區，再切換至 `apporo`、`paseo` 重複流程。保持同一台主機的 manifest、skill、MCP 和共享記憶，才能驗證前一品牌由 Web 寫入的資料跨品牌可用。每個品牌的 agent/report/checkpoint 獨立保存，不重跑已建立代理的相同 phase。

## 清理與證據界線

```sh
node run-provider-acceptance.mjs MANIFEST cleanup woowtech
node cleanup-shared-fixtures.mjs MANIFEST --execute
```

第一步僅處理 manifest/report 所擁有的代理 ID，或可用建立前登記的唯一 attempt nonce、精確 cwd/labels 找回的代理；工作區使用 Paseo 支援的封存。MCP 代理封存後先驗證保留於封存清單，再由 CLI 刪除已登記的代理。CLI sender 也全部納入清理。第二步僅在**全部品牌及跨主機測試結束**後執行：全域 MCP 須符合原始定義雜湊、skill 須符合 marker、記憶內容須符合本次擁有的 marker，才移除。記憶刪除使用實際讀取的 revision；不掃描刪除其他記憶。

保留 report、timeline、checkpoint、Craft 與驗收矩陣供人工審閱；不要提交這些檔案、真實 manifest、配對資料、token、瀏覽器狀態或真實對話。非零結束碼代表失敗，不可因部分 row 成功而改判整體通過。單元測試、CLI/MCP 驗收、公開 Web 操作、平台部署是不同範圍，應各自報告已完成與尚未完成的證據。
