# Agent Connect

`0.1.27-rc.1` 是 Paseo 0.17.5 的隔離候選，新增 Devices／Tailscale runtime 支援，保留既有 Tasks。試用安裝、範圍與回復限制見[候選說明](docs/runtime-0175-candidate.md)；尚未替換既有 Pi Web／HA／PaaS 發行套件。

Connect Pi Agent / Pi Web to **Woowtech Smart**, **Apporo Smart**, or **Paseo** from the package settings. Existing installations keep Paseo selected. The installed package remains `@woowtech/pi-paseo`, with its existing command, tool IDs, settings routes and data directory; the bundled `/paseo-web` client was removed in 0.1.23.

Changing the target saves its app URL and relay together. If the daemon is running, finish any conversations, disable the connector, then enable it to apply the change. Target changes clear previous pairing and relay verification; generate a fresh pairing link after restarting. Saving only a display name does not restart the daemon. A target change does not revoke a device already paired with the daemon.

| Target | Web app | Relay |
| --- | --- | --- |
| Woowtech Smart | https://smart.woowtech.io | relay.woowtech.io:443 |
| Apporo Smart | https://smart.apporo.ai | relay.apporo.ai:443 |
| Paseo | https://app.paseo.sh | relay.paseo.sh:443 |

The connector uses official npm Paseo 0.17.5 with a product-managed Better Paseo 1.7.0 builtin. Its source and compiled files are pinned to the Smart integration recorded in `runtime/better-paseo/provenance.json`. Tasks defaults on, chat enhancements default off, saved preferences remain authoritative, and the builtin cannot update itself. Both Smart web apps must support the plugin API; a daemon version number alone does not prove Tasks is installed. The Smart targets keep `daemon.relay.requireProtectedSecurity` off for compatibility with previously deployed clients. Smart mobile push notifications still require a separate fork-specific FCM integration.


Pi Agent / Pi Web 插件，管理共用 Paseo 執行環境，沿用 Claude Code、Codex、Pi 的現有登入、工作目錄及權限。使用者在 **Pi Web 設定 → 插件 → Agent Connect** 選擇連線標的並開始配對。

各標的使用自己的加密 relay；從 Pi Web 的受保護設定頁產生配對連結，再開啟所選標的的官方網站。

