# Paseo 0.17.5 隔離候選

Agent Connect `0.1.27-rc.2` 固定官方 npm CLI／server `0.17.5`，runtime revision 為 `0.17.5-r2-8664f2c3f8f5`。官方原始碼參考點是 `getpaseo/paseo` 的 `v0.17.5` commit `713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8`；npm 產物以 `runtime/package-lock.json` 的 integrity 驗證，不把原始碼 commit 當成 npm 產物的位元證明。

保留產品管理的 Better Paseo 1.7.0：Tasks 預設開啟、聊天增強關閉、自行更新關閉，沿用修正後的元件匯出、繁中與 MIT 授權。Devices 新增 Tailscale RPC；History、配對及既有 Tasks 是否能在特定 Web 正常操作，仍由該 Web 的實機驗收決定。

這個候選提供獨立 Linux 實例，不註冊到 Pi Web、不替換既有 Agent Connect／Omnigent，不複製既有登入或配對。候選的 provider 指令停用，適合 Devices／Tasks UI 與協定驗收；真正 AI 回覆、真實 Tailscale 網路、Windows、macOS、HA 與 PaaS 發布不在這個安裝方式的驗收範圍。

## 安裝及操作

先核對交付的 `SHA256SUMS`，將 `woowtech-pi-paseo-0.1.27-rc.2.tgz` 解壓到新的空白目錄。使用 Node 22.19 以上、npm、git、procps 與 util-linux flock；建議保留至少 3 GB 可用空間。解壓後的 `package/scripts/candidate.mjs` 直接可用，無須執行 npm install 或套件 postinstall。

以下路徑是示例；資料目錄必須是新的空白絕對路徑。既有主機仍在驗收時，等待該線交接後才在該主機操作。

```sh
sha256sum --check SHA256SUMS
mkdir candidate-package
tar -xzf woowtech-pi-paseo-0.1.27-rc.2.tgz -C candidate-package
node candidate-package/package/scripts/candidate.mjs prepare /tmp/agent-connect-0175-trial
node candidate-package/package/scripts/candidate.mjs target /tmp/agent-connect-0175-trial paseo
node candidate-package/package/scripts/candidate.mjs start /tmp/agent-connect-0175-trial
node candidate-package/package/scripts/candidate.mjs status /tmp/agent-connect-0175-trial
```

`prepare` 下載鎖定的 runtime 並驗證修補，不啟動服務。`start` 建立候選自己的身分與 loopback 連接埠，並使用所選品牌的 relay。取得配對連結時，只在私有終端機執行：

```sh
node candidate-package/package/scripts/candidate.mjs pair /tmp/agent-connect-0175-trial --reveal
```

不要把輸出貼進公開報告。切換品牌必須先停候選；執行中呼叫 `target` 會被拒絕，不會暗中重啟：

```sh
node candidate-package/package/scripts/candidate.mjs stop /tmp/agent-connect-0175-trial
node candidate-package/package/scripts/candidate.mjs target /tmp/agent-connect-0175-trial woowtech
node candidate-package/package/scripts/candidate.mjs start /tmp/agent-connect-0175-trial
```

第三個品牌使用 `apporo`。每次換品牌重新取得該品牌的配對連結。結束時執行 `stop`，並確認 `status` 的 `daemon.running=false`。保留資料目錄即可保留本輪證據；既有正式實例的設定與資料不需還原。

## 升降版與監聽地址

候選能驗證並控制先前的 `0.17.5-r1-8664f2c3f8f5` 與 `0.17.4-r2-a651f42711da`：升級時舊 daemon 繼續服務並顯示 `RESTART_REQUIRED`，明確停止再啟動才換版。舊版本、配對身分、工作區與 Tasks 資料保留。這是隔離升級試驗的能力，不代表可以直接替換已安裝 Pi Web 的套件；正式更新仍須符合 Omnigent／映像版本鎖定。

0.17.5 的 Devices Tailscale 開關會把額外監聽地址持久化到 `daemon.listen`，Agent Connect 現在會在重啟後保留那些地址。回到 0.17.4 前，應先在 0.17.5 關閉新增的監聽，核對設定恢復單一地址；若新 daemon 無法啟動，停用後還原該實例先前備份的設定。0.17.4 不支援多地址格式。不得以清空 `PASEO_HOME` 處理回復。

容器看不到 Tailscale 介面、使用 Unix socket、或受到啟動參數限制時，Devices 可能顯示不可用或鎖定。新版 RPC 存在不代表主機已安裝 Tailscale，也不代表已開放容器連接埠。

## 驗證指令

```sh
npm test
npm run typecheck
node scripts/verify-smart-tasks.mjs
node scripts/verify-devices.mjs /absolute/path/to/prepared-runtime
PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs upgrade
PI_PASEO_CANDIDATE_SMOKE=1 node scripts/verify-candidate.mjs
```

`verify-upgrade` 使用 0.1.26 的 git 歷史建立真正的 0.17.4-r2 daemon，驗證升級、資料與配對保留，再回復 0.17.4。`verify-candidate` 從 npm 打包檔直接解壓啟動三個品牌，驗證隔離、資料保留、配對來源與生命週期。兩者都建立自己的暫存資料，沒有讀取正式登入或送出 AI prompt。Devices 的 loopback 注入測試與真實 Tailscale 網路驗收必須分開記錄。

### rc.2：內建設定連續儲存

Better Paseo 固定 Smart commit `a61efefca8dd16e2bbe1df60d5e27c8adcf16b34` 的精確建置，修正成功儲存卻未改 revision 時，後續偏好設定停在佇列的問題。npm CLI/server 仍為 0.17.5；新 payload 使用獨立 `0.17.5-r2-8664f2c3f8f5`。既有 r1 的完整鎖定雜湊及修補描述保持凍結，供舊 daemon 的停止控制與回復使用；不覆寫正在執行的 r1 目錄。Web 9a 預覽本身不含此主機外掛修正。

rc.2 的同版本升降版驗證使用 `PI_PASEO_UPGRADE_OLD_REF=e4c568ce3214592574f11243acf5ed7db743d47e PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs upgrade`，從 rc.1 升至 r2，再回復 r1，核對身分、配對、工作區、Tasks 與設定。
