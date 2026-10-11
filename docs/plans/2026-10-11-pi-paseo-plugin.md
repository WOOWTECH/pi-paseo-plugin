# Pi Agent / Pi Web Paseo Plugin Implementation Plan

> 使用者已確認預設方案；實作及驗收以本 repo 的安裝說明與測試為準。

**Goal:** 在 Pi Web 下載安裝並啟用插件後，自動安裝 Paseo、建立可續接的初始化對話，讓使用者從 Pi Web 開啟 Paseo 並使用容器現有 Claude Code、Codex、Pi 的模型與對話。

**Architecture:** 獨立 Pi package 負責安裝、設定、同使用者 provider 探測、受管 daemon、初始化狀態與驗收；隨附 Pi Web 主機整合負責安裝／啟用／重啟事件、建立初始化對話、受保護設定輸入與入口。provider 身分憑證沿用現有環境，模型清單由 Paseo 動態探測。

**Tech Stack:** Node.js >=22.19.0、TypeScript Pi extensions、Pi Web Next.js、Paseo npm CLI、JSON 狀態／檔案鎖。

---

## 決策與已驗證事實

- 使用者已確認 7 項全部 A。daemon 在本容器、官方 relay、完整 UI 新分頁、三種 provider 動態模型／模式／思考等級、現有登入與權限、唯一可續接初始化對話。
- 建議：daemon 在本容器，以現有 Pi Web 使用者啟動；loopback listen，官方 relay 配對。Pi Web 插件新分頁開啟 Paseo 完整 UI，並提供狀態／操作入口。
- 首次啟用建立一個 onboarding conversation；重啟續接，完成後不重複建立。
- 當前 Pi Web @agegr/pi-web 0.10.0；Node 22.23.3；Pi @earendil-works/pi-coding-agent 1.0.0；Claude Code 2.1.296；Codex 0.162.1。
- Pi Web 真正的 HOME=/data/pi-agent/home，PI_CODING_AGENT_DIR=/data/pi-agent，PI_AGENT_DATA_DIR=/data/pi-agent。不得錯用 ~/.pi/agent 的空憑證。
- Paseo 沒有在 PATH。既有 /data/pi-agent/paseo-boot.sh 使用舊版 0.8.0、另一個使用者，不能直接當作本插件成功。
- 官方 npm 穩定版本本次查證為 @getpaseo/cli 0.11.2；鎖定經驗證版本，升級另外驗證。
- Pi Web 插件 install/enable route 沒有啟動對話掛鉤；ctx.newSession 被取消。須提供主機整合才能符合立即啟動的要求。
- 既有共用 runtime 專案位於 /data/pi-agent/home/work/pi-agent-shared-runtime，只作參考，不修改其他任務的檔案。

## Task 1: Package 與狀態契約

**Files:** Create package.json, extensions/index.ts, bin/cli.mjs, src/state.mjs, tests/state.test.mjs。
1. 定義 pi.extensions、發行檔案、Node 版本與固定 Paseo 依賴。
2. 定義 installationId、phase、onboardingSessionId、daemonHome、desiredEnabled、lastDiagnostic 的非秘密狀態。
3. 實作原子寫入、互斥鎖、同時 install/enable 不重複建置，對 creation uncertain 不盲目重試。
4. 驗證 crash/resume、重複觸發、失敗重試的狀態轉換。

## Task 2: 版本固定的可重複安裝

**Files:** Create src/install.mjs, src/process.mjs, tests/install.test.mjs。
1. 檢查 OS、CPU、Node、npm 與既有 binaries；安裝專用目錄，不覆蓋全域工具。
2. 下載固定版本 Paseo CLI，驗證實際版本與 required commands。
3. 既有 Paseo homes 與資料不覆寫；配置插件專用 home，provider HOME 保持既有使用者。
4. 驗證網路中斷、非零退出、既有安裝、重新部署與檔案權限。

## Task 3: Pi Web lifecycle 主機整合

