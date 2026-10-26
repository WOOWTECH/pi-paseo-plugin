# Pi4 Claude 官方訂閱切換與三引擎驗證（2026-10-26）

Pi4 已依使用者選擇改用 Claude 官方訂閱。官方登入成功後，Claude Code、Codex、Pi 全部通過 SDK 兩輪對話；受控重啟 Pi4 後，三者也在官方 `app.paseo.sh` 通過選模型、兩輪對話及回覆完成後的重新整理驗證。最後狀態確認時間為 **2026-10-26 04:48 UTC**。下列結果取代先前 Pi4 Claude gateway HTTP 402 的阻塞狀態。

部署仍是公開 `v0.1.8`，commit `3d330e31623bc61e81e7b487cb87d78f2b94d5b6`。本次變更登入與來源設定，沒有變更產品程式或發行新版本。[非機密驗證回條](evidence/pi4-official-subscription-2026-10-26.json) 包含各項時間與範圍。

## 實際變更

在 Pi Web 使用的 HOME 完成 `claude auth login --claudeai`。Claude CLI 確認 `loggedIn=true`、`authMethod=claude.ai`、`apiProvider=firstParty`，登入檔權限為 0600。接著把 Omnigent 的 Anthropic 預設來源選為 Claude 訂閱，重新啟動 Paseo 初始化流程，恢復原生 Claude 執行檔與官方模型清單，移除 gateway 執行環境標記。

只登入 Claude CLI 不會覆蓋已選用的 Omnigent gateway，因此來源切換與重新載入都是必要步驟。原 gateway 設定保留，OpenAI 與 Pi 的預設來源保留；變更前已建立私人復原備份。Pi 對話實測明確選取既有原生 OAuth 模型，並未宣稱原先 gateway 的帳務或額度已恢復。授權碼、登入憑證、帳號識別與配對連結均不放入公開 repo。

## 對話及網頁實測

SDK 在 04:35 UTC 完成三種 provider 的兩輪驗證。Pi4 重啟後，隔離瀏覽器於 04:46–04:47 UTC 逐一在官方 Paseo 網頁選取下列模型和模式；首輪與同一 Agent 的續聊均通過。

| Provider | 實測模型 | 選取模式 | 首輪／續聊 | 完成回覆後重新整理 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-opus-5-5`（Opus 5.5） | Always ask | 4.478 秒／2.909 秒 | 保留兩則回覆，輸入框可用 |
| Codex | `gpt-6.1-sol` | Default permissions | 5.530 秒／2.499 秒 | 保留兩則回覆，輸入框可用 |
| Pi | `openai-codex/gpt-6.1-sol` | 無模式選項 | 9.639 秒／2.414 秒 | 保留兩則回覆，輸入框可用 |

三次網頁驗證均沒有 JavaScript 錯誤；測試 Agent 已歸檔。最後 Pi Web 狀態 API 回傳 200、`private, no-store`，daemon 健康、初始化完成，三個 provider 的 `chatVerified` 均為 true、錯誤碼皆空，`relayVerified=true`。這些欄位記錄已完成的測試，不能保證上游日後不受額度限制；使用者自己的瀏覽器仍須配對。

## 重啟與持久化

確認沒有進行中的對話後才重啟 Pi4。重啟前的基準建立於本次登入與來源切換之後，八個登入、模型、初始化與配對等關鍵檔案的校驗值在此次重啟前後一致；這不表示登入前後的憑證未變更。官方登入、原生 Claude 執行路徑及三引擎對話均在重啟後確認可用。

PVC、Longhorn engine 與 Helm 申請容量一致為 32 GiB，兩個副本均為 RW、儲存狀態 healthy，沒有待處理擴容或節點固定設定。檔案系統約有 11.4 GiB 可用，寫入、fsync 與讀回通過；一個 Pod 的兩個容器就緒，重啟計數皆為 0。本機語音設定已啟用，所需模型存在，持久化 bzip2 壓縮與解壓通過。本輪沒有實測麥克風或語音輸出，也沒有重跑跨節點搬移；較早搬移證據見[儲存復原紀錄](pi4-storage-recovery-2026-10-25.md)。

## 尚未解決的網頁邊界情況

早期測試只等待回覆文字出現，隨即在 Claude 回合尚未完成時重新整理，曾看到三個回覆區塊；後端對話紀錄實際只有兩則 assistant 回覆，另開隔離瀏覽器重新進入同一對話也只顯示兩則。這顯示串流／重新連線期間存在前端顯示問題，根因尚未確認，本次未修改官方 Paseo 網頁程式。

測試腳本已改為每輪等待「Worked for」完成提示，重新整理後等待連線恢復且輸入框可用，再檢查恰好兩則回覆。三個 provider 都通過這個範圍；不能將它表述成串流中重新整理問題已修復。遇到重複顯示時，另開頁面重新進入對話是此次觀察到的恢復方式。

本次完成 Pi4 指定模型的文字對話與重啟驗收。長時間負載、實體手機、故障自動切換、災難復原及 HA／PaaS 全部署鏈未在本輪驗證，因此仍不宣稱已滿足整體商業上線條件。
