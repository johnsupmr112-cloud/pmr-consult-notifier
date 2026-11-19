# PMR 新會診 Telegram 通知

在院內會診系統的瀏覽器 Console 執行，每 5 分鐘查一次會診清單，有新的 PMR 會診就傳 Telegram 到手機。

- 純 JavaScript，無外部相依，適用院內網路環境
- 通知去識別化：只含科別與會診時限，不含姓名、病歷號、床號

## 事前準備（只需一次）

1. 在 Telegram 找 **@BotFather** → `/newbot` 建立 bot，取得 **Bot Token**
2. 對自己的 bot 按 **Start**、傳一句話
3. 用瀏覽器開 `https://api.telegram.org/bot<TOKEN>/getUpdates`，找到 `"chat":{"id":…}` 的數字，即 **Chat ID**

## 用法

**第一次：**

1. 打開會診**查詢頁**，照平常選好條件，**先不要按查詢**
2. `F12` → Console → 貼上 `pmr_consult_watcher.js` 全文 → Enter
3. 跳出視窗時輸入 Bot Token 與 Chat ID（只存在這台電腦的瀏覽器）
4. 手機收到「✅ PMR 會診監控啟動」即完成

**之後：** 在查詢頁或清單頁貼上都可以，會沿用記住的查詢條件。想換條件就在查詢頁重選後再貼一次。

**注意：** 分頁要一直開著、不要在該分頁跳轉，電腦不能睡眠。

## 會收到的訊息

| 訊息 | 時機 |
|---|---|
| ✅ 監控啟動 | 腳本啟動成功 |
| 🔔 PMR 新會診 N 筆 | 出現新會診（第一次執行只建立基準，不通知既有會診） |
| ⚠️ 系統已登出 | 在**另一個分頁**重新登入即自動恢復 |
| ⚠️ 連續 N 次檢查失敗 | 網路或系統異常 |
| ✅ 監控已恢復 | 從登出或失敗中恢復 |
| 🟢 運作中 | 每天早上 8 點後一次；沒收到代表監控已中斷 |

## Console 指令

| 指令 | 說明 |
|---|---|
| `PMRWatch.status()` | 目前狀態 |
| `PMRWatch.checkNow()` | 立刻檢查一次 |
| `PMRWatch.test()` | 傳測試訊息 |
| `PMRWatch.stop()` | 停止監控 |
| `PMRWatch.resetSeen()` | 清除已看過紀錄 |
| `PMRWatch.forgetToken()` | 刪除本機的 Token / Chat ID |

## 主要設定（`CONFIG`）

| 參數 | 預設 | 說明 |
|---|---|---|
| `intervalMin` | `5` | 每幾分鐘檢查一次 |
| `activeHours` | `null` | `null` = 24 小時；`[7, 22]` = 只在 07:00–21:59；`[17, 8]` = 跨夜 |
| `msgFields` | `['病人科別','會診時限']` | 通知帶的欄位，**不要放個資** |
| `heartbeatHour` | `8` | 每天幾點後發心跳；`null` = 不發 |
| `failAlertAfter` | `3` | 連續失敗幾次才警示 |

## 安全

- **Bot Token 絕對不要寫進程式碼或 commit**；腳本只把它存在本機瀏覽器的 localStorage
- 通知經由 Telegram 伺服器（境外），因此只傳去識別化資訊

## 相關專案

- [pmr-consult-scraper](https://github.com/johnsupmr112-cloud/pmr-consult-scraper)：把會診清單整理成可列印的 Excel