**Files:** In isolated matching Pi Web checkout, modify app/api/plugins/route.ts, components/PluginsConfig.tsx; create lib/plugin-lifecycle.ts, lib/plugin-onboarding.ts, lib/plugin-lifecycle.test.mjs。
1. 在成功 install/enable 及 bulk-enable 後派發受管 lifecycle；失敗 package 不觸發。
2. 主機內部使用 startRpcSession 建立 onboarding，設置名稱並更新 session cache；不要求 npm postinstall 取得 Pi Web 密碼。
3. Pi Web 啟動恢復 enabled packages 的受管服務；disable/remove 結束插件擁有的流程，保留使用者資料。
4. UI 展示狀態、初始化對話入口與開啟 Paseo 的連結；明確區分 installed、enabled、running、authenticated、chat-verified。
5. 不直接修改目前全域 compiled .next；產出可審查的 adapter／patch 或正式打包版本後再部署。

## Task 4: 對話式 onboarding 與受保護表單

**Files:** Create src/onboarding.mjs, src/config.mjs; host adapter app/api/plugin-paseo/config/route.ts, components/PaseoSetup.tsx。
1. 對話解釋目前步驟並詢問連線方式、名稱、入口、缺失的 provider 登入。
2. relay 用官方 pairing flow；direct 用位址／port／daemon password；SSH 使用 key/agent。根據選擇顯示必要欄位。
3. 秘密輸入經受保護表單，避免送進 LLM、session JSONL、工具參數與 log；存於 plugin/server protected configuration。
4. 本身的登入／配置 errors 用安全 metadata 回報，未完成流程重启续接。
5. 若初始 Pi 模型不可用，設定表單仍可運作，取得 provider 登入後再觸發真正模型對話。

## Task 5: 三種 Provider 與模型／模式

**Files:** Create src/providers.mjs, src/diagnostics.mjs, tests/providers.test.mjs。
1. 保留現有 HOME、PATH、PI_CODING_AGENT_DIR、PI_AGENT_DATA_DIR；憑證不複製到 prompt。
2. 探測 Claude、Codex、Pi binary 與必要啟動協定；配置 provider paths。
3. 從 Paseo 取得各 provider 的 models／modes／thinking options，不硬編模型或不支援的設定。
4. 現有 MCP／skills 的映射取決於第 4 題；三種 runtime 不能單憑同 HOME 推定所有插件工具共享。
5. 對 missing／expired auth 提供專屬登入入口，完成後重新診斷。

## Task 6: Paseo UI 與 daemon 生命週期

**Files:** Create src/daemon.mjs, src/ui.mjs, host-adapter integration files; tests/daemon.test.mjs。
1. 以現有使用者啟動 plugin-owned daemon，固定專用 home／port，提供版本一致的 bundled web UI。
2. 由 Pi Web host/service 監督程序與重啟恢復，不使用 npm postinstall 的 detached child 充當永久 supervisor。
3. 新分頁 URL 使用已可達的 hosted app+pairing 或受保護的 daemon UI 入口；容器的 localhost 不能直接當作使用者裝置的 localhost。
4. 若代理 bundled UI，完整傳遞 HTTP／WebSocket upgrade／串流／origin，並驗證認證與 host allowlist。
5. stop/disable 只處理插件擁有的 PID／程序，不干擾既有 daemon 或使用者其他會話。

## Task 7: 驗收與交付

**Files:** Create README.md, tests/onboarding.test.mjs, tests/lifecycle.test.mjs, scripts/acceptance.mjs。
1. 執行 npm test 與適當 typecheck；Pi Web adapter 執行其相關 route/UI checks。
2. 打包 npm pack 並在隔離目錄驗證安裝內容；測試首次 install、disable/enable、Pi Web restart 與重複安裝。
3. 目前容器實際安裝後，確認 onboarding 唯一、服務存活、登入成功與可開啟的 UI。
4. 使用者允許的實際验收：Claude、Codex、Pi 各選可用模型，建立一個小型測試對話，取得回覆並續聊一次。
5. 交付 tarball／來源／Pi Web adapter／安裝步驟與驗收結果。遠端客戶端配對需使用者操作時清楚列出剩餘一步。
6. 使用 verification-before-completion；診斷通過或模型列表存在不能當作實際對話成功。

## 官方來源

- https://paseo.sh/llms.txt
- https://paseo.sh/docs/connectivity.md
- https://paseo.sh/docs/web-ui.md
- https://paseo.sh/docs/supported-providers.md
- https://paseo.sh/docs/configuration.md
