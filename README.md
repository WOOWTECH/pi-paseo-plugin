# Pi Paseo plugin

Pi Agent / Pi Web 插件。在 Pi 容器中下載並管理 Paseo，沿用 Claude Code、Codex、Pi 的現有登入、工作目錄及權限。Pi Web 安裝／啟用後建立一次「Paseo 連線初始化」對話；未完成時續用同一對話。

Paseo Remote 使用官方加密 relay，從 Pi Web 的受保護設定頁產生配對連結，再在新分頁開啟完整 Paseo。官方 relay 不需要額外的 Paseo 帳號密碼。

## 相容版本

- Linux、Node.js 22.19.0+、npm、git、util-linux `flock`。其他平台目前不納入此版本的部署驗收。
- Pi `@earendil-works/pi-coding-agent` 1.0.0+。
- Pi Web 0.10.0，整合層固定基底 commit `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`。
- Paseo `@getpaseo/cli` 0.11.2，使用發行包內固定的修補依賴 lockfile，下載至持久 HOME 的獨立版本目錄。
- 登入在執行 Pi Web 的同一使用者 HOME。插件沿用現有 provider CLI；缺少時下載固定版本到插件的獨立目錄。既有帳號資料用於官方 CLI 登入。

## 完整安裝

此 repo 已公開，下載不需要 GitHub 帳號或 token。

在 Pi Web 的 **設定 → 插件 → 安裝** 貼上：

```text
https://github.com/WOOWTECH/pi-paseo-plugin
```

正式部署可固定 `git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.7`。若同一 Pi Web 也安裝 Omnigent `v0.3.12`，請在兩個套件都安裝後執行 `pi-omnigent install-ui`，建立經兩份補丁驗證的共用介面，再重新啟動 Pi Web；全域設定順序為 **MCP → Omnigent → Paseo**。各版本的實測範圍請參考驗證紀錄。

或在 Pi Web 使用者的終端直接執行：

```bash
pi install https://github.com/WOOWTECH/pi-paseo-plugin
```

Git 安裝會下載依賴並執行 postinstall。首次安裝準備完成後，依下面的啟動入口說明重新啟動 Pi Web，即可開啟 Paseo 插件設定及初始化對話。

在 Pi Web 使用者的持久化 HOME 執行：

```bash
git clone https://github.com/WOOWTECH/pi-paseo-plugin.git
cd pi-paseo-plugin
bash scripts/install.sh --source "$PWD"
```

安裝器從目前 checkout 的完整 commit SHA 建立持久化副本，以 lockfile 安裝依賴，註冊 Pi package，套用經 SHA-256 校驗的 Pi Web 補丁並建置正式整合層，再啟動 Paseo。建置使用兩個 Next.js worker。已安裝相同版本時沿用既有建置與初始化對話；更新保留使用者手動停止的狀態。建置失敗保留舊版本及原有入口。

Pi Web 本身需要重新啟動一次才能載入新的整合層。安裝器只準備下一次啟動的入口並回報 `restartRequired`；請透過原服務管理方式重新啟動。原容器以 PATH 呼叫 `pi-web` 時可使用持久化 launcher；已有 shared-runtime 或 Omnigent 啟動器時沿用其原始呼叫鏈。若回報 `manual-routing-required`，請將現有 launcher 的 Pi Web 終端入口接到回報的 `pendingRestart` 路徑。

從 Pi Web 插件頁安裝 npm 發行包時，postinstall 同樣下載 Paseo、準備 Pi Web 整合層並啟動服務。插件頁在首次加入整合層後，需要重新啟動 Pi Web 才能顯示 Paseo 專用入口。

若回報 `pathUpdateRequired: true`，將回報的 `launcherDirectory` 放到服務啟動環境的 PATH 最前方，再重新啟動。Kubernetes 容器需設定工作負載的 PATH，終端中的 `export PATH=...` 只作用於該次終端。

第一次載入整合層後，在 **設定 → 插件** 選擇 Paseo，按 **設定 Paseo**。也可直接開啟 `/paseo/setup`。安裝、啟用及 Pi Web 重啟會啟動／恢復服務並建立或續接初始化對話；停用／移除只停止插件擁有的程序，保留對話、provider 登入及 Paseo 資料。

`v0.1.4` 在建立會話的請求中提交初始化提示。若 Pi Web 明確拒絕提示（例如尚無可用模型），會保留可重試狀態，不記錄空會話 ID；模型就緒後由插件生命週期再嘗試。

## 設定與配對

