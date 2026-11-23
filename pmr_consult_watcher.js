/* =========================================================================
 * PMR Consult Notifier — pmr_consult_watcher.js  v2.0.1
 *
 * Polls the hospital consultation list every 5 minutes and sends a Telegram
 * message when a new PMR (Physical Medicine & Rehabilitation) consult appears.
 * Notifications are de-identified: only the requesting department and the
 * consult deadline are sent — never patient name, chart number, or bed.
 *
 * First-time setup:
 *   1. Open the consultation *query* page and select the usual filters.
 *      Do NOT press the query button yet.
 *   2. F12 → Console → paste this entire file → Enter.
 *   3. Enter the Telegram Bot Token and Chat ID when prompted
 *      (stored only in this browser's localStorage).
 *   4. Setup is complete once the phone receives the "monitor started" message.
 *      Keep the tab open and do not let the computer sleep.
 * Subsequent runs: paste on either the query page or the list page; the saved
 * query is reused. To change the filters, re-select them on the query page and
 * paste the script again.
 *
 * Console commands:
 *   PMRWatch.status()      Show current state
 *   PMRWatch.checkNow()    Run one check immediately
 *   PMRWatch.test()        Send a test message
 *   PMRWatch.stop()        Stop monitoring
 *   PMRWatch.resetSeen()   Clear the record of already-seen consults
 *   PMRWatch.forgetToken() Remove the stored Token / Chat ID from this browser
 *
 * SECURITY: never hard-code the Bot Token in this file or commit it.
 *
 * Note: user-facing strings (Telegram messages, console output) and the table
 * header names below are intentionally in Traditional Chinese, matching the
 * hospital system's UI.
 * ========================================================================= */

