# Pi4 修正版 Paseo Web 部署驗收（2026-10-26）

**Pi4 已部署並通過正常 HTTPS 入口驗收。** 從 Pi Web 的 Paseo 分頁產生配對連結後，會開啟同一網域的 `/paseo-web`。Claude 回覆尚未結束時重新整理，恢復後維持正確兩則回覆，長文完整，與後端文字及訊息 ID 完全一致。這次使用實際發布的靜態網頁，沒有攔截、注入或替換瀏覽器 JavaScript。

最後確認時間：2026-10-26 08:22 UTC。完整數據見[非機密驗收回條](evidence/pi4-managed-web-2026-10-26.json)。

## 使用入口與版本

[Pi4 Paseo 設定頁](https://paas-cs-504a2b17-a7055f2f.woowtech.io/paseo/setup) →「產生配對連結」→「使用配對連結開啟 Paseo」。新網域的瀏覽器須配對一次；既有 Claude 官方訂閱、Codex 與 Pi 模型授權沿用，不需要重新登入供應商。

| 元件 | 部署版本／來源 |
| --- | --- |
| Paseo 插件 | [v0.1.9](https://github.com/WOOWTECH/pi-paseo-plugin/releases/tag/v0.1.9)，`eed990f` |
| Omnigent 共用介面協調器 | [v0.3.15](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.15)，`95a4083` |
| 修正版 Paseo Web | [0.13.0-woow.1](https://github.com/WOOWTECH/paseo/releases/tag/pi-web-0.13.0-woow.1)，來源 `68388f1` |
| 串流合併修補 | `043aa82`，根因見[前次報告](pi4-stream-reload-2026-10-26.md) |
| 管理的 daemon | 0.11.2，沿用既有資料與登入 |

靜態包下載約 10.6 MB，固定 SHA-256 為 `7e7495f70f721e96e121f76bd91573150cf91aa112143d9f4d51a3fcf9dc8bce`。插件核對雜湊、來源 commit、修補 commit 與基底路徑後才啟用。HTML 不保留快取；帶內容雜湊的靜態資源可長期快取，並提供 gzip。

## 真實瀏覽器與後端驗收

三個引擎都從正式設定頁的配對按鈕進入，實際選模型及可用模式，再完成首輪、續聊和重新整理。沒有模擬模型回覆。

| 引擎 | 模型 | 重新整理時機 | 結果 |
| --- | --- | --- | --- |
| Claude Code | Opus 5.5／Always ask | 直接確認回合 `phase=open` 後刷新 | 兩則回覆；長文 4,723 字元、100 行及 `STREAM_DONE` 完整；文字與 ID 均與後端一致 |
| Codex | GPT-6.1-Sol／Default permissions | 兩輪完成後刷新 | 兩則回覆，文字與 ID 均與後端一致 |
| Pi | `openai-codex/gpt-6.1-sol` | 兩輪完成後刷新 | 兩則回覆，文字與 ID 均與後端一致 |

三者重連後輸入框可繼續使用，沒有 JavaScript 錯誤。三個專用測試 agent 均已歸檔；最後沒有未歸檔 agent。公開回條不含配對片段、帳密、token 或原始對話內容。

正式網址另通過：未登入存取設定頁、Paseo HTML 與 JavaScript 均回 401；登入後可讀取正確版本；深層網址重新整理回傳 SPA HTML；設定分頁順序維持 MCP → Omnigent → Paseo；390 px 模擬手機頁面沒有水平溢出。共用介面的手機、窄手機、橫向、桌面及設定頁捲動回歸，另外使用實際建置與模擬長模型清單通過。

## 發布檢查

- [Paseo 插件 CI](https://github.com/WOOWTECH/pi-paseo-plugin/actions/runs/40288116924)：插件、安裝流程、套件驗證、型別檢查、Pi Web 正式建置與瀏覽器捲動檢查通過。
- [Omnigent v0.3.15 CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40289491944)：六個工作全數通過，包含兩個 Node 版本、Python／插件測試、原生介面及 Paseo 0.1.7／0.1.8／0.1.9 的共用介面建置與手機／桌面檢查。此版保留同期 v0.3.14 的終端診斷修補。
- [靜態客戶端 CI](https://github.com/WOOWTECH/paseo/actions/runs/40284174819)：完整依賴建置、聚焦串流回歸測試、型別檢查及 `/paseo-web` 資源路徑驗證通過。

## 部署途中處理的問題

Pi4 本機編譯 Pi Web 曾觸發 OOMKilled。改由外部已驗證的建置成品部署，傳輸後比對 64,113 個檔案／連結及內容，總雜湊一致；安裝器另逐檔核對來源與共用補丁，沒有繞過驗證。正式容器不再執行這次編譯。低記憶體環境應在建置環境完成驗證後，使用安裝器支援的 `--prebuilt-root` 流程。

異常重啟後，舊 daemon PID 紀錄指向已被重用的 PID，安全檢查回報 `DAEMON_NOT_OWNED`。確認 home 所有權、紀錄身分、沒有存活 Paseo supervisor 後，在 runtime 鎖內將這筆紀錄移至私人備份，再正常初始化；沒有對無關 PID 發送訊號。後續受控切換先正常停止 daemon，再重啟並啟用。**本次沒有放寬 PID 所有權檢查，也沒有新增異常崩潰後的自動清理機制。**

最後 Pi4 一個 Pod、兩個容器均就緒，新的 Pod 重啟次數為 0；daemon 可連線、三引擎 ready、官方 Claude 訂閱仍有效、初始化狀態保留。可用磁碟約 10.0 GiB，失敗編譯的暫存目錄已移除，保留前一版介面供回退。

## 驗收範圍

本次完成 Pi4 修正版入口與上述文字對話情境。上游 [PR #7908](https://github.com/getpaseo/paseo/pull/7908) 仍未合併，官方 `app.paseo.sh` 沒有由本次部署更新。Codex／Pi 未測試串流中刷新；實體手機、語音、長時間負載、異常崩潰自動恢復及 HA Store／local-build 同步未在本輪驗收，不能據此宣稱整體商業上線條件全部完成。
