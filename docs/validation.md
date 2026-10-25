# 官方登入完成後的三種 provider 驗收（2026-10-25）

在部署環境完成 Claude Code 官方帳號登入與 Codex ChatGPT 裝置授權後，再由插件對 Claude、Codex、Pi 各發送兩輪驗收訊息。三者均取得首輪標記與新的續聊記憶回覆，測試 agent 全部歸檔，`chatVerified` 更新為 true。這項結果取代下方較早紀錄中「Claude／Codex 待登入」的狀態。

Pi Web 的 Omnigent、Paseo 面板均實際開啟，首頁及兩個 API 回應 200，沒有 JavaScript 錯誤。完成標記沿用原初始化對話，`onboardingCompleted=true`；狀態 API 保持 `private, no-store`。插件 94 項測試、TypeScript 與文件差異檢查通過。

另以全新隔離瀏覽器連接官方 `app.paseo.sh`，逐一完成以下操作；沒有 JavaScript 錯誤，測試 agent 已歸檔，瀏覽器 profile 已刪除。

| Provider | 模型 | 實際選取模式 | 首輪 | 續聊 |
| --- | --- | --- | --- | --- |
| Claude Code | Opus 5.5 | Always ask | 通過，約 6.6 秒 | 通過，約 3.4 秒 |
| Codex | GPT-6.1-Sol | Default permissions | 通過，約 4.6 秒 | 通過，約 1.9 秒 |

Pi 的本次 daemon 兩輪複驗通過；其瀏覽器驗證見下方既有 Web Remote 紀錄。上述延遲是單次操作量測，未建立並行容量或 SLA。官方網頁實測證據已寫入插件的 relay 歷史驗證，與 daemon 不提供布林值的即時連線欄位分開呈現；新使用者裝置仍須自行配對。

