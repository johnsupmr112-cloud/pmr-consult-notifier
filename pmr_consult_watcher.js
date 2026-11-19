/* =========================================================================
 * PMR 新會診 Telegram 通知  pmr_consult_watcher.js  v2
 *
 * 每 5 分鐘查一次會診清單，有新的 PMR 會診就傳 Telegram 到手機。
 * 通知只含科別與會診時限，不含姓名、病歷號、床號。
 *
 * 第一次使用：
 *   1. 打開會診「查詢頁」，選好條件，【先不要按查詢】
 *   2. F12 → Console → 貼上整段 → Enter
 *   3. 輸入 Bot Token 與 Chat ID（只存在這台電腦的瀏覽器）
 *   4. 手機收到「監控啟動」即完成。分頁保持開啟、電腦不要睡眠。
 * 之後：在查詢頁或清單頁貼上都可以（會沿用記住的查詢條件）。
 * 想換查詢條件：在查詢頁重選條件後再貼一次。
 *
 * Console 指令：
 *   PMRWatch.status()      目前狀態
 *   PMRWatch.checkNow()    立刻檢查一次
 *   PMRWatch.test()        傳測試訊息
 *   PMRWatch.stop()        停止監控
 *   PMRWatch.resetSeen()   清除已看過紀錄
 *   PMRWatch.forgetToken() 刪除本機的 Token / Chat ID
 *
 * ★ Token 絕對不要寫進這個檔案或 commit 到 repo。
 * ========================================================================= */