1. 開啟初始化對話及 `/paseo/setup`，查看服務與三種 provider 的診斷。
2. 缺少或過期的登入，使用 `claude auth login`、`codex login` 或 Pi 的 `/login`。密碼、API Key 與 OAuth 資訊只在官方登入介面或 Pi Web 模型設定輸入。
3. 在設定頁按 **產生配對連結** → **使用配對連結開啟 Paseo**。
4. 在 Paseo 選擇這個容器、Claude Code／Codex／Pi、可用模型、模式及思考等級，再建立對話。

模型目錄由 Paseo 動態取得，插件不硬編模型、不強制完整權限。設定頁分別顯示程序啟動、服務可達、relay 歷史驗證與真正對話驗證；帳號額度耗盡會顯示對話限制。

### 顯示名稱

設定頁的名稱是 Pi Web 插件的顯示標籤，可使用大小寫、中文及空白，長度上限 100 字元；空白名稱會使用 `Pi Agent`。儲存標籤不會啟停服務或重新驗證帳號。Paseo 0.11.2 的 daemon 設定不支援 `name`／`displayName`：官方 Web 初始名稱來自容器 hostname，改名則儲存在 Paseo 客戶端。需要變更官方 Web 顯示名稱時，請在該介面重新命名 host；插件不宣稱已同步此名稱。既有插件名稱偏好會保留，重新啟動會移除過去錯誤注入的 `daemon.name`，避免 `CONFIG_INVALID`。

### 沿用 Omnigent 選定的 Claude gateway

若同一使用者的 `~/.omnigent/config.yaml`（或 `OMNIGENT_CONFIG_HOME/config.yaml`）已將 Anthropic 預設 provider 設為 `kind: gateway`，插件啟動／繼續初始化時會沿用該選擇。這項整合需要 PATH 中可用的 Omnigent 與其 Python 環境，以及 `anthropic.auth_command`、`anthropic.models.default`；模型清單只列出該設定宣告的實際模型，會展開 tier 別名並合併重複項目。它沿用既有 gateway 授權，不表示 Claude 官方訂閱已登入。

驗證命令由 Claude 的 invocation-local `apiKeyHelper` 按需執行，最長快取 15 分鐘；插件不把命令或產生的憑證寫入 Paseo 設定、啟動檔或日誌，也不修改 Omnigent 設定與官方登入檔。插件私有目錄內的 `0700` 啟動檔只存路徑與設定指紋，讓 Paseo 的 Claude SDK 能用單一執行檔啟動。驗證命令的輸出上限為 4 KB、逾時為 20 秒，失敗只回報固定錯誤碼。

在 Omnigent 切回官方 Claude provider 後，按 Paseo 的「啟動／繼續初始化」會恢復原本的 Claude 執行檔與模型設定。變更 gateway、模型或驗證命令後也要執行此操作，再建立新的對話；舊設定指紋會被拒絕，避免沿用錯誤路由。此整合僅支援既有 `auth_command` 型 gateway 與 HTTPS（本機 loopback 可用 HTTP）；inline key、secret reference、其他 provider 類型不在此自動橋接範圍。gateway 缺少必要設定時會標示不可用，不會改用另一個帳號。

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

- `/paseo`：狀態及設定入口。
- `/paseo-open`：開啟完整 Paseo。
- `/paseo-setup`：初始化與配對入口。
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

預設狀態放在 `$PI_CODING_AGENT_DIR/pi-paseo/`，未設定時使用 `~/.pi/agent/pi-paseo/`；Paseo 自有 home 位於該狀態目錄的 `daemon/`。runtime 使用 lockfile 雜湊識別獨立版本，不覆寫正在使用的舊依賴；更新後若 daemon 尚在使用舊版本，需停止後啟動或透過既有容器服務重啟。套件與整合層放在 `~/.local/share/pi-paseo/`。provider 的 HOME 和 Pi data directory 沿用原環境。

daemon 預設只監聽 loopback 的 6769 埠，埠被占用時選擇其他可用埠。relay 配對不需要對外開啟容器埠。背景 supervisor 檢查程序 metadata，故障時恢復插件服務；這不會週期性呼叫模型。Pi Web 整合層在重啟後恢復 supervisor。

`state.json` 僅保存白名單狀態；配對資訊放在 mode 0600 的專用檔案，設定頁回應使用 `no-store`。舊版、其他使用者或未標記的 Paseo home 不接管。未知初始化建立結果停止自動重建，避免產生重複對話。

## 開發及驗收