本次同時找出共用 Codex 設定中的 `model_catalog_json` 會使官方登入讀到 gateway 模型清單。為官方 provider 指定獨立 `CODEX_HOME`，移除該目錄中的 gateway 型錄設定並熱重載後，官方模型與兩輪對話恢復；原有自訂 gateway 也另行通過兩輪回歸驗證。操作方式見 [設定隔離說明](../README.md#官方-codex-與-gateway-的設定隔離)。完整帳號與部署資訊只保留在私有環境，公開回條僅列[不含機密的驗收結果](evidence/official-provider-auth-2026-10-25.json)。

# Pi7 Omnigent 0.3.8 正式重啟後的 Paseo 複驗（2026-10-25）

Pi7 已升至公開 Omnigent 0.3.8 並重新建置共用 Pi Web；新 Pod 兩個容器就緒、重啟數皆為 0。隔離瀏覽器從本機轉發的 Pi Web 實際點開 Omnigent 與 Paseo 分頁，首頁及兩個 API 回 200，沒有 JavaScript 錯誤。Paseo 0.1.4 daemon 仍在運作並可達，官方 relay 已啟用；其即時連線欄位仍是未知，插件歷史驗證仍為 false。

另一個全新隔離瀏覽器從私有配對檔進入 `app.paseo.sh`，選 Pi 的 `litellm/deepseek/deepseek-v4.1-flash`，首輪與同一 Agent 續聊再次回傳正確標記，約 10.1 秒及 1.4 秒。瀏覽器無 JavaScript 錯誤，測試 Agent 已歸檔，profile 已刪除。第一次選模腳本過早讀取尚在 Loading 的型錄，已改為等待指定模型真正出現；這不是模型不可用。使用者自己的裝置仍需私下配對，Paseo 包裝的 Claude／Codex 仍缺個別對話驗證。[重啟後非機密回條](evidence/pi7-web-remote-after-omnigent-v038-2026-10-25.json) 不包含配對連結、憑證或對話正文。

# Pi7 升至 Omnigent 0.3.7 後的 Paseo Web Remote 複驗（2026-10-25）

Pi7 重新啟動後，Paseo 0.1.4 的 0.11.2 daemon 仍由插件管理、可達且啟用官方 relay；Pi Web 原生設定列維持 **MCP → Omnigent → Paseo**，兩個分頁都在實際瀏覽器開啟，原生 API 均回 200，沒有 JavaScript 錯誤。`relayConnected` 仍無布林值，插件的 `relayVerified` 仍為 false；這兩個欄位不能替代遠端實際對話證據。

直接透過 daemon 指定 Pi `litellm/deepseek/deepseek-v4.1-flash`，首輪與續聊都回傳正確標記，測試 agent 已歸檔。另一個全新隔離瀏覽器只在記憶體中讀取私有配對檔，到官方 `app.paseo.sh` 按 Connect，從 Web Remote 選同一固定模型；兩輪對話都正確回傳標記，約 19.2 秒及 1.9 秒，網頁無 JavaScript 錯誤。當次兩筆可辨識的瀏覽器驗收代理均已歸檔，活躍測試代理為 0，隔離 profile 已刪除。這是單次量測，不是延遲保證；使用者自己的裝置仍需在受保護設定頁完成配對。[非機密複驗回條](evidence/pi7-web-remote-after-omnigent-v037-2026-10-25.json) 不含配對網址或對話正文。

同次檢查也發現預設 `litellm/openrouter/free` 在隔離瀏覽器的行為不穩定：一次未在 120 秒內得到指定首輪回覆，另一次首輪正確、續聊雖有回覆卻未記住上一輪標記。直接 daemon 測試此模型曾通過，所以目前不能判定是模型路由、Web Remote 或短暫上游狀態造成。商業操作應從實際驗證成功的模型中明確選取，並持續監測。Pi7 的 Paseo Claude／Codex 仍分別回報 `PROVIDER_AUTH_REQUIRED`／`PROVIDER_TURN_FAILED`；Omnigent 對這兩個原生引擎的成功回條不能代替 Paseo CLI 的官方登入與逐一對話驗收。

# Pi7 併裝驗收：Paseo 0.1.4、Omnigent 0.3.5 → 0.3.6

2026-10-25 在 Pi7 持久化容器安裝兩個公開 Git tag，執行 `pi-omnigent install-ui` 建置共用 Pi Web 0.10.0 介面，重啟工作負載。當次 Pod 就緒且重啟數為 0；Paseo daemon 由插件管理並可連線。初始化對話「Paseo 連線初始化」只建立一筆，重啟後仍存在。兩個 repo 的 GitHub `private` 欄位均為 `false`。

- [Paseo v0.1.4 CI](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/40158799457) 通過；[Omnigent v0.3.5 CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40160314218) 的 Node 22.19、Node 22.23、原生 UI 與共用 UI 工作均通過。
- 桌面版設定列按 **MCP → Omnigent → Paseo** 顯示；手機 390 px 選單含 `Paseo`，文件沒有水平溢出，兩者均無瀏覽器 JavaScript 錯誤。修正了 v0.3.4 實際顯示 `settings.paseo` 的標籤問題。
- 設定面板產生 `https://app.paseo.sh` 官方配對連結；儲存配對資訊的私人檔案權限為 0600。公開狀態 API 回傳 `private, no-store`，沒有輸出配對連結。Pi Web 外層未授權請求回傳 401，內層跨站寫入回傳 403。
- 固定 Paseo 0.11.2 的動態模型目錄當下列出 Claude 17、Codex 8、Pi 53 個模型，模式分別為 5、3、0。這些數量會隨上游及帳號狀態變動。
- Pi provider 使用 `litellm/openrouter/free` 完成首輪與續聊兩次實際回覆，驗收 agent 已歸檔；最後一次檢查為 `2026-10-25T04:11:35Z`。
- Pi7 的 Claude Code 與 Codex 官方 CLI 均顯示未登入。實際兩輪驗收分別回報 `PROVIDER_AUTH_REQUIRED`、`PROVIDER_TURN_FAILED`，因此這兩個 provider **尚未通過 Pi7 對話驗收**。Omnigent server 此容器亦尚未登入。
- 此階段官方 relay 的配對連結已生成，但尚未在另一端完成 Connect；`relayVerified` 仍為 false。後續遠端實測見下方；Claude／Codex 仍需各自完成官方登入與對話驗收，才能將 Pi7 標記為三種 provider 完整上線。

同日將 Omnigent 升至公開 `v0.3.6`，其 [發行 CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40161080957) 與 [main CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40161080793) 均通過。Pi7 共用介面 receipt 為 `omnigent+paseo`，包含 `mcp`、`omnigent`、`paseo` 三個設定區，仍以固定 Pi Web commit 建置。新 Pod 就緒、重啟數 0，初始化對話與私人配對檔案均留存，Paseo daemon 可達。

- 桌面與 390 px 手機重新驗證設定列、Paseo 分頁及無 JavaScript 錯誤；手機無水平溢出。
- 分別從原生設定面板按「讀取 Claude Code／Codex／Pi 模型」，三次 API 均回傳 200 並更新介面；模型數為 17／8／53，模式數為 5／3／0。
- 新 Pod 的 Pi provider 再次完成兩輪實際對話與測試 agent 歸檔，時間為 `2026-10-25T04:18:18Z`。Claude／Codex 登入仍待完成；relay 即時連線欄位未知，插件歷史驗證為 false。

另在全新隔離瀏覽器從 Pi7 設定頁產生官方 `app.paseo.sh` 配對連結，按 Connect 後讀取插件建立的空驗收工作區。官方 Paseo 介面的模型選單顯示 Claude 17、Codex 8、Pi 53 個模型；選取 Pi `litellm/openrouter/free`，從遠端介面送出首輪與續聊，兩次都取得正確的 `PI7_REMOTE_OK` 回覆。測試 Agent 完成後為 idle，隨即歸檔；瀏覽器無 JavaScript 錯誤。該隔離瀏覽器的配對只用於測試，使用者自己的 Paseo 裝置仍須配對。Paseo 0.11.2 daemon 的即時 relay 欄位未提供布林連線狀態，而插件尚未將這次外部瀏覽器驗證寫入 `relayVerification`，因此 UI 的歷史驗證仍顯示 false；實際遠端對話結果以上述完整兩輪為準。

同日以另一個全新隔離 Chromium 複驗官方 Web Remote。測試程序在記憶體中讀取 Pi7 權限 0600 的私有配對檔，不輸出配對網址；在 `app.paseo.sh` 按 Connect 後看見 Pi7 驗收工作區，從 Web 端開啟 Agent 並看到 Claude 17、Codex 8、Pi 53 個模型。選取 Pi 的 `litellm/openrouter/free`，首輪回覆及同一 Agent 續聊均精確回傳新產生的驗收標記；當次等待約 9.7 秒及 4.4 秒，僅代表這次操作，不作延遲承諾。網頁無 JavaScript 錯誤。測試 Agent `d51f1815-6aca-4e42-aab2-04fe86c9fa02` 經官方 CLI 確認為 idle，並於 `2026-10-25T05:05:29Z` 歸檔；隔離瀏覽器 profile 已刪除。此複驗再次證實 Web Remote 可完成 Pi7 的模型選擇和兩輪對話；使用者自己的瀏覽器配對與 Claude／Codex 登入仍是分開待完成的操作。插件狀態的 `relayVerified` 仍為 false，不能據此否定已觀察到的 Web 對話。

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

## 2026-10-25：手機 Paseo 捲動修正

Paseo v0.1.5 與合併介面 v0.3.10 已部署驗證。舊版設定面板及獨立初始化頁的觸控測試都能重現底部不可達；新版在 390×780 的實際服務狀態畫面可滑到「讀取 Pi 模型」。手機、小手機、橫向、桌面與初始化頁的五個合併介面案例，均可滑到底部、展開 60 個合成模型、再回到頂端。獨立版另通過四種尺寸。

這次是 Chromium 觸控模擬驗證，沒有手機硬體測試。版面矩陣使用合成狀態／模型，另有未模擬狀態的部署後滑動驗證；沒有以這次版面測試重新宣稱模型對話通過。提供者登入檔、Paseo 設定與配對檔的部署前後雜湊相同。詳見 [捲動驗證證據](evidence/mobile-scroll-2026-10-25.json)。

## Pi2／Pi3／Pi4 部署驗收（2026-10-25）

Paseo v0.1.7 + Omnigent v0.3.12 已部署至 Pi2、Pi3；兩台都在重新啟動後重新驗收，原有配對及初始化對話保留。已透過插件設定頁配對官方 Paseo Web，實際選擇 Claude Code、Codex、Pi 的模型並完成兩輪對話及頁面重新載入。Claude Code 使用原有 Omnigent DeepSeek gateway；此結果不代表 Anthropic 訂閱登入已驗證。

手機設定頁的備註儲存、模型讀取，以及直向／橫向／小螢幕的觸控捲動回歸均通過。模型對話使用真實服務；長模型清單的版面測試以模擬資料搭配 Chromium 觸控模擬驗證，未使用實體手機。測試套件數量可能重疊；回覆耗時是單次樣本，不能視為負載基準。

修正了 gateway 設定未沿用、啟動 PATH 代理指令遮蔽、無效的 daemon.name 設定、驗收錯誤狀態碼、重複建立驗收工作區，以及安裝資源錯誤缺乏診斷等問題。成功的新建置移除可重建的 `.next/cache`，原有可回復介面保留。

Pi4 因磁碟空間不足及底層儲存恢復尚待核准，未完成 Paseo 安裝，不能列為通過；原有服務仍可用。本次未進行所有模型、長時間負載或完整故障切換測試。

完整數據：[驗收紀錄](pi234-paseo-2026-10-25.json)。