(() => {
  'use strict';

  // ======================= Configuration =======================
  const CONFIG = {
    intervalMin: 5,                      // Polling interval in minutes
    jitterSec: 30,                       // Random ± offset added to each interval
    activeHours: null,                   // null = 24 h; [7, 22] = 07:00–21:59; [17, 8] = overnight window
    msgFields: ['病人科別', '會診時限'],  // Columns included in notifications. Do NOT add identifiers (name, chart no., bed).
    heartbeatHour: 8,                    // Send a daily heartbeat after this hour; null = disabled
    failAlertAfter: 3,                   // Consecutive failures before an alert is sent
    keepSeenDays: 14,                    // Retention period for seen-consult records
  };
  // =============================================================

  // localStorage keys (kept stable so saved settings survive upgrades)
  const KEY = { tg: 'PMR_WATCH_TG', seen: 'PMR_WATCH_SEEN', hb: 'PMR_WATCH_HB', query: 'PMR_WATCH_REQ' };
  // Column headers of the consult list table, as rendered by the hospital system
  const HEADERS = ['病歷號', '病人姓名', '病房床號', '會診時限', '被會科別', '被會醫師', '病人科別', '狀態'];

  /* ---------------- Utilities ---------------- */
  const log = (...a) => console.log('%c[PMR 監控]', 'color:#2a7;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[PMR 監控]', ...a);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
  const timeStr = (t = Date.now()) => {
    const d = new Date(t);
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const load = (k, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  // If the script is pasted again, stop the previous instance first
  if (window.PMRWatch) window.PMRWatch.stop(true);

  /* ---------------- Telegram ---------------- */
  let tg = load(KEY.tg, null);
  if (!tg) {
    const token = clean(prompt('貼上 Telegram Bot Token（只存在這台電腦的瀏覽器）'));
    const chat = clean(prompt('輸入 Chat ID'));
    if (!/^\d+:[\w-]{20,}$/.test(token) || !/^-?\d+$/.test(chat)) {
      return console.error('[PMR 監控] Token 或 Chat ID 格式不對，請重新貼上腳本。');
    }
    tg = { token, chat };
    save(KEY.tg, tg);
  }

  // Returns true = delivered; false = rejected by Telegram; null = sent via fallback (delivery unknown)
  const send = async (text) => {
    const url = `https://api.telegram.org/bot${tg.token}/sendMessage`;
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ chat_id: tg.chat, text }) });
      const j = await res.json();
      if (!j.ok) warn('Telegram 拒絕：', j.description);
      return j.ok;
    } catch {
      // fetch blocked (e.g. by CORS/CSP): fall back to an image request, which still reaches the API
      new Image().src = `${url}?chat_id=${tg.chat}&text=${encodeURIComponent(text)}`;
      return null;
    }
  };

  /* ---------------- Saved query ---------------- */
  // On the query page: capture the form exactly as the user has filled it in
  const captureQuery = () => {
    for (const form of document.forms) {
      // Identify the search form by its "Query" / "Search" submit button label
      const btn = [...form.querySelectorAll('input, button')].find((b) =>
        /查詢|搜尋/.test(b.value || b.textContent || '')
      );
      if (!btn) continue;
      const data = new FormData(form);
      if (btn.name) data.append(btn.name, btn.value || '');
      const url = new URL(form.getAttribute('action') || location.href, location.href);
      const isPost = (form.getAttribute('method') || '').toUpperCase() === 'POST';
      if (!isPost) data.forEach((v, k) => url.searchParams.append(k, v));
      return {
        url: url.href,
        method: isPost ? 'POST' : 'GET',
        body: isPost ? new URLSearchParams(data).toString() : null,
        capturedAt: Date.now(),
      };
    }
    return null;
  };

  // Any occurrence of the capture date in the saved query is rolled forward to today,
  // so a "today only" filter keeps working after midnight.
  // Supported formats: 20261119, 2026/11/19, 2026-11-19, 1151119, 115/11/19 (ROC calendar),
  // both raw and URL-encoded.
  const dateForms = (date) => {
    const y = date.getFullYear(), m = pad(date.getMonth() + 1), d = pad(date.getDate()), roc = y - 1911;
    const forms = [`${y}${m}${d}`, `${y}/${m}/${d}`, `${y}-${m}-${d}`, `${roc}/${m}/${d}`, `${roc}${m}${d}`];
    return [...forms.map(encodeURIComponent), ...forms];
  };
  const rollDate = (str, capturedAt) => {
    if (!str) return str;
    const from = dateForms(new Date(capturedAt));
    const to = dateForms(new Date());
    from.forEach((f, i) => (str = str.split(f).join(to[i])));
    return str;
  };

  /* ---------------- Fetching the list ---------------- */
  const fetchList = async () => {
    const q = load(KEY.query, null);
    const res = await fetch(rollDate(q.url, q.capturedAt), {
      method: q.method,
      body: q.method === 'POST' ? rollDate(q.body, q.capturedAt) : undefined,
      headers: q.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Decode with the page's own charset (legacy hospital systems may use Big5)
    const charset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || document.characterSet;
    const html = new TextDecoder(charset).decode(await res.arrayBuffer());
    return parseList(new DOMParser().parseFromString(html, 'text/html'));
  };

  // Returns { status: 'ok' | 'login' | 'notList', rows: [{ key, info }] }
  const parseList = (doc) => {
    // A row is the list header only if it exactly matches at least 3 known column names.
    // This prevents the query form's labels from being mistaken for the consult list.
    const isHeader = (cells) => cells.filter((c) => HEADERS.includes(c)).length >= 3;
    let grid = null;
    for (const table of doc.querySelectorAll('table')) {
      const g = [...table.rows].map((tr) => [...tr.cells].map((td) => clean(td.textContent)));
      if (g.some(isHeader)) grid = g;
    }
    if (!grid) {
      const body = clean(doc.body?.textContent);
      // A "no records found" message means a valid, empty list
      if (/查無|無資料/.test(body)) return { status: 'ok', rows: [] };
      // Otherwise, detect a login or session-timeout page by its keywords
      const isLogin = doc.querySelector('input[type=password]') || /登入|login|逾時|timeout/i.test(doc.title + body.slice(0, 800));
      return { status: isLogin ? 'login' : 'notList', rows: [] };
    }

    const h = grid.findIndex(isHeader);
    const col = (name) => grid[h].indexOf(name);
    const rows = [];
    const keys = new Set();
    for (const cells of grid.slice(h + 1)) {
      const get = (name) => cells[col(name)] || '';
      if (isHeader(cells)) continue;                       // Repeated header row
      if (!get('被會科別').toUpperCase().includes('PMR')) continue; // Consulted department must be PMR
      if (!/\d/.test(get('病歷號'))) continue;             // Chart numbers always contain digits
      const key = `${get('病歷號')}|${get('會診時限')}`;   // Same dedupe key as pmr-consult-scraper
      if (keys.has(key)) continue;
      keys.add(key);
      rows.push({ key, info: CONFIG.msgFields.map(get).filter(Boolean).join('｜') });
    }
    return { status: 'ok', rows };
  };

  /* ---------------- New-consult detection ---------------- */
  // Returns consults not seen before, then records every current consult as seen
  // and prunes records older than the retention period
  const findNew = (rows) => {
    const seen = load(KEY.seen, {});
    const now = Date.now();
    const fresh = rows.filter((r) => !(r.key in seen));
    rows.forEach((r) => (seen[r.key] = now));
    for (const k in seen) if (now - seen[k] > CONFIG.keepSeenDays * 864e5) delete seen[k];
    save(KEY.seen, seen);
    return fresh;
  };

  // Send one grouped message (max 10 items) and flag the tab title until it regains focus
  const notifyNew = async (fresh, total) => {
    const lines = fresh.slice(0, 10).map((r, i) => `${i + 1}. ${r.info}`);
    if (fresh.length > 10) lines.push(`…另有 ${fresh.length - 10} 筆`);
    const msg = `🔔 PMR 新會診 ${fresh.length} 筆\n${lines.join('\n')}\n（目前清單共 ${total} 筆）`;
    await send(msg);
    document.title = `🔔${fresh.length} ${originalTitle}`;
    log(msg);
  };

  /* ---------------- Main loop ---------------- */
  const S = { timer: null, busy: false, stopped: false, checks: 0, checksSinceHB: 0, fails: 0, alerted: false, lastOk: null, count: null, error: null };
  const originalTitle = document.title;
  const resetTitle = () => (document.title = originalTitle);
  window.addEventListener('focus', resetTitle);

  const isActiveHour = () => {
    if (!CONFIG.activeHours) return true;
    const [from, to] = CONFIG.activeHours;
    const h = new Date().getHours();
    return from <= to ? h >= from && h < to : h >= from || h < to; // second branch handles overnight windows
  };

  const scheduleNext = () => {
    if (S.stopped) return;
    const ms = CONFIG.intervalMin * 60e3 + (Math.random() * 2 - 1) * CONFIG.jitterSec * 1e3;
    S.timer = setTimeout(check, ms);
  };

  // At most one heartbeat per day, so a missing heartbeat signals the monitor has died
  const heartbeat = async () => {
    if (CONFIG.heartbeatHour == null || new Date().getHours() < CONFIG.heartbeatHour) return;
    if (load(KEY.hb, '') === today()) return;
    save(KEY.hb, today());
    await send(`🟢 PMR 會診監控運作中\n目前清單 ${S.count ?? '?'} 筆｜上次心跳後檢查 ${S.checksSinceHB} 次`);
    S.checksSinceHB = 0;
  };

  async function check() {
    if (S.busy || S.stopped) return;
    clearTimeout(S.timer);
    S.busy = true;
    try {
      if (!isActiveHour()) return;
      S.checks++;
      S.checksSinceHB++;
      const r = await fetchList();
      if (r.status === 'login') throw Object.assign(new Error('系統已登出'), { login: true });
      if (r.status !== 'ok') throw new Error('抓回的頁面不是會診清單');

      if (S.alerted) await send('✅ PMR 會診監控已恢復');
      Object.assign(S, { fails: 0, alerted: false, lastOk: Date.now(), count: r.rows.length, error: null });

      const fresh = findNew(r.rows);
      if (fresh.length) await notifyNew(fresh, r.rows.length);
      else log(`${timeStr()} PMR ${r.rows.length} 筆，無新會診`);
    } catch (e) {
      S.fails++;
      S.error = e.message;
      warn(`檢查失敗（連續 ${S.fails} 次）：${e.message}`);
      // Session expiry alerts immediately; other errors alert only after repeated failures.
      // Only one alert is sent per outage; a recovery message follows once checks succeed again.
      if (!S.alerted && (e.login || S.fails >= CONFIG.failAlertAfter)) {
        S.alerted = true;
        await send(
          e.login
            ? '⚠️ PMR 會診監控：系統已登出\n請在「另一個分頁」重新登入，監控會自動恢復。\n若原分頁已跳轉，請重新貼上腳本。'
            : `⚠️ PMR 會診監控連續 ${S.fails} 次檢查失敗\n原因：${e.message}`
        );
      }
    } finally {
      S.busy = false;
      await heartbeat().catch(() => {});
      scheduleNext();
    }
  }

  /* ---------------- Console API ---------------- */
  window.PMRWatch = {
    CONFIG,
    checkNow: check,
    test: () => send(`🧪 PMR 會診監控測試訊息（${timeStr()}）`),
    status() {
      console.table({
        執行中: !S.stopped,
        已檢查次數: S.checks,
        上次成功: S.lastOk ? timeStr(S.lastOk) : '—',
        目前筆數: S.count,
        連續失敗: S.fails,
        最近錯誤: S.error || '—',
      });
    },
    stop(silent) {
      S.stopped = true;
      clearTimeout(S.timer);
      window.removeEventListener('focus', resetTitle);
      if (!silent) log('監控已停止');
    },
    resetSeen: () => localStorage.removeItem(KEY.seen),
    forgetToken: () => localStorage.removeItem(KEY.tg),
  };

  /* ---------------- Startup ---------------- */
  (async () => {
    // Running on the query page (no list table present): capture or update the saved query
    const onListPage = parseList(document).status === 'ok';
    if (!onListPage) {
      const q = captureQuery();
      if (q) save(KEY.query, q);
    }
    if (!load(KEY.query, null)) {
      S.stopped = true;
      return console.error('[PMR 監控] 還沒有查詢條件。請到會診「查詢頁」選好條件（先不要按查詢），再貼上腳本。');
    }

    try {
      const r = await fetchList();
      if (r.status !== 'ok') throw new Error('用記住的條件查詢後，拿不到會診清單。請在查詢頁重新貼上腳本。');
      S.count = r.rows.length;
      S.lastOk = Date.now();

      // First run only records a baseline (no alerts for existing consults).
      // Later runs also report consults that arrived while the monitor was down.
      const firstRun = Object.keys(load(KEY.seen, {})).length === 0;
      const fresh = findNew(r.rows);
      if (!firstRun && fresh.length) await notifyNew(fresh, r.rows.length);

      const hours = CONFIG.activeHours ? `${CONFIG.activeHours[0]}:00–${CONFIG.activeHours[1]}:00` : '24 小時';
      const ok = await send(`✅ PMR 會診監控啟動\n目前清單 ${r.rows.length} 筆｜每 ${CONFIG.intervalMin} 分鐘檢查｜${hours}`);
      if (ok === false) console.error('[PMR 監控] Telegram 傳送失敗。執行 PMRWatch.forgetToken() 後重新貼上腳本。');
      // The startup message counts as today's heartbeat
      if (CONFIG.heartbeatHour != null && new Date().getHours() >= CONFIG.heartbeatHour) save(KEY.hb, today());

      log(`啟動完成：PMR ${r.rows.length} 筆，每 ${CONFIG.intervalMin} 分鐘檢查。這個分頁請保持開啟。`);
      scheduleNext();
    } catch (e) {
      S.stopped = true;
      console.error('[PMR 監控]', e.message);
    }
  })();
})();
