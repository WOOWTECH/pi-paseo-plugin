# Paseo 0.17.5 隔離候選

Agent Connect `0.1.27-rc.4` 固定官方 npm CLI／server `0.17.5`，runtime revision 為 `0.17.5-r4-8664f2c3f8f5`。官方原始碼參考點是 `getpaseo/paseo` 的 `v0.17.5` commit `713b6dbbfe3ea5d395da569dca08fd31b2f8a0f8`；npm 產物以 `runtime/package-lock.json` 的 integrity 驗證，不把原始碼 commit 當成 npm 產物的位元證明。

保留產品管理的 Better Paseo 1.7.0：Tasks 預設開啟、聊天增強關閉、自行更新關閉，沿用修正後的元件匯出、繁中與 MIT 授權。Devices 新增 Tailscale RPC；History、配對及既有 Tasks 是否能在特定 Web 正常操作，仍由該 Web 的實機驗收決定。

這個候選提供獨立 Linux 實例，不註冊到 Pi Web、不替換既有 Agent Connect／Omnigent，不複製既有登入或配對。候選的 provider 指令停用，適合 Devices／Tasks UI 與協定驗收；真正 AI 回覆、真實 Tailscale 網路、Windows、macOS、HA 與 PaaS 發布不在這個安裝方式的驗收範圍。

## 安裝及操作

先核對交付的 `SHA256SUMS`，將 `woowtech-pi-paseo-0.1.27-rc.4.tgz` 解壓到新的空白目錄。使用 Node 22.19 以上、npm、git、procps 與 util-linux flock；建議保留至少 3 GB 可用空間。解壓後的 `package/scripts/candidate.mjs` 直接可用，無須執行 npm install 或套件 postinstall。

以下路徑是示例；資料目錄必須是新的空白絕對路徑。既有主機仍在驗收時，等待該線交接後才在該主機操作。