(() => {
  'use strict';

  // ======================= 可調整參數 =======================
  const CONFIG = {
    intervalMin: 5,                      // 每幾分鐘檢查一次
    jitterSec: 30,                       // 間隔隨機加減秒數
    activeHours: null,                   // null = 24 小時；[7, 22] = 07:00–21:59；[17, 8] = 跨夜
    msgFields: ['病人科別', '會診時限'],  // 通知帶的欄位。★ 不要放姓名、病歷號、床號
    heartbeatHour: 8,                    // 每天幾點後發心跳；null = 不發
    failAlertAfter: 3,                   // 連續失敗幾次才警示
    keepSeenDays: 14,                    // 已看過紀錄保留天數
  };
  // =========================================================

  const KEY = { tg: 'PMR_WATCH_TG', seen: 'PMR_WATCH_SEEN', hb: 'PMR_WATCH_HB', query: 'PMR_WATCH_REQ' };
  const HEADERS = ['病歷號', '病人姓名', '病房床號', '會診時限', '被會科別', '被會醫師', '病人科別', '狀態'];

  /* ---------------- 小工具 ---------------- */
  const log = (...a) => console.log('%c[PMR 監控]', 'color:#2a7;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[PMR 監控]', ...a);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD
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

  // 重複執行時先停掉舊的
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

  // 回傳 true = 送達；false = 被 Telegram 拒絕；null = 用備援方式送出（無法確認）
  const send = async (text) => {
    const url = `https://api.telegram.org/bot${tg.token}/sendMessage`;
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ chat_id: tg.chat, text }) });
      const j = await res.json();
      if (!j.ok) warn('Telegram 拒絕：', j.description);
      return j.ok;
    } catch {
      // fetch 被擋時改用圖片請求送出
      new Image().src = `${url}?chat_id=${tg.chat}&text=${encodeURIComponent(text)}`;
      return null;
    }
  };

  /* ---------------- 查詢條件 ---------------- */
  // 在查詢頁：把畫面上選好的條件記下來
  const captureQuery = () => {
    for (const form of document.forms) {
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

  // 條件裡「設定當天」的日期每天自動換成今天（支援 20261119、2026/11/19、2026-11-19、1151119、115/11/19）
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

  /* ---------------- 抓清單 ---------------- */
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
    // 依網頁編碼解碼（院內系統可能是 Big5）
    const charset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || document.characterSet;
    const html = new TextDecoder(charset).decode(await res.arrayBuffer());
    return parseList(new DOMParser().parseFromString(html, 'text/html'));
  };

  // 回傳 { status: 'ok' | 'login' | 'notList', rows: [{ key, info }] }
  const parseList = (doc) => {
    // 清單表頭 = 同一列至少 3 個欄位名稱完全相符（避免把查詢表單當成清單）
    const isHeader = (cells) => cells.filter((c) => HEADERS.includes(c)).length >= 3;
    let grid = null;
    for (const table of doc.querySelectorAll('table')) {
      const g = [...table.rows].map((tr) => [...tr.cells].map((td) => clean(td.textContent)));
      if (g.some(isHeader)) grid = g;
    }
    if (!grid) {
      const body = clean(doc.body?.textContent);
      if (/查無|無資料/.test(body)) return { status: 'ok', rows: [] };
      const isLogin = doc.querySelector('input[type=password]') || /登入|login|逾時|timeout/i.test(doc.title + body.slice(0, 800));
      return { status: isLogin ? 'login' : 'notList', rows: [] };
    }

    const h = grid.findIndex(isHeader);
    const col = (name) => grid[h].indexOf(name);
    const rows = [];
    const keys = new Set();
    for (const cells of grid.slice(h + 1)) {
      const get = (name) => cells[col(name)] || '';
      if (isHeader(cells)) continue;                       // 重複的表頭列
      if (!get('被會科別').toUpperCase().includes('PMR')) continue;
      if (!/\d/.test(get('病歷號'))) continue;             // 不是資料列
      const key = `${get('病歷號')}|${get('會診時限')}`;   // 與 scraper 相同的去重鍵
      if (keys.has(key)) continue;
      keys.add(key);
      rows.push({ key, info: CONFIG.msgFields.map(get).filter(Boolean).join('｜') });
    }
    return { status: 'ok', rows };
  };

  /* ---------------- 新會診比對 ---------------- */
  // 回傳這次新出現的會診，並更新已看過紀錄
  const findNew = (rows) => {
    const seen = load(KEY.seen, {});
    const now = Date.now();
    const fresh = rows.filter((r) => !(r.key in seen));
    rows.forEach((r) => (seen[r.key] = now));
    for (const k in seen) if (now - seen[k] > CONFIG.keepSeenDays * 864e5) delete seen[k];
    save(KEY.seen, seen);
    return fresh;
  };

  const notifyNew = async (fresh, total) => {
    const lines = fresh.slice(0, 10).map((r, i) => `${i + 1}. ${r.info}`);
    if (fresh.length > 10) lines.push(`…另有 ${fresh.length - 10} 筆`);
    const msg = `🔔 PMR 新會診 ${fresh.length} 筆\n${lines.join('\n')}\n（目前清單共 ${total} 筆）`;
    await send(msg);
    document.title = `🔔${fresh.length} ${originalTitle}`;
    log(msg);
  };

  /* ---------------- 主迴圈 ---------------- */
  const S = { timer: null, busy: false, stopped: false, checks: 0, checksSinceHB: 0, fails: 0, alerted: false, lastOk: null, count: null, error: null };
  const originalTitle = document.title;
  const resetTitle = () => (document.title = originalTitle);
  window.addEventListener('focus', resetTitle);

  const isActiveHour = () => {
    if (!CONFIG.activeHours) return true;
    const [from, to] = CONFIG.activeHours;
    const h = new Date().getHours();
    return from <= to ? h >= from && h < to : h >= from || h < to;
  };

  const scheduleNext = () => {
    if (S.stopped) return;
    const ms = CONFIG.intervalMin * 60e3 + (Math.random() * 2 - 1) * CONFIG.jitterSec * 1e3;
    S.timer = setTimeout(check, ms);
  };

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
      // 登出立刻警示；其他錯誤連續失敗才警示
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

  /* ---------------- Console 指令 ---------------- */
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

  /* ---------------- 啟動 ---------------- */
  (async () => {
    // 在查詢頁執行 → 記住（或更新）畫面上的查詢條件
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

      // 第一次只建立基準不通知；之後重新執行會補通知中斷期間出現的新會診
      const firstRun = Object.keys(load(KEY.seen, {})).length === 0;
      const fresh = findNew(r.rows);
      if (!firstRun && fresh.length) await notifyNew(fresh, r.rows.length);

      const hours = CONFIG.activeHours ? `${CONFIG.activeHours[0]}:00–${CONFIG.activeHours[1]}:00` : '24 小時';
      const ok = await send(`✅ PMR 會診監控啟動\n目前清單 ${r.rows.length} 筆｜每 ${CONFIG.intervalMin} 分鐘檢查｜${hours}`);
      if (ok === false) console.error('[PMR 監控] Telegram 傳送失敗。執行 PMRWatch.forgetToken() 後重新貼上腳本。');
      if (CONFIG.heartbeatHour != null && new Date().getHours() >= CONFIG.heartbeatHour) save(KEY.hb, today()); // 啟動訊息代替今天的心跳

      log(`啟動完成：PMR ${r.rows.length} 筆，每 ${CONFIG.intervalMin} 分鐘檢查。這個分頁請保持開啟。`);
      scheduleNext();
    } catch (e) {
      S.stopped = true;
      console.error('[PMR 監控]', e.message);
    }
  })();
})();