```bash
PI_PASEO_SKIP_POSTINSTALL=1 npm ci
npm test
node --test scripts/install-host.test.mjs scripts/bootstrap.test.mjs
npm run typecheck
node scripts/check-package.mjs
node scripts/verify-package-install.mjs
node scripts/verify-host.mjs
npm audit --omit=dev
npm audit --omit=dev --prefix runtime
npm pack --ignore-scripts
```

`host/adapter.patch` 包含 Pi Web 整合原始碼及測試，`host/adapter-meta.json` 包含相容基底與 SHA-256。原始 Pi Web 的完整 checkout、依賴、建置物及本機登入資料都不放入插件發行包。

對話驗收成功以實際 assistant 回覆與新的續聊訊息判定。CLI 存在、模型清單出現或 provider idle 都不能代表可對話。若 Claude 回報 `PROVIDER_QUOTA_EXHAUSTED`，請等待帳號額度恢復或在官方登入入口改用有額度的授權帳號，再重跑驗收。

## 商業部署維護

`health` 輸出不含秘密；只有已安裝、啟用、程序屬於本插件、服務可達且三種 provider 可啟動時才回傳 exit 0。真正對話及 relay 配對另外顯示驗證時間，不能以歷史成功取代目前連線健康。

狀態查詢合併並行請求，provider 狀態探測最多快取 3 秒；每次仍重新核對程序身分。UI 操作期間暫停輪詢，過期狀態不顯示為已就緒。診斷、模型查詢不占用安裝／啟停操作序列。

安裝器使用程序群組時限與 Linux 核心鎖，建置或發布失敗回滾自身變更。更新期間請避免外部同時編輯 launcher；安裝器保留偵測到的外部改動，檔案系統不提供跨外部寫入者的原子 compare-and-swap。程序群組無法涵蓋刻意逃離 session 的程序，部署隔離依賴容器及其資源限制。

從舊的 Git 安裝來源改用不可變版本路徑時，請將原 Pi package 登記替換成新來源，維持一個有效的 Paseo 登記；不同路徑不會被 Pi 自動視為同一套件。先備份 settings，保留原本的停用狀態及初始化對話。Pi 5 此次升級已完成來源替換，舊來源與建置保留供回滾。

反向代理若會清空 `Origin` 或改寫 `Host`，必須在改寫前驗證來源；也需保留並拒絕瀏覽器的 `Sec-Fetch-Site: cross-site`。Pi 5 的入口代理已對 `/api/plugin-paseo` 加入限定正式網址的檢查。部署範例與驗收方式見 [代理來源防護](docs/proxy-origin.md)。

Pi SDK 1.0.0 的內嵌 shrinkwrap 忽略消費者 overrides；安裝階段會以固定官方 `brace-expansion` 5.0.12 替換其私有受影響依賴，並由回歸測試驗證 API 相容性。請使用發行 lockfile 和安裝流程，避免在使用中的套件目錄執行 `npm install` 或 `npm ci`。

完整驗收紀錄與已知限制見 [驗證紀錄](docs/validation.md)。

## 官方參考

實際安裝、三種 provider 對話及 relay 驗證結果見 [驗證紀錄](docs/validation.md)。

- [Paseo 連線方式](https://paseo.sh/docs/connectivity.md)
- [Paseo 自架 Web UI](https://paseo.sh/docs/web-ui.md)
- [Paseo provider 支援](https://paseo.sh/docs/supported-providers.md)
- [Pi Web](https://github.com/agegr/pi-web)

### 手機捲動修正（v0.1.5）

Paseo 設定面板與獨立初始化頁各自提供有高度限制的垂直捲動區域，長模型名稱會換行。更新插件後請重建並重新啟動 Pi Web，再重新整理瀏覽器。主機驗證包含手機直向、橫向、桌面，以及展開 60 個模型後的實際觸控／滑鼠捲動回歸測試。

### 同時升級兩個插件

已有舊版 Omnigent／Paseo 的環境，先升級 Omnigent，再安裝對應的 Paseo。固定版本組合不可交叉混用：

```sh
pi install git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.12
pi install git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.7
```

Paseo 安裝器會交給 Omnigent 建立共用介面；完成後重啟 Pi Web，再到 `/paseo/setup` 配對。收到 `RESTART_REQUIRED` 時，完成重啟後重新整理並驗證三種引擎對話。首次編譯建議預留至少 3 GiB 可用磁碟空間；實測不足 1 GiB 時套件安裝可能因 `ENOSPC` 失敗。官方 Paseo 的主機顯示名稱請在 Paseo App 內修改；插件的「容器備註」僅存於設定頁。