```sh
sha256sum --check SHA256SUMS
mkdir candidate-package
tar -xzf woowtech-pi-paseo-0.1.27-rc.4.tgz -C candidate-package
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

候選能驗證並控制先前的 `0.17.5-r2-8664f2c3f8f5`、`0.17.5-r1-8664f2c3f8f5` 與 `0.17.4-r2-a651f42711da`：升級時舊 daemon 繼續服務並顯示 `RESTART_REQUIRED`，明確停止再啟動才換版。舊版本、配對身分、工作區與 Tasks 資料保留。這是隔離升級試驗的能力，不代表可以直接替換已安裝 Pi Web 的套件；正式更新仍須符合 Omnigent／映像版本鎖定。

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

`verify-upgrade upgrade` 使用 rc.2 的 git 歷史建立真正的 0.17.5-r2 daemon，驗證 r2→r3 升級與 r2 回復；`verify-upgrade legacy` 保留 0.1.26／0.17.4-r2 舊版升級 smoke。兩者都驗證資料與配對保留。`verify-candidate` 從 npm 打包檔直接解壓啟動三個品牌，驗證隔離、資料保留、配對來源與生命週期。兩者都建立自己的暫存資料，沒有讀取正式登入或送出 AI prompt。Devices 的 loopback 注入測試與真實 Tailscale 網路驗收必須分開記錄。

### rc.2：內建設定連續儲存

Better Paseo 固定 Smart commit `a61efefca8dd16e2bbe1df60d5e27c8adcf16b34` 的精確建置，修正成功儲存卻未改 revision 時，後續偏好設定停在佇列的問題。npm CLI/server 仍為 0.17.5；新 payload 使用獨立 `0.17.5-r2-8664f2c3f8f5`。既有 r1 的完整鎖定雜湊及修補描述保持凍結，供舊 daemon 的停止控制與回復使用；不覆寫正在執行的 r1 目錄。Web 9a 預覽本身不含此主機外掛修正。

rc.2 的同版本升降版驗證使用 `PI_PASEO_UPGRADE_OLD_REF=e4c568ce3214592574f11243acf5ed7db743d47e PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs upgrade`，從 rc.1 升至 r2，再回復 r1，核對身分、配對、工作區、Tasks 與設定。


### rc.3：鍵盤快捷鍵

快捷鍵錄製修正需同時使用這個主機 payload 與 Smart 2b012f9 的 Web keyboard guard；只升級主機不足以修正舊 Web。Woowtech／Apporo 正式網站仍需依各自部署流程發布，預覽驗收與正式站結果分開記錄。

rc.3 的 managed runtime 使用 `0.17.5-r3-8664f2c3f8f5`；官方 Paseo npm 版本仍為 0.17.5。凍結 rc.2 的 `0.17.5-r2-8664f2c3f8f5` a61 payload（完整 11 檔 gzip fixture、provenance、registry 與 patch descriptor）供舊 daemon 控制及回復，並保留 rc.1 r1 與既有 legacy descriptors。新的 Better Paseo payload 來自 Smart commit `2b012f9f91377908c75b076c40a5917c712b66aa`，peer build 五檔 SHA 已逐一核對後納入，且無需 path normalization。`provenance.json` 凍結五檔及其餘封裝檔；新 `index.client.ts` SHA-256 為 `dc1d2c96ffca78c44946d626008af6d0a245072542b4684d3b0f0672262f6fe2`，`server/builtin.js` 為 `ecfd6599fead8aab92a06c12123230c2df76c70ae211b24e5dd0f301e8e4fa2d`，Tasks chunk ID 為 `1821b057ad824d0d`。peer 驗收：純 root unit 11/11、keyboard browser 7/7 均 exit 0。AC 驗收：`npm test` 379 pass／2 個 macOS-only skip，`typecheck`、package checks、Smart Tasks bundle check 皆通過；兩個真實升降版 smoke（rc.2 r2→r3→r2、0.1.26 r2→r3→r2）均 exit 0。早先把 browser 專用檔案放進 root Vitest config 的 combined attempt 有 11 個 unit pass，但因 `document` 不存在而 exit 1；browser 專案與 root unit 專案分開執行後各自通過。

### rc.4：Phone board 選取狀態

rc.4 是候選版，不是 stable。官方 Paseo npm CLI/server 仍為 0.17.5，runtime revision 使用 `0.17.5-r4-8664f2c3f8f5`，runtime lock SHA 與 rc.3 相同。凍結 rc.3 的完整 11 檔 Better Paseo payload 為 `better-paseo-0175-r3-2b.json.gz`，並保留 rc.2 的 a61 fixture、rc.1 r1 及既有 legacy descriptor；r3 只供舊 daemon 控制與回復。

新的五檔 payload 來自 Smart commit `a7bfd65a3f39076cf664e28687818c24952e261c`，每檔以 peer build provenance 核對後納入。client SHA-256 為 `68f27211b8fc364ae7b3e58e4b7c6026bdca989cfd2251f27e830d450ad4c922`，server builtin 為 `7baa01803bcf477181169db05e537ecdc3075b295655ba5b2eee5e9a4db98109`，Tasks chunk ID 為 `f9f9101d9d59ec1a`。Smart upstream source commit 為 `e9ac5216185988ce99574b3e2f04f178020204f1`。這次修正只在 phone board builtin；Smart Web 仍使用已驗證的 2b commit，`packages/app/src` 在 a7 相對 2b 沒有變更。peer 的 phone-board regression red/green 與五檔完整 hash 記在同層 provenance receipt。

RC4 的升降版 smoke 預設從 Agent Connect rc.3 commit `88857bd86a4bf982aef6d85122f16b7d4a03d009` 驗證 r3→r4→r3；legacy 仍固定 0.1.26 commit `23026e2`。本文件記載候選來源與驗證範圍；AC 測試及 package 結果以本次執行為準，不可把 peer build 通過當作 AC runtime 驗證。