`0.1.23` 起不再附內建網頁：Paseo 選項跟兩個 Smart 一樣開啟官方網站 `https://app.paseo.sh`，並在那裡配對。Pi Web 的 `/paseo-web` 路由與網頁包下載（約 11 MB）一併移除；啟動服務時會刪掉舊版留在插件狀態目錄 `web-client` 的網頁檔（只刪舊版建立的項目，不跟隨符號連結，刪不掉也不影響啟動）。升級後要重新啟動 Pi Web（原生與容器的升級流程都會重啟）；重啟前，仍在執行的舊版 Pi Web 無法為 Paseo 產生配對連結，開著的 `/paseo-web` 分頁也會失效。用 `/paseo-web` 配對過的瀏覽器要在官方網站重新配對一次；主機身分、登入與對話不變。0.1.9–0.1.22 內建的修正版（Paseo Web 0.13.0-woow.1）帶有兩項顯示修補：回覆途中重新整理時重複顯示，以及長回覆重連後只剩中間一段。上游 [PR #7908](https://github.com/getpaseo/paseo/pull/7908) 合併並部署前，官方網站可能仍會出現這兩個情況；後端對話不受影響。背景見[修補報告](docs/pi4-stream-reload-2026-10-26.md)。

`0.1.26` 修正原生 Pi Web 的啟動按鈕回饋：連線標的未儲存、或執行中的品牌尚未切換時，先顯示需要的操作；背景啟動持續追蹤到服務就緒。要求逾時會解除畫面等待並標明結果尚未確認，不自動重送啟停。Daemon 與 Tasks 的固定版本沿用 0.1.25。

`0.1.25` 起在官方 Paseo 0.17.4 加入產品管理的 Better Paseo 1.7.0 內建外掛（managed runtime revision `0.17.4-r2-a651f42711da`）。Tasks 預設開啟、聊天增強預設關閉、外掛自行更新停用；保留使用者明確儲存的偏好、繁中與 MIT 授權。來源、建置方式與回復程序見[Tasks 封裝](docs/smart-tasks.md)。升級後第一次啟用只準備新版本目錄；正在執行的 0.17.4-r1 或支援的舊 0.11.2 daemon 繼續服務並回報 `RESTART_REQUIRED`，狀態、配對、設定重新載入與停止仍交由它自己的版本處理。在設定頁停止再啟動後，改用包含 Tasks 的執行環境，同一個 `PASEO_HOME`、server ID、daemon 金鑰、設定與對話資料都保留。上一個版本目錄保留供退回。退回 0.1.24 不需要搬移對話資料，Tasks 外掛資料會保留；退回使用 0.11.2 的 0.1.23 仍須處理上游設定格式差異（包含語音設定的 OpenAI 金鑰位置）。

**無法核對的 daemon：** 狀態、配對、設定重新載入與停止，一律交給啟動該 daemon 的那個版本目錄處理，而且只認得 0.1.4–0.1.23 實際出過的四個 0.11.2 版本（`0.11.2-r4-4cf9d40940bf`、`0.11.2-r3-4cf9d40940bf`、`0.11.2-r3-6d8dbe515479`、`0.11.2-r2-6d8dbe515479`）。執行中的 daemon 若由其他版本啟動，例如較新版插件、0.1.1–0.1.3 的 r1，或版本目錄已刪除、驗證不過，插件回報 `DAEMON_RELEASE_UNAVAILABLE`，不會改用 0.17.4 的模組去控制或停止它，也不會另外啟動第二個。處理方式：裝回啟動它的插件版本並停止服務，或重新啟動容器／主機讓它結束，再啟用。macOS 上 0.1.4–0.1.17 啟動的 daemon 沒有記錄版本，由留著的 r3／r2 版本目錄處理。

**升級時的設定轉換：** 0.17.4 第一次啟動前，插件先用 0.17.4 自己的讀取流程載入 `config.json`，再寫入插件管理的欄位。0.11.2 接受、但 0.17.4 嚴格格式不收的語音設定，照上游規則改寫：`providers.openai` 的金鑰與網址搬進選用 OpenAI 的聽寫／語音設定；沒寫 `provider` 的語音設定補成 `local`；`local` 用不到的欄位（`confidenceThreshold`、`voice` 等）移除。其他設定不動。舊 daemon 還在服務時，插件會先用 0.17.4 檢查下次啟動要寫入的設定。檢查不過時，回報 `CONFIG_INCOMPATIBLE`（`config.json` 有 0.17.4 無法載入的設定）或 `CONFIG_CORRUPT`（不是有效的 JSON），狀態顯示「需要處理」，不是「需要重新啟動」。這時先不要停止服務，舊 daemon 照常服務。要找出哪一項設定，執行 `node ~/.local/share/pi-paseo/runtime/releases/0.17.4-r1-a651f42711da/node_modules/@getpaseo/cli/bin/paseo daemon config get --home <插件狀態目錄>/daemon`，它會列出無法載入的設定路徑。修正或移除後，狀態回到 `RESTART_REQUIRED`，再停止並啟動。

**退回 0.1.23 的限制：** 除了上面的設定，還有 agent 的選項。0.17.4 讀到舊的 agent 記錄時，把 `config.featureValues`（0.11.2 把輸入框裡設定的選項存在這裡）併入 `config.providerOptions`，並把 `features` 改成 `controls`；記錄之後被寫回（開啟、續聊、狀態更新）時就以新格式存檔，0.17.4 不再寫 `featureValues` 與 `features`。0.11.2 只從 `config.featureValues` 和 `features` 讀這些選項，不認得 `controls`（讀取時略過），所以退回 0.1.23 後，已被 0.17.4 寫回的 agent 不會帶回在輸入框設定過的選項，需要重新設定。上面 OpenAI 金鑰搬移與 `CONFIG_INVALID` 的限制照舊。

**0.17.4 的預設值：** 下面兩項在 0.17.4 預設開啟，升級後行為會變。兩項都能即時重新載入：在 `config.json`，或用 `daemon config set <路徑> false --home <插件狀態目錄>/daemon` 改成 `false`（`paseo` 指令用上方 `config get` 的路徑），不必重新啟動。
- `agents.idleRuntimeCleanup`（0.11.2 沒有）：agent 閒置滿 60 分鐘（沒有進行中的工作，也沒有等待它的訊息或訂閱）時，daemon 關閉它的執行期程序；記錄與對話保留為已關閉，下次傳訊息時再開啟。daemon 每分鐘檢查一次。
- `daemon.usage.enabled`（0.11.2 的用量查詢沒有開關，也是開著）：App 的用量標示向 daemon 查詢時，內建的 Claude／Codex 用量來源會讀這台主機的登入檔，拿裡面的憑證呼叫供應商的用量 API。Claude 用量來源讀 `~/.claude/.credentials.json`（或 `CLAUDE_CONFIG_DIR`；macOS 讀鑰匙圈）、Pi 的 `auth.json`、OMP 的 `agent.db`；Codex 用量來源讀 `~/.codex/auth.json`（或 `CODEX_HOME`）、OpenCode 的 `auth.json`（`~/.local/share/opencode/auth.json`，有 `XDG_DATA_HOME` 就在它底下）、Pi 的 `auth.json`、OMP 的 `agent.db`。拿到憑證後呼叫 `api.anthropic.com/api/oauth/usage` 與 `chatgpt.com/backend-api/wham/usage`，結果快取 5 分鐘。只在有用戶端查詢時才會執行；設成 `false` 後，用量查詢回報 `Usage is off on this host.`

**`RESTART_REQUIRED` 與版本欄位：** `restart_required`（`diagnosticCode: RESTART_REQUIRED`）表示 daemon 仍健康地服務，但它現在執行的內容和插件下次啟動要用的不同；插件不會替你停止它，要在設定頁或用 `node bin/cli.mjs stop`、`start` 停止再啟動。原因有三種：daemon 由較舊的 runtime 版本目錄啟動（例如升級後的 0.11.2）；存了新的連線標的（狀態同時帶 `configurationPending: true`）；即時重新載入的設定，daemon 回報須重新啟動。`status` 的 `version` 是已安裝、下次啟動會用的 Paseo 版本，`daemon.version` 才是正在服務的版本：升級後第一次啟用，`version` 是 0.17.4，`daemon.version` 仍是 0.11.2，直到那次停止再啟動。Pi Web 設定頁只顯示階段，不顯示這兩個欄位；`node bin/cli.mjs status` 與 `paseo_status` 工具兩個都有。

**終端機 worker 與 `ps`（Linux）：** 0.17.4 的終端機由獨立的 terminal worker 持有，不是 daemon 的子程序。行程是 `node <PASEO_HOME>/terminal-worker/<Paseo 版本>-<雜湊>/terminal-worker.mjs --paseo-terminal-worker <記錄 ID> --paseo-home <PASEO_HOME> …`，以 detached 方式啟動、由 init 接手，所以 daemon 重新啟動或當機時終端機還在，新 daemon 會接回。worker 的記錄在 `<PASEO_HOME>/terminal-worker/<pid>.json`，沒能確認完成的清理另存為同目錄的 `closing-<記錄 ID>.json`，日誌在 `<PASEO_HOME>/terminal-worker.log`。停止時，daemon 的 supervisor 與 Paseo 的停止流程各清理一次，關閉所有終端機及其程式；啟動時再處理上次沒能確認的記錄，並移除沒有記錄使用的 worker 副本。

找出哪些程序屬於哪個終端機要靠 `ps`：Paseo 在執行停止或啟動的那個行程裡，以該行程 PATH 上的 `ps`，用 `LC_ALL=C` 執行 `ps -A -ww -o pid= -o ppid= -o sid= -o lstart=` 與 `ps -ww -p <pid> -o lstart= -o command=`，以出生時間比對終端機的程式。所以 Linux 主機要有 procps 的 `ps`；精簡映像、busybox／Alpine 的 `ps` 不一定接受這些參數。macOS 同樣從 PATH 找 `ps`，用不含 `sid` 欄的 `ps -A -ww -o pid= -o ppid= -o lstart=`；這是讀原始碼的結果，插件不檢查 macOS 的 `ps`，也沒有在 macOS 上實測。沒有可用的 `ps` 時：
- 啟動與診斷時，插件用同樣的兩個指令檢查一次，回報 `PS_UNAVAILABLE`（跑不起來或逾時）或 `PS_INCOMPATIBLE`（不接受參數或輸出不對）警告。這只是警告，不擋啟動，也不影響 `health` 是否 ready。
- `ps` 的兩種壞法，結果不同：
  - `ps` 跑不起來（找不到、無權限、逾時），或終端機記下出生時間之後 `ps` 才壞掉、讀不到行程表：Paseo 確認不了終端機程序已結束，停止時丟出 `TERMINAL_CLEANUP_NOT_CONFIRMED`（跑不起來時，終端機記錄沒有出生時間，worker 日誌寫 `cannot read the birth time … cleanup will never signal it`）。這時 daemon 已經停止、PID 鎖已經釋放，插件就把這次停止視為完成：階段 `disabled`，並記下 `TERMINAL_CLEANUP_NOT_CONFIRMED` 警告。Paseo 對確認不了的程序不送任何訊號，保留 `closing-*.json`，終端機裡的 shell 和工作可能留成孤兒程序。daemon、supervisor 或 PID 鎖還在時，這不是警告，而是錯誤 `DAEMON_STILL_PRESENT`。
  - `ps` 能執行，但對 `-p` 這類參數以非零結束碼退出（busybox 一類，插件回報 `PS_INCOMPATIBLE`）：Paseo 把非零結束碼讀成「沒有這個行程」（`managed-processes.js` 的 `inspectPosix`），新開的終端機根本不寫進 worker 記錄。停止時沒有東西要確認，清理照樣「成功」，不會有 `TERMINAL_CLEANUP_NOT_CONFIRMED`；worker 仍會關閉它自己持有的終端機，但沒有記錄的背景工作（例如忽略 HUP 的）Paseo 找不到也不處理。這種主機上，只有 `PS_INCOMPATIBLE` 警告提醒你。
- 裝好 procps 之後，清理才會完成：由插件再啟動服務（啟動時 Paseo 重試並關閉殘留），或由插件停止服務；也可以對那個 `PASEO_HOME` 手動執行 `paseo daemon stop` 重試上游的清理。插件記下的 `TERMINAL_CLEANUP_NOT_CONFIRMED` 警告，要到插件下一次啟動服務（之後以 daemon 自己回報的為準）或下一次由插件完成並確認清理的停止才清除；單獨的 `paseo daemon stop` 不會更新它。
- 警告出現在 `status`、`diagnose`、`health` 的 `warnings`（`status`、`diagnose` 每項是 `{code, at}`，`health` 只列代碼）與 `paseo_status`、`paseo_diagnose` 工具，停止指令的結果也帶 `warnings`（只列代碼）。Pi Web 設定頁只顯示白名單欄位，不顯示這些警告。
- `ps` 跑不起來或讀不到行程表時，每次有終端機開著的停止都多留一筆 `closing-*.json`；之後每次清理的兩個階段（supervisor 結束時，以及 Paseo 停止流程裡的那一次）都要再多花約 3 秒看它一次。插件不隨筆數調整停止的時間上限（下方「停止的時間」）；累積到 3 筆，也就是 45 秒預算扣掉結束緩衝後，再多一筆最壞情況就放不下時，插件回報 `TERMINAL_RECORDS_ACCUMULATING` 警告（`count` 是筆數）。這個警告不會顯示在 Pi Web 設定頁（設定頁只顯示白名單欄位），只出現在 `status`、`health` 與 `diagnose`，沒人去看就看不到。3 筆只是照「一個慢的 daemon worker 加兩個沒回應的終端機 worker」算出的門檻，不是失敗的邊界；沒有別的東西時，記錄單獨就讓 supervisor 那一階段每筆多花約 3 秒，累積到十幾筆就把 45 秒的預算用完：daemon worker 立刻結束時是第 15 筆，要等滿 10 秒才結束時是第 12 筆，從那一筆起每次停止都以 `STOP_NOT_CONFIRMED` 失敗（不強制終止任何程序）。所以警告第一次出現就該安裝 procps，不要等到停止開始失敗。處理：安裝 procps，再由插件啟動服務（啟動時 Paseo 重試並收掉），或對那個 `PASEO_HOME` 手動執行 `paseo daemon stop`；這個警告看的是 `closing-*.json` 檔案本身，記錄一收掉就消失。

**停止的時間：** 停止要等 supervisor 結束，最久 45 秒：daemon worker 的關閉最多 10 秒（逾時 Paseo 自己終止它的程序樹），每筆終端機 worker 記錄最多 13 秒（5 秒請它關閉、5 秒等待、終止後 3 秒確認），一個 daemon 最多 2 個 worker，再加緩衝。這之後 Paseo 還會在執行停止的行程裡再清理一次終端機，不算在 45 秒內；插件的 supervisor 等這整段做完才結束，上限 81 秒。逾時回報 `STOP_NOT_CONFIRMED`，插件不強制終止任何程序（沒有 `--force`）。停止一開始就把 `desiredEnabled` 設成 false（要停止的意圖先記下），失敗時不會改回：階段（`phase`）和 daemon 維持原樣，`enabled` 卻已是 false。daemon 若還在，等它自己結束，或由你處理，再按一次停止。上游在 daemon 停止後寫 `closing-*.json` 失敗（磁碟已滿、權限）之類的其他錯誤，同樣讓這次停止回報失敗，即使 daemon 已經停了；再停止一次，插件找不到 daemon，就直接標成已停用。0.11.2 沒有終端機清理，停止只等 supervisor 結束。

停止失敗時的錯誤碼：`STOP_NOT_CONFIRMED`（等不到 supervisor 結束）、`DAEMON_REPLACED`（等的時候，換成了另一個 daemon）、`DAEMON_STILL_PRESENT`（上游回報終端機清理未確認，但 daemon、supervisor 或 PID 鎖仍在，所以沒有停止；和「已停止、附警告」的 `TERMINAL_CLEANUP_NOT_CONFIRMED` 是不同的碼）。`node bin/cli.mjs` 直接印出這三個碼。從設定頁、`stop` 或移除套件停止時，插件的 supervisor 在結束前會自己停止 daemon；這一步失敗，它把結果寫進 `supervisor-stop.json`，主機的停止流程就回報同一個錯誤碼，不再對同一個停不下來的 daemon 多等一輪（否則是兩個 45 秒）。

停止進行時持有執行鎖（`withRuntimeLock`）。這段時間按下的配對或儲存設定，最多等 30 秒，逾時就失敗（內部代碼 `RUNTIME_BUSY`）；另一個啟停操作等主機鎖最多 15 秒，逾時失敗（`LOCK_BUSY`）。`node bin/cli.mjs` 會把這兩個代碼印出來（附一句「稍後再試」）；Pi Web 設定頁的轉接層不分錯誤代碼，操作執行時的任何失敗都只回一則一般訊息（HTTP 503，「Agent Connect 操作尚未完成；請檢查診斷並重試」），所以那裡看不到是哪一個。最壞要幾十秒的停止進行中，其他操作可能先失敗，等停止結束再試即可。前面若有 Cloudflare 這類 100 秒上限的代理，一次最壞的停止加上等鎖可能超過，瀏覽器會看到 524，工作仍在背景進行，之後重新整理狀態即可。

**磁碟空間與舊版本目錄：** 每個 runtime 版本目錄裝好約 0.6–0.7 GB（實測 0.11.2 約 565 MB，0.17.4 約 713 MB），升級後新舊並存約 1.3 GB。目前版本的 daemon 健康啟動之後，插件移除用不到的舊版本目錄（舊 daemon 仍在服務的 `RESTART_REQUIRED` 期間，以及停止時，都不清理），並在 `state.json` 的 `lastPrune` 記下 `removed`、`kept`、`failed` 的版本名稱（只有名稱，沒有路徑）。保留：
- 目前版本；
- 比目前版本舊的版本裡最新的那一個，作為退回用（0.1.24 之後是 `0.11.2-r4-4cf9d40940bf`）。先後依 Paseo 版本、revision 號碼，再依收據（`.pi-paseo-runtime.json`）的時間，也就是裝好的時間。Paseo 版本與 revision 號碼都相同、只有鎖定檔雜湊不同的兩個目錄（r3 就出過兩個）是用收據時間分先後：較晚裝好的算較新，較早的可能就是退回用的那一個；不會只因為號碼相同就被清掉；
- 比目前版本新的版本（包含上面那種同號碼、收據較晚的）：降級插件之後留下的，再升級時就不必重新下載 0.7 GB；
- 還有程序在它的環境變數 `PI_PASEO_RUNTIME_REVISION` 指向的版本，不論那個程序服務哪個 home（Linux 掃描同一使用者的 `/proc`；其他系統只認這個 home 自己的 daemon）。掃描一律往保守的方向：同一使用者的程序，環境變數讀不到（例如 non-dumpable 的程序，`/proc/<pid>/environ` 拒絕存取），或這個 home 的程序沒有標明用哪個版本，這次就不清理（`lastPrune.skipped: RELEASE_IN_USE_UNKNOWN`），下次啟用再試。連 `/proc/<pid>/status` 都被拒絕（`EACCES`、`EPERM`）的程序視為別的使用者的程序，不算：以 `hidepid` 掛載 `/proc` 的主機上，別的使用者的程序都是這樣，算進去清理就永遠不會執行；`status` 因其他原因讀不到才算無法確認。那種掛載上，同一使用者的 non-dumpable 程序連 `status` 也讀不到，掃描看不見它。環境變數讀不到的程序，只有它的命令列（任何人都讀得到）能證明它跑不了 Paseo 版本才不算：Paseo 用 node 執行版本，自己的 supervisor 與 daemon 把行程標題改成 `Paseo …`；所以 tmux 用戶端或 python 小工具不會讓清理停擺，命令列也讀不到的程序會。執行這個插件的程序和它的上層程序不算；其他程序若全域匯出了這個 home 的 `PASEO_HOME`，也會讓清理一直跳過，須取消該匯出；
- 不能確認是插件建立的一切。要同時符合：目錄名是 `<Paseo 版本>-r<n>-<12 位雜湊>`；是真正的目錄（不跟隨符號連結）；`.pi-paseo-runtime.json` 是一般檔案，其 `revision` 等於目錄名，`lockSha256` 以目錄名的雜湊開頭。別的名稱、檔案、符號連結、沒有收據或收據對不上的目錄、舊版留下的 `<runtimeDir>/node_modules`（舊版控制用副本），以及 `releases/` 以外的東西，一律不動。

啟用時只在執行鎖之內做便宜的部分：判斷，並把版本目錄改名成 `.pruning-<版本名>-<UUID>`（一步完成，不會留下半個還像版本目錄的東西）。真正的刪除（SD 卡上 0.7 GB 可能要很久）在鎖釋放之後，由背景工作做：配對、儲存設定、停止不必等它；結果之後才寫進 `lastPrune`。刪除一次只做一個檔案操作，從最底層往上，每 64 個操作停 2 毫秒，不跟隨符號連結；不像 `fs.promises.rm` 那樣一次把整個目錄的項目都排進執行緒池。50,000 個檔案、快速磁碟上的實測：`fs.promises.rm` 約 1.1–1.6 秒刪完，事件迴圈最多停 250–310 毫秒，同時的小檔案讀取最多等 0.8–1.3 秒；現在的做法約 7 秒刪完（SD 卡上更久，但只是背景工作），事件迴圈最多停 5–7 毫秒，同時的讀取通常 1–2 毫秒（三次量測有一次出現 150 毫秒）。收到停止要求（supervisor 的 SIGTERM、`deactivate`）時，進行中的刪除在下一個檔案操作之前就結束；supervisor 因為停止失敗而結束時也是，所以不會拖著程序等刪除、讓主機等到「仍在停止」。中止的那一次不寫 `lastPrune`（它只描述做完的一次）。程序在刪到一半時結束（容器停止、Pi Web 重啟），剩下的 `.pruning-*` 由下一次以健康狀態結束的啟用接著刪（回報 `RESTART_REQUIRED` 的那一次不清理，也不接著刪），即使那時只剩目前版本和退回用的版本，也不管那時有沒有哪個程序讓掃描無法確定。清理盡力而為，失敗只記在 `lastPrune.failed`，不影響啟用與狀態。代價是退回只到前一個版本：再經過一次升級，要退回更早的插件版本，須重新下載它的 runtime（需要網路）。

## 0.1.10 PID 復原修補

此歷史修補的 managed runtime revision 為 `0.11.2-r3-6d8dbe515479`，沿用 0.11.2 的固定依賴，額外驗證並修補兩份官方 PID writer。Linux 下，健康啟動或採用後會記錄私有程序出生證明；若同一核心重用了 PID，只在原 installation、home、PID lock 與 boot/start identity 都能證明舊程序已消失時，才隔離自己的過期 PID record 並重新啟動。外來程序不會被終止；設定、登入、資料庫、配對及初始化對話保留。

這項自動復原需要此前成功啟動時建立的 proof。舊版沒有可信 proof 的陌生 PID 仍回報 `DAEMON_NOT_OWNED`，不會自動清檔。仍健康運作的 r2 daemon 會回報 `RESTART_REQUIRED`；正常停止後再啟用即可建立 r3 proof，無須移除私人資料。

`linux-flock-v1` 共同鎖涵蓋這份 r3 runtime 兩個官方模組的 acquire、refresh、update、release，包括直接使用該 runtime 的 CLI。獨立安裝的舊版 CLI 或任意同 UID 程式不受此協定保護，不能與本插件共用其私有 `PASEO_HOME`。未知或不完整的 runtime patch、缺少協定標記、不安全檔案與另一個存活 supervisor 都會停止復原。不要刪除持久的 `.pi-paseo-pid-transition.guard`；它是所有 writer 共用的鎖 inode。

已完成 UID1000 隔離環境的實際 daemon 啟動、配對、受控 receipt 復原、r2 遷移及並行冷啟動驗證，沒有模型呼叫或 live fleet 變動。這不是強制核心 PID 重用／OOM 或最終發行映像的驗收；範圍見[驗證紀錄](docs/validation.md)。

## 相容版本

- Node.js 22.19.0+、npm、git。Linux（包含 Windows 既有 WSL2、Ubuntu、k3s/PaaS、HA add-on）需要 util-linux `flock`，以及 procps 的 `ps`（Paseo 0.17.4 停止與啟動時用它確認終端機程序已結束；缺少的後果見上方「終端機 worker 與 `ps`」）；macOS 使用 Node SQLite 交易鎖。原生 Windows 不在本次範圍。各平台的真實部署與 provider 驗收須分別記錄，不能由來源測試推定通過。
- Pi `@earendil-works/pi-coding-agent` 1.0.0+。
- Pi Web 0.10.0，整合層固定基底 commit `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`。
- Paseo `@getpaseo/cli` 0.17.4（managed runtime revision `0.17.4-r2-a651f42711da`，內建 Better Paseo 1.7.0），使用發行包內固定的修補依賴 lockfile，下載至持久 HOME 的獨立版本目錄。0.1.18–0.1.23 安裝的 `0.11.2-r4-4cf9d40940bf` 等 0.11.2 版本目錄只保留給升級前仍在執行的 daemon 停止使用。
- 登入在執行 Pi Web 的同一使用者 HOME。插件沿用現有 provider CLI；缺少時下載固定版本到插件的獨立目錄。既有帳號資料用於官方 CLI 登入。

啟用本機聽寫或語音模式時，服務的 PATH 還需要 `tar` 與 `bzip2`，並預留語音模型下載、解壓縮與執行所需空間。Paseo 會自動下載缺少的模型；精簡容器沒有 `bzip2` 時，可能已下載完整壓縮檔卻回報 `tar exited with code 2`。容器映像應安裝此相依套件，或使用服務啟動時可找到的持久化工具；只在暫時容器層安裝，重建後會消失。本插件不會替容器安裝 OS 套件。Pi4 的實測與恢復紀錄見 [儲存復原驗證](docs/pi4-storage-recovery-2026-10-25.md)。

## 完整安裝

此 repo 已公開，下載不需要 GitHub 帳號或 token。

在 Pi Web 的 **設定 → 插件 → 安裝** 貼上：

```text
https://github.com/WOOWTECH/pi-paseo-plugin
```

舊版正式部署範例為 `git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.16`。部署新版 Agent Connect 時，請固定已發布的正式標籤，或使用核對過來源與 SHA256 的候選套件；不要假設候選版本已發布。若同一 Pi Web 也安裝 Omnigent，兩個套件的共用介面必須使用同時驗證過的 adapter 版本與 SHA-256，再重新啟動 Pi Web。配對只在 **設定 → 插件 → Agent Connect** 執行。各版本的實測範圍請參考驗證紀錄。

或在 Pi Web 使用者的終端直接執行：

```bash
pi install https://github.com/WOOWTECH/pi-paseo-plugin
```

Git 安裝會下載依賴並執行 postinstall。首次安裝準備完成後，依下面的啟動入口說明重新啟動 Pi Web，即可在 Agent Connect 設定中選擇並連接目標平台。

在 Pi Web 使用者的持久化 HOME 執行：

```bash
git clone https://github.com/WOOWTECH/pi-paseo-plugin.git
cd pi-paseo-plugin
bash scripts/install.sh --source "$PWD"
```

安裝器從目前 checkout 的完整 commit SHA 建立持久化副本，以 lockfile 安裝依賴，註冊 Pi package，套用經 SHA-256 校驗的 Pi Web 補丁並建置正式整合層，再啟動 Paseo。建置使用兩個 Next.js worker。已安裝相同版本時沿用既有建置；更新保留使用者手動停止的狀態。建置失敗保留舊版本及原有入口。

Pi Web 本身需要重新啟動一次才能載入新的整合層。安裝器只準備下一次啟動的入口並回報 `restartRequired`；請透過原服務管理方式重新啟動。原容器以 PATH 呼叫 `pi-web` 時可使用持久化 launcher；已有 shared-runtime 或 Omnigent 啟動器時沿用其原始呼叫鏈。若回報 `manual-routing-required`，請將現有 launcher 的 Pi Web 終端入口接到回報的 `pendingRestart` 路徑。

從 Pi Web 插件頁安裝 npm 發行包時，postinstall 同樣下載 Paseo、準備 Pi Web 整合層並啟動服務。插件頁在首次加入整合層後，需要重新啟動 Pi Web 才能顯示設定頁內的 Agent Connect 控制項。

若回報 `pathUpdateRequired: true`，將回報的 `launcherDirectory` 放到服務啟動環境的 PATH 最前方，再重新啟動。Kubernetes 容器需設定工作負載的 PATH，終端中的 `export PATH=...` 只作用於該次終端。

第一次載入整合層後，在 **設定 → 插件** 選擇 Agent Connect。安裝、啟用及 Pi Web 重啟會啟動／恢復服務，不會建立對話或自動開啟品牌網站。舊的 `/paseo/setup` 連結會導向插件設定；停用／移除只停止插件擁有的程序，保留既有對話、provider 登入及 Paseo 資料。

## 設定與配對

1. 到 **設定 → 插件 → Agent Connect**，選擇 **Woowtech Smart／Apporo Smart／Paseo** 並儲存。若服務正在執行，先結束使用中的回合，再停止並啟動服務，確認新標的已套用。每台主機一次連接一個標的。主機握手會同步宣告所選品牌，供 Smart 網頁確認連線身份；切換後須重新啟動才能套用。
2. 缺少或過期的登入，使用 `claude auth login`、`codex login` 或 Pi 的 `/login`。密碼、API Key 與 OAuth 資訊只在官方登入介面或 Pi Web 模型設定輸入。
3. 確認服務已就緒，按 **產生配對連結**，再用顯示所選平台名稱的按鈕開啟該平台的官方網站並確認配對。切換網站需在新網站配對，Claude／Codex／Pi 的主機登入沿用。
4. 在所選網站選擇這台主機、Claude Code／Codex／Pi、可用模型、模式及思考等級，再建立對話。

模型目錄由 Paseo 動態取得，插件不硬編模型、不強制完整權限。設定頁分別顯示程序啟動、服務可達、relay 歷史驗證與真正對話驗證；帳號額度耗盡會顯示對話限制。

### 允許代理彼此協作（0.1.22 起，預設關閉）

設定頁的「允許代理彼此協作」開關控制 Paseo daemon 的 `daemon.mcp.injectIntoAgents`。Paseo（0.11.2 與 0.17.4）預設不開，所以透過 Agent Connect 執行的代理不會拿到 Paseo 的管理工具。

- 開啟後，代理可以建立代理、終端機和排程，並對這台主機上任何代理傳訊息、切換它的權限模式（包括不需確認的模式）、替它批准權限請求。終端機可以直接執行指令，不經權限確認。只要有一段對話被惡意內容誘導，就可能藉此控制這台主機上的其他對話，所以只在信任這台主機上所有對話內容時開啟。
- 這不是沙盒：就算關閉，被允許執行指令的代理仍可以直接使用本機的 `paseo` CLI。
- 開關顯示的是 daemon 設定（`config.json`）的實際值；Paseo 用戶端的主機設定也能改同一個值，兩邊看到的會一致。尚未啟動過服務時，選擇先存在 `preferences.json`，第一次啟動時寫入。
- 只有動過開關才會一起儲存。服務執行中會立刻寫入並重新載入 daemon 設定，不必重新啟動；daemon 無法即時套用時，設定頁會提示停止再啟動服務。
- 變更只影響之後新開的對話。關閉時，已在執行的代理（包括重新開啟、仍在記憶體裡的對話）保留原本的工具，已建立的排程也會繼續執行；要立即全部停用，請停止再啟動 Agent Connect 服務，並在 Paseo 裡檢查排程。
- 0.1.21 以前的設定沒有這個值，升級後視為關閉。

### 顯示名稱

設定頁的名稱是 Pi Web 插件的顯示標籤，可使用大小寫、中文及空白，長度上限 100 字元；空白名稱會使用 `Pi Agent`。儲存標籤不會啟停服務或重新驗證帳號。Paseo 0.11.2 與 0.17.4 的 daemon 設定都不支援 `name`／`displayName`：官方 Web 初始名稱來自容器 hostname，改名則儲存在 Paseo 客戶端。需要變更官方 Web 顯示名稱時，請在該介面重新命名 host；插件不宣稱已同步此名稱。既有插件名稱偏好會保留，重新啟動會移除過去錯誤注入的 `daemon.name`，避免 `CONFIG_INVALID`。

### 沿用 Omnigent 選定的 Claude gateway

若同一使用者的 `~/.omnigent/config.yaml`（或 `OMNIGENT_CONFIG_HOME/config.yaml`）已將 Anthropic 預設 provider 設為 `kind: gateway`，插件啟動／恢復服務時會沿用該選擇。這項整合需要 PATH 中可用的 Omnigent 與其 Python 環境，以及 `anthropic.auth_command`、`anthropic.models.default`；模型清單只列出該設定宣告的實際模型，會展開 tier 別名並合併重複項目。它沿用既有 gateway 授權，不表示 Claude 官方訂閱已登入。

驗證命令由 Claude 的 invocation-local `apiKeyHelper` 按需執行，最長快取 15 分鐘；插件不把命令或產生的憑證寫入 Paseo 設定、啟動檔或日誌，也不修改 Omnigent 設定與官方登入檔。插件私有目錄內的 `0700` 啟動檔只存路徑與設定指紋，讓 Paseo 的 Claude SDK 能用單一執行檔啟動。驗證命令的輸出上限為 4 KB、逾時為 20 秒，失敗只回報固定錯誤碼。

在 Omnigent 切回官方 Claude provider 後，於 Agent Connect 設定按「啟動服務」會恢復原本的 Claude 執行檔與模型設定。變更 gateway、模型或驗證命令後也要執行此操作，再建立新的對話；舊設定指紋會被拒絕，避免沿用錯誤路由。此整合僅支援既有 `auth_command` 型 gateway 與 HTTPS（本機 loopback 可用 HTTP）；inline key、secret reference、其他 provider 類型不在此自動橋接範圍。gateway 缺少必要設定時會標示不可用，不會改用另一個帳號。

從 gateway 改用 Claude 官方訂閱時，先在 Pi Web 相同 HOME 執行 `claude auth login --claudeai`，完成[官方瀏覽器授權](https://code.claude.com/docs/en/authentication)，再將 Omnigent 的 **Anthropic 預設來源**選為 Claude 訂閱並於 Agent Connect 設定啟動服務。只完成 CLI 登入，不會覆蓋仍被選用的 gateway。切換時保留 OpenAI 與 Pi 的預設來源；官方登入資料由 Claude CLI 管理，不應貼入 Paseo 或 Omnigent 的設定檔。Pi4 的切換、重啟及實測範圍見[官方訂閱驗證](docs/pi4-official-subscription-2026-10-26.md)。

### 選用 Omnigent gateway 作為 Codex 模型來源

有 OpenAI Responses 相容 Omnigent 路由的部署，可參考[通用封裝範例](examples/omnigent-codex-gateway.py)，用 Paseo [自訂 provider](https://paseo.sh/docs/custom-providers) 的 `extends: "codex"`、`command`、`env` 和 `models` 建立獨立選項。範例需要 Python YAML 套件，以及 `PI_PASEO_OMNIGENT_CONFIG`、`PI_PASEO_OMNIGENT_PROVIDER`、`PI_PASEO_CODEX_BINARY`；可用 `PI_PASEO_CODEX_HOME` 指定私有 Codex home。範例每次啟動從受保護的 Omnigent 設定執行既有 `pi auth print-api-key` 命令，把憑證放在 Codex 子程序環境，專用 `config.toml` 只寫入路由和模型。部署者須保護設定檔與工作目錄，並在變更後執行 `paseo --home /path/to/paseo-home daemon reload`，指定這個插件管理的 daemon home。

Codex 的 gateway 仍須另外設定；標準安裝不會更改內建 `codex` provider 的登入。自訂路由的可用性應以該路由的實際對話驗收；它不代表 OpenAI 官方帳號已登入。Codex [自訂模型提供者設定](https://learn.chatgpt.com/docs/config-file/config-advanced) 說明協定和憑證環境變數。

### 官方 Codex 與 gateway 的設定隔離

若官方登入成功，內建 Codex 的模型清單卻只有 gateway 模型，請檢查它實際使用的 `CODEX_HOME/config.toml`。其他整合工具可能在共用設定加入 `model_catalog_json`，導致登入有效、模型目錄卻指向另一條路由。2026-10-25 的實機驗收曾重現並解決此情況。

需要兩種來源並存時，為官方 Codex 建立獨立的私有目錄，並將下列 `env` 合併到既有 Paseo 設定；保留其他 provider 及設定：

```json
{
  "agents": {
    "providers": {
      "codex": {
        "env": { "CODEX_HOME": "/path/to/private/paseo-codex-home" }
      }
    }
  }
}
```

目錄權限使用 `0700`、憑證檔使用 `0600`。在同一執行使用者下，以相同 `CODEX_HOME` 和 provider 的官方 CLI 完成 `codex login --device-auth`；後續重新登入也必須使用這個目錄。若共用啟動器會改寫模型設定，登入時使用 provider `command` 指定的原始官方執行檔。此目錄不應沿用 gateway 的 `model_catalog_json` 或路由設定。完成後重載指定 daemon，重新讀取模型並執行兩輪驗收；官方 Codex 與自訂 gateway 都應各自驗證。

## Pi 操作

- **Pi Web 設定 → 插件 → Agent Connect**：唯一的配對與整合設定入口。
- `paseo_status`、`paseo_diagnose`、`paseo_models`：無秘密的狀態及模型探測。
- `paseo_chat`、`paseo_continue`：建立與續接 Paseo 對話。

Shell 操作：

```bash
node bin/cli.mjs status
node bin/cli.mjs health
node bin/cli.mjs diagnose
node bin/cli.mjs models codex
node bin/cli.mjs start
node bin/cli.mjs stop
```

`node bin/cli.mjs acceptance` 會對三種 provider 各發送兩則小型驗收訊息，使用現有帳號額度。驗收完成後自動歸檔此次測試對話，保留紀錄並釋放 provider 程序；清理失敗也會使整體驗收失敗。CLI 配對僅在私人終端用 `pair --reveal`；一般使用者應使用設定頁，配對連結不應進入聊天、Git 或一般日誌。

## 資料與生命週期

預設狀態放在 `$PI_CODING_AGENT_DIR/pi-paseo/`，未設定時使用 `~/.pi/agent/pi-paseo/`；Paseo 自有 home 位於該狀態目錄的 `daemon/`。runtime 使用 lockfile 雜湊識別獨立版本，不覆寫正在使用的舊依賴；更新後若 daemon 尚在使用舊版本，需停止後啟動或透過既有容器服務重啟。新版本健康啟動後，不再需要的舊版本目錄依「磁碟空間與舊版本目錄」的規則清理。套件與整合層放在 `~/.local/share/pi-paseo/`。provider 的 HOME 和 Pi data directory 沿用原環境。

daemon 預設只監聽 loopback 的 6769 埠，埠被占用時選擇其他可用埠。relay 配對不需要對外開啟容器埠。背景 supervisor 每 15 秒只讀 PID 鎖與 `/proc` 的程序 metadata，故障時恢復插件服務；它不向 daemon 查狀態，因為 Paseo 每回答一次狀態查詢，就對每個啟用的 provider 執行一次 `--version`（4 核 H618 上，原本的 15 秒輪詢約佔閒置 CPU 的六成）。這不會週期性呼叫模型。Pi 的 `models.json` 或 `settings.json` 在 daemon 建好 Pi 模型清單之後有變動時，supervisor 會請 daemon 重建一次 Pi 清單（每次變動只試一次，失敗也不重試）；`models pi` 讀取前也做同樣的檢查。Pi Web 整合層在重啟後恢復 supervisor。

`state.json` 僅保存白名單狀態；配對資訊放在 mode 0600 的專用檔案，設定頁回應使用 `no-store`。舊版、其他使用者或未標記的 Paseo home 不接管。既有初始化對話資料會保留，但插件不再建立或開啟它。

## 開發及驗收

```bash
PI_PASEO_SKIP_POSTINSTALL=1 npm ci
npm test
node --test scripts/install-host.test.mjs scripts/bootstrap.test.mjs
npm run typecheck
node scripts/check-package.mjs
node scripts/verify-package-install.mjs
node scripts/verify-host.mjs
# 選用，不在 CI：真實 daemon 的升級實測（見「商業部署維護」）
PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs
npm audit --omit=dev
npm audit --omit=dev --prefix runtime
npm pack --ignore-scripts
```

`host/adapter.patch` 包含 Pi Web 整合原始碼及測試，`host/adapter-meta.json` 包含相容基底與 SHA-256。原始 Pi Web 的完整 checkout、依賴、建置物及本機登入資料都不放入插件發行包。

對話驗收成功以實際 assistant 回覆與新的續聊訊息判定。CLI 存在、模型清單出現或 provider idle 都不能代表可對話。若 Claude 回報 `PROVIDER_QUOTA_EXHAUSTED`，請等待帳號額度恢復或在官方登入入口改用有額度的授權帳號，再重跑驗收。

## 商業部署維護

`health` 輸出不含秘密；只有已安裝、啟用、程序屬於本插件、服務可達且三種 provider 可啟動時才回傳 exit 0。真正對話及 relay 配對另外顯示驗證時間，不能以歷史成功取代目前連線健康。

升級實測（選用，不在 CI）：`PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs [all|upgrade|fresh]` 用真實的 Paseo daemon 走一次升級。它會下載兩個 runtime（約 1.3 GB）、啟動真實 daemon，要幾分鐘；需要 Linux、tar、npm 與 npm registry 連線，以及含 0.1.23 的 git 歷史（commit `152e1c3`；`PI_PASEO_UPGRADE_OLD_REF` 可指定別的）。沒設 `PI_PASEO_UPGRADE_SMOKE=1`，或不在 Linux，就直接略過。全部在一個暫存目錄裡：獨立的 HOME、插件狀態與 runtime 目錄，PATH 前面放會失敗的 provider 指令，所以不會安裝或啟動任何 provider；結束時刪除暫存目錄與所有指向它的程序，包含終端機 worker。不會讀寫使用者自己的 Paseo；daemon 會像一般安裝那樣，以一次性的身分連 relay.paseo.sh。`upgrade`：0.1.23 安裝 0.11.2 並啟動 daemon，建立 workspace 與配對；接著用這個目錄的程式，確認回報 `RESTART_REQUIRED` 而舊 daemon 照常服務（載入的上游模組只有 0.11.2 的，加上檢查下次啟動設定的 `config.js`）；停止再啟動後，同一個 `PASEO_HOME` 由 0.17.4 執行，server ID、daemon 金鑰、配對記錄與 workspace 都在，舊版本目錄保留並仍可驗證，只有一個預先放好的過期版本目錄被清掉。`fresh`：空白主機的安裝、啟動、配對連結外觀與握手、一個終端機 worker；再讓 `ps` 在終端機開著時失效，確認停止以警告完成、沒有任何程序被送訊號（worker 仍在）；`ps` 仍壞時重新啟動照常運作，由 daemon 自己回報關不掉的終端機；`ps` 恢復後的下一次啟動自己關掉這個孤兒。兩個情境都核對 `daemon config get` 會指出無法載入的設定名稱。腳本只印非機密事實，不印配對連結、金鑰、server ID 或環境變數。

狀態查詢合併並行請求，provider 狀態探測最多快取 3 秒；每次仍重新核對程序身分。Settings → Agent Connect 開著（分頁可見）時每 5 秒查一次狀態，每次都會讓 Paseo 執行各 provider 的 `--version`。UI 操作期間暫停輪詢，過期狀態不顯示為已就緒。診斷、模型查詢不占用安裝／啟停操作序列。

安裝器使用程序群組時限與 Linux 核心鎖，建置或發布失敗回滾自身變更。更新期間請避免外部同時編輯 launcher；安裝器保留偵測到的外部改動，檔案系統不提供跨外部寫入者的原子 compare-and-swap。程序群組無法涵蓋刻意逃離 session 的程序，部署隔離依賴容器及其資源限制。

從舊的 Git 安裝來源改用不可變版本路徑時，請將原 Pi package 登記替換成新來源，維持一個有效的 Paseo 登記；不同路徑不會被 Pi 自動視為同一套件。先備份 settings，保留原本的停用狀態及初始化對話。Pi 5 此次升級已完成來源替換，舊來源與建置保留供回滾。

反向代理若會清空 `Origin` 或改寫 `Host`，必須在改寫前驗證來源；也需保留並拒絕瀏覽器的 `Sec-Fetch-Site: cross-site`。Pi 5 的入口代理已對 `/api/plugin-paseo` 加入限定正式網址的檢查。部署範例與驗收方式見 [代理來源防護](docs/proxy-origin.md)。

Pi SDK 1.0.0 的內嵌 shrinkwrap 忽略消費者 overrides；安裝階段會以固定官方 `brace-expansion` 5.0.12、`undici` 8.12.3 替換其私有受影響依賴，並由回歸測試驗證 API 相容性。插件自身的 SDK 另將私有 `minimatch` 10.2.6 換成固定的 11.0.1（GHSA-g3hv-75wg-m249）；11.0.1 新增的 `@isaacs/nonrecursive-glob-match` 由發行 lockfile 安裝在上層 `node_modules`，若 SDK 位置載入不到同一版本，修補會在替換前中止並保留原檔。Pi SDK 1.5 起自帶已修補的 `minimatch`，安裝時不更動。Pi Web 主機 adapter 尚未固定 `minimatch`，主機建置內的 SDK 副本不在此替換範圍。請使用發行 lockfile 和安裝流程，避免在使用中的套件目錄執行 `npm install` 或 `npm ci`。

完整驗收紀錄與已知限制見 [驗證紀錄](docs/validation.md)；三品牌、兩台獨立主機及五平台的 Craft Anything 驗收方式見 [功能一致性標準](docs/smart-web-parity.md)。

## 官方參考

實際安裝、三種 provider 對話及 relay 驗證結果見 [驗證紀錄](docs/validation.md)。

- [Paseo 連線方式](https://paseo.sh/docs/connectivity.md)
- [Paseo 自架 Web UI](https://paseo.sh/docs/web-ui.md)
- [Paseo provider 支援](https://paseo.sh/docs/supported-providers.md)
- [Pi Web](https://github.com/agegr/pi-web)

### 手機捲動修正（v0.1.5）

Paseo 設定面板現在位於 Pi Web 的插件設定內容區，沿用該區的垂直捲動；長模型名稱會換行。更新插件後請重建並重新啟動 Pi Web，再重新整理瀏覽器。主機驗證包含手機直向、橫向、桌面，以及展開 60 個模型後的實際觸控／滑鼠捲動回歸測試。

### 同時升級兩個插件

已有舊版 Omnigent／Paseo 的環境，先升級 Omnigent，再安裝對應的 Paseo。固定版本組合不可交叉混用：

```sh
pi install git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.12
pi install git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.7
```

Paseo 安裝器會交給 Omnigent 建立共用介面；完成後重啟 Pi Web，再到 **設定 → 插件 → Paseo** 配對。收到 `RESTART_REQUIRED` 時，完成重啟後重新整理並驗證三種引擎對話。首次編譯建議預留至少 3 GiB 可用磁碟空間；實測不足 1 GiB 時套件安裝可能因 `ENOSPC` 失敗。官方 Paseo 的主機顯示名稱請在 Paseo App 內修改；插件的「容器備註」僅存於設定頁。

Paseo 安裝器會優先使用已登記在全域設定的 GitHub 版 Omnigent（`git:`、`https://`、`ssh://` 寫法與 `@ref`／`#ref` 皆可），不會再被映像用 `PI_OMNIGENT_PLUGIN_ROOT` 指向的內建舊版拖住而在安裝時失敗；已登記卻找不到或不是 Omnigent 套件時會停止並回報 `OMNIGENT_COORDINATOR_UNAVAILABLE`／`OMNIGENT_COORDINATOR_INVALID`。專案層級（`.pi/settings.json`）的安裝尚未納入此判斷。

**升級映像內建的副本：** Pi Agent 映像把 Omnigent、Paseo 以 `/opt/woow/...` 路徑登記在設定裡。從設定頁或 `pi install` 裝上新版只會「另外多一筆」，不會取代內建項目；重啟時映像啟動腳本挑第一筆同名套件，仍載入內建舊版，Omnigent 設定頁會一直顯示舊版本號。兩個新版都裝好後，請到 **設定 → 插件** 移除 `/opt/woow/pi-omnigent-plugin` 與 `/opt/woow/pi-paseo-plugin` 這兩筆，再重啟 Pi Web。這個流程已在 `pi-agent:20261026.2019`（內建 Omnigent 0.3.21、Paseo 0.1.10）的隔離 Pod 驗證：移除並重啟後，設定頁顯示 Omnigent 0.3.27，Paseo 服務正常，兩者各只剩一筆。

2026-10-26：Pi4 已部署修正版 `/paseo-web`，完成 Claude 串流中重新整理及三引擎續聊驗收，詳見[正式部署報告](docs/pi4-managed-web-2026-10-26.md)。

2026-11-25：0.1.23 移除內建 `/paseo-web`，Paseo 選項改開官方 `app.paseo.sh`。

2026-11-25：0.1.24 管理的 Paseo daemon 升到 0.17.4；升級前的 0.11.2 daemon 要停止再啟動才會換版。
