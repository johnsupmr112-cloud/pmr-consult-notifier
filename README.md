# PMR Consult Notifier

A browser-console script that polls the hospital consultation system every 5 minutes and sends a Telegram message when a new PMR (Physical Medicine & Rehabilitation) consult appears.

- Plain JavaScript with no external dependencies — runs inside restricted hospital intranets
- De-identified notifications: only the requesting department and consult deadline are sent; never patient name, chart number, or bed

> The target hospital system's UI is in Traditional Chinese, so table header names, Telegram messages, and console output are intentionally in Chinese. Code comments and documentation are in English.

## Prerequisites (one-time)

1. In Telegram, message **@BotFather** → `/newbot` to create a bot and obtain a **Bot Token**.
2. Open your bot, press **Start**, and send it any message.
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and find the number in `"chat":{"id":…}` — this is your **Chat ID**.

## Usage

**First run**

1. Open the consultation **query page** and select your usual filters. **Do not press the query button.**
2. Press `F12` → Console → paste the full contents of `pmr_consult_watcher.js` → Enter.
3. Enter the Bot Token and Chat ID when prompted. They are stored only in this browser's `localStorage`.
4. Setup is complete when your phone receives the "✅ PMR 會診監控啟動" (monitor started) message.

**Subsequent runs** — paste the script on either the query page or the list page; the saved query is reused. To change filters, re-select them on the query page and paste again.

**Requirements while running** — keep the tab open, do not navigate away in that tab, and prevent the computer from sleeping.

## Notifications

| Message | Meaning |
|---|---|
| ✅ 監控啟動 | Monitor started successfully |
| 🔔 PMR 新會診 N 筆 | N new consults. The first run records a baseline and does not alert on existing consults. |
| ⚠️ 系統已登出 | Session expired. Log in again **in another tab**; monitoring resumes automatically. |
| ⚠️ 連續 N 次檢查失敗 | N consecutive check failures (network or system issue) |
| ✅ 監控已恢復 | Recovered from a session expiry or failure |
| 🟢 運作中 | Daily heartbeat after 08:00. If it does not arrive, the monitor has stopped. |

## Console API

| Command | Description |
|---|---|
| `PMRWatch.status()` | Show current state |
| `PMRWatch.checkNow()` | Run one check immediately |
| `PMRWatch.test()` | Send a test message |
| `PMRWatch.stop()` | Stop monitoring |
| `PMRWatch.resetSeen()` | Clear the record of already-seen consults |
| `PMRWatch.forgetToken()` | Remove the stored Token / Chat ID from this browser |

## Configuration (`CONFIG`)

| Option | Default | Description |
|---|---|---|
| `intervalMin` | `5` | Polling interval in minutes |
| `jitterSec` | `30` | Random ± offset added to each interval |
| `activeHours` | `null` | `null` = 24 h; `[7, 22]` = 07:00–21:59 only; `[17, 8]` = overnight window |
| `msgFields` | `['病人科別','會診時限']` | Columns included in notifications. **Do not add identifiers.** |
| `heartbeatHour` | `8` | Send a daily heartbeat after this hour; `null` disables it |
| `failAlertAfter` | `3` | Consecutive failures before an alert is sent |
| `keepSeenDays` | `14` | Retention period for seen-consult records |

## How it works

1. **Query capture** — on the query page, the filled-in search form is serialized (URL, method, body) and saved to `localStorage`. Any occurrence of the capture date is rolled forward to the current date on each request.
2. **Polling** — the saved request is replayed with the user's session cookies; the response is decoded with the page's charset and parsed.
3. **Parsing** — the list table is identified by a header row matching at least three known column names. Rows are filtered to the PMR department and de-duplicated by chart number + consult deadline.
4. **Diffing** — consults not previously seen trigger one grouped Telegram message.

## Security

- **Never hard-code or commit the Bot Token.** The script stores it only in the local browser's `localStorage`.
- Telegram servers are outside the hospital network, so only de-identified information is transmitted.

## Related projects

- [pmr-consult-scraper](https://github.com/johnsupmr112-cloud/pmr-consult-scraper) — exports the consultation list to a print-ready Excel file
