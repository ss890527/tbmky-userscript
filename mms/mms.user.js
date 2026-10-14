// ==UserScript==
// @name         MMS工作日誌小助手
// @namespace    moonbase.mms.worklog
// @version      0.1.0
// @description  整理 LINE 工項、記住填寫人員、核對日期並準備工作日誌；最後存檔由使用者操作。
// @match        https://*/
// @match        http://*/
// @match        https://*/M300*
// @match        http://*/M300*
// @match        https://*/MMS310*
// @match        http://*/MMS310*
// @updateURL    https://raw.githubusercontent.com/ss890527/tbmky-userscript/main/mms/mms.meta.js
// @downloadURL  https://raw.githubusercontent.com/ss890527/tbmky-userscript/main/mms/mms.user.js
// @grant        none
// @sandbox      raw
// @noframes
// @run-at       document-idle
// ==/UserScript==
// 正式發布時由準備發布.cjs 加入固定 @updateURL / @downloadURL。

(() => {
  'use strict';
  const VERSION = '0.1.0';
  const TBM = 'TBM-KY工具箱會議';
  const SETTINGS_KEY = 'moonbase.mms.worklog.settings.v1';
  const OFFICE_KEY = 'moonbase.mms.worklog.office.v1';
  const OFFICE_DEFAULTS = ['文書處理', '資安文書處理', '請假'];
  const DRAFT_KEY = 'moonbase.mms.worklog.draft.v1';
  const MAX_AGE = 10 * 60 * 1000;
  const invariant = (ok, message) => { if (!ok) throw new Error(message); };
  const clean = value => String(value ?? '').trim();

  function dateKey(value) {
    let text = clean(value), year, month, day;
    let match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    if (!match) match = /^(\d{3,4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
    invariant(match, '日期格式請使用 YYYY-MM-DD。');
    [, year, month, day] = match.map(Number);
    if (year < 1911) year += 1911;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    invariant(parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day, '工作日期不存在。');
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function today(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
  }

  function stripChat(line) {
    const text = line.trim().replace(/\\$/, '').trim();
    const chat = /^\d{1,2}:\d{2}\s+\S+\s+(.*)$/.exec(text);
    return chat ? chat[1] : text;
  }

  function parseLine(raw) {
    invariant(typeof raw === 'string' && raw.trim(), '請先貼上 LINE 工作訊息。');
    const jobs = [];
    let current = null;
    const flush = () => {
      if (!current) return;
      invariant(current.unit && current.started && current.lines.some(x => x.trim()), '某份請修缺少機組別或請修內容，請補齊。');
      jobs.push(`機組別：${current.unit}\n請修內容：${current.lines.join('\n').trim()}`);
      current = null;
    };
    for (const original of raw.replace(/\r\n?/g, '\n').split('\n')) {
      const line = stripChat(original);
      if (/^請修日期\s*[:：]/.test(line)) { flush(); continue; }
      const unit = /^機組別\s*[:：]\s*(.*)$/.exec(line);
      if (unit) { flush(); current = { unit: unit[1].trim(), started: false, lines: [] }; continue; }
      const body = /^請修內容\s*[:：]\s*(.*)$/.exec(line);
      if (body) {
        invariant(current && !current.started, '請修內容缺少對應機組別，請核對原文。');
        current.started = true;
        if (body[1]) current.lines.push(body[1]);
        continue;
      }
      if (!line || /^\d+\s*[.．、]$/.test(line)) continue;
      if (/今日值班|^\S*值\s+[A-Z]班|^共用設備\s*[:：]/.test(line)) continue;
      if (current?.started) current.lines.push(line);
    }
    flush();
    invariant(jobs.length, '未找到「機組別＋請修內容」，請核對貼上的訊息。');
    return jobs;
  }

  function canonical(value) {
    try {
      const parsed = parseLine(String(value));
      if (parsed.length === 1) return parsed[0].replace(/\s/g, '');
    } catch { /* 舊日誌可能是非請修文字。 */ }
    return clean(value).replace(/\s/g, '');
  }

  function isTbm(value) {
    return /^(?:TBM(?:-?KY)?(?:工具箱)?會議|TBM-KY工具箱會議)$/i.test(clean(value).replace(/\s/g, ''));
  }

  function distribute(total, count) {
    invariant(Number.isInteger(total) && total > 0 && Number.isInteger(count) && count > 0, '目標時數及工項數量須為正整數。');
    invariant(total >= count, '工項數超過可分配整點時數，請自行調整各項時數。');
    const base = Math.floor(total / count), extra = total % count;
    return Array.from({ length: count }, (_, index) => base + (index >= count - extra ? 1 : 0));
  }

  function makePlan(existing, requested, total = 8, explicitHours = null) {
    invariant(Number.isInteger(total) && total >= 2 && total <= 24, '全日目標時數須為 2～24 的整數。');
    invariant(Array.isArray(existing) && Array.isArray(requested), '工項資料格式錯誤。');
    const rows = existing.map(row => ({ ...row, context: clean(row.context), hour: Number(row.hour), seq: Number(row.seq) }));
    const usedSeq = new Set();
    for (const row of rows) {
      invariant(row.context && Number.isInteger(row.seq) && row.seq > 0 && row.seq <= 999 && !usedSeq.has(row.seq), '既有工項內容／序號有缺漏或重複，請先核對。');
      invariant(Number.isFinite(row.hour) && row.hour > 0, `既有第 ${row.seq} 項時數不大於 0，請先處理示範或未完成項目。`);
      usedSeq.add(row.seq);
    }
    if (rows.length) {
      invariant(isTbm(rows[0].context) && rows[0].seq === 1 && rows[0].hour === 1, '既有第 1 項需為 TBM 會議、1 小時；請先核對。');
      invariant(rows.filter(row => isTbm(row.context)).length === 1, '既有 TBM 項目重複，請先核對。');
    }
    const seen = new Set(rows.map(row => canonical(row.context)));
    const added = [], skipped = [];
    requested.forEach((context, index) => {
      const text = clean(context), key = canonical(text);
      invariant(text && !isTbm(text), '請只提供一般工項，TBM 會議由助手處理。');
      if (seen.has(key)) skipped.push(index + 1);
      else { seen.add(key); added.push({ context: text, source: index }); }
    });
    const changes = [];
    const oldSum = rows.reduce((sum, row) => sum + row.hour, 0);
    invariant(oldSum <= total, '既有工項時數已超過目標，請先核對。');
    const hours = explicitHours ? requested.map((_, i) => Number(explicitHours[i])) : null;
    if (hours) invariant(hours.length === requested.length && hours.every(h => Number.isFinite(h) && h > 0), '指定工項時數需全部填入正數。');
    if (!rows.length) {
      rows.push({ context: TBM, seq: 1, hour: 1, progress: 100, added: true });
      const chosen = hours ? added.map(row => hours[row.source]) : distribute(total - 1, added.length);
      invariant(Math.abs(chosen.reduce((a, b) => a + b, 0) - (total - 1)) < 1e-9, '一般工項時數合計需等於全日目標減 1。');
      added.forEach((row, i) => rows.push({ ...row, seq: i + 2, hour: chosen[i], progress: 100, added: true }));
    } else if (added.length) {
      const remaining = total - oldSum;
      const chosen = hours ? added.map(row => hours[row.source]) : remaining >= added.length ? distribute(remaining, added.length) : added.map(() => 1);
      let deficit = oldSum + chosen.reduce((a, b) => a + b, 0) - total;
      for (let i = rows.length - 1; i > 0 && deficit > 0; i--) {
        if (rows[i].hour === 2 && deficit >= 1) {
          changes.push({ seq: rows[i].seq, before: 2, after: 1 });
          rows[i].hour = 1;
          deficit -= 1;
        }
      }
      invariant(Math.abs(deficit) < 1e-9, deficit > 0 ? '下方沒有足夠的 2 小時工項可分配給補項，請調整預覽時數。' : '補項後未滿全日目標，請在預覽指定本次時數。');
      let seq = Math.max(...rows.map(row => row.seq));
      added.forEach((row, i) => rows.push({ ...row, seq: ++seq, hour: chosen[i], progress: 100, added: true }));
    } else {
      invariant(Math.abs(oldSum - total) < 1e-9, '沒有新工項，且既有總時數不符目標。');
    }
    invariant(rows.every(row => row.seq <= 999), '工項序號超過網站上限。');
    const requestedKeys = new Set(requested.map(canonical));
    const assignments = rows.filter(row => isTbm(row.context) || requestedKeys.has(canonical(row.context))).map(row => row.seq);
    return { rows, changes, skipped, total, assignments, validSequences: rows.map(row => row.seq), added: rows.filter(row => row.added) };
  }

  function mergeCsv(value, additions, valid) {
    const text = clean(value);
    invariant(!text || /^(\d{1,3},)*\d{1,3}$/.test(text), '既有人員工作項目格式不正確。');
    const values = text ? text.split(',').map(Number) : [];
    const merged = [...new Set([...values, ...additions])].sort((a, b) => a - b);
    invariant(merged.every(n => Number.isInteger(n) && n > 0 && valid.includes(n)), '人員指派含不存在的項目序號，請先核對。');
    return merged.join(',');
  }

  function settings(value) {
    invariant(value && value.schema === 1 && Array.isArray(value.people), '本機設定格式不符，請重新核對設定。');
    invariant(typeof value.memory === 'boolean' && Number.isInteger(value.total) && value.total >= 2 && value.total <= 24, '本機參數無效。');
    invariant(value.people.every(name => typeof name === 'string' && name.trim() && name.length <= 80) && new Set(value.people.map(clean)).size === value.people.length, '人員設定有空白或重複姓名。');
    return { schema: 1, memory: value.memory, total: value.total, people: value.people.map(clean) };
  }

  function saveSettings(storage, value) {
    const valid = settings(value), serialized = JSON.stringify(valid);
    const previous = storage.getItem(SETTINGS_KEY);
    try {
      storage.setItem(SETTINGS_KEY, serialized);
      invariant(storage.getItem(SETTINGS_KEY) === serialized, '設定寫入後核對失敗。');
    } catch (error) {
      try { if (previous === null) storage.removeItem(SETTINGS_KEY); else storage.setItem(SETTINGS_KEY, previous); } catch { /* 保留明確失敗結果。 */ }
      throw new Error(`未能記住設定：${error.message}`);
    }
    return valid;
  }

  function officeSettings(value = { schema: 1, favorites: OFFICE_DEFAULTS, last: OFFICE_DEFAULTS[0] }) {
    invariant(value?.schema === 1 && Array.isArray(value.favorites), '非現場常用項目設定格式錯誤。');
    const favorites = [...new Set([...OFFICE_DEFAULTS, ...value.favorites].map(clean))];
    invariant(favorites.every(text => text && text.length <= 200 && !/[\r\n]/.test(text)), '常用項目請填入 1～200 字的單行文字。');
    invariant(favorites.includes(value.last), '上次非現場項目不在常用清單內。');
    return { schema: 1, favorites, last: value.last };
  }
  function makeOfficePlan(existing, requested) {
    invariant(requested.length === 1 && clean(requested[0]) && !isTbm(requested[0]), '非現場模式只能填一項工作。');
    invariant(existing.length <= 1, '當日日誌已有多個工項，不能改成非現場單項日誌；請先核對。');
    const context = clean(requested[0]);
    if (existing.length) {
      const old = existing[0];
      invariant(Number(old.seq) === 1 && canonical(old.context) === canonical(context) && Number(old.hour) === 8 && Number(old.progress) === 100, '既有單項內容、時數或進度不同，請人工核對；助手不覆蓋既有工項。');
    }
    const row = existing.length ? { ...existing[0], seq: 1, hour: 8, progress: 100 } : { context, seq: 1, hour: 8, progress: 100, source: 0, added: true };
    return { rows: [row], changes: [], skipped: existing.length ? [1] : [], total: 8, assignments: [1], validSequences: [1], added: row.added ? [row] : [] };
  }
  const core = { VERSION, TBM, SETTINGS_KEY, OFFICE_KEY, OFFICE_DEFAULTS, DRAFT_KEY, MAX_AGE, invariant, clean, dateKey, today, parseLine, canonical, isTbm, distribute, makePlan, makeOfficePlan, officeSettings, mergeCsv, settings, saveSettings };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }
  if (typeof document === 'undefined') return;
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (!/^\/MMS310(?:\/|$)/i.test(path) && path !== '/M300' && !(path === '/' && document.querySelector('a[href="/M300"]'))) return;
  if (document.getElementById('moonbase-mms-assistant')) return;
  const LEASE_KEY = 'moonbase.mms.worklog.lease.v1';
  const OWNER_KEY = 'moonbase.mms.worklog.owner.v1';
  let owner, configuration = { schema: 1, memory: false, total: 8, people: [] };
  let office = officeSettings();
  let busy = false, stopped = false, preview = null, directory = [], aborter = null;
  let initError = '';
  try {
    owner = sessionStorage.getItem(OWNER_KEY) || crypto.randomUUID();
    sessionStorage.setItem(OWNER_KEY, owner);
    const raw = localStorage.getItem(SETTINGS_KEY);
    const officeRaw = localStorage.getItem(OFFICE_KEY);
    if (officeRaw) office = officeSettings(JSON.parse(officeRaw));
    if (raw) {
      const saved = settings(JSON.parse(raw));
      if (saved.memory) configuration = saved;
    }
  } catch (error) { initError = `本機設定或暫存讀取失敗：${error.message}`; }

  const host = document.createElement('div');
  host.id = 'moonbase-mms-assistant';
  document.body.appendChild(host);
  const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    :host{all:initial;position:fixed;right:12px;top:74px;z-index:2147483646;font:14px/1.5 system-ui,sans-serif;color:#183047}
    details.panel{width:min(430px,calc(100vw - 24px));max-height:calc(100vh - 90px);overflow:auto;background:white;border:1px solid #9fb6cb;border-radius:10px;box-shadow:0 5px 25px #0004}
    summary{cursor:pointer;font-weight:700;padding:10px 12px;background:#eaf3fb}.body{padding:12px}
    label{display:block;margin:9px 0}input,textarea,button,select{font:inherit;box-sizing:border-box}input[type=date],input[type=number],input[type=text],select,textarea{width:100%;padding:6px;border:1px solid #9fb6cb;border-radius:5px;background:white;color:#183047}[hidden]{display:none!important}
    textarea{min-height:120px;resize:vertical}button{padding:7px 10px;margin:3px 3px 3px 0;border:0;border-radius:5px;color:white;background:#155c9e;cursor:pointer}button:disabled{opacity:.45;cursor:default}
    #stop,#clear{background:#647483}#status{white-space:pre-wrap;padding:9px;background:#eef5fa;border-radius:5px;overflow-wrap:anywhere}#status.error{color:#b42318;border:1px solid #e9a2a0;background:#fff0ef;font-weight:700}
    .hint{font-size:12px;color:#476078}#people label{display:flex;gap:7px;align-items:center}table{border-collapse:collapse;width:100%;margin:9px 0}td,th{border-bottom:1px solid #d1dce5;padding:5px;text-align:left;vertical-align:top}td.content{white-space:pre-wrap;overflow-wrap:anywhere;max-width:290px}td input{width:64px!important}details.settings{margin:10px 0;border:1px solid #d1dce5;border-radius:5px}
  </style><details class="panel" open><summary>📝 MMS工作日誌小助手 v${VERSION}</summary><div class="body">
    <label>工作日期<input id="date" type="date"></label>
    <label>填寫類型<select id="mode"><option value="field">現場單位（LINE 工項＋TBM-KY）</option><option value="office">非現場單位（單項 8 小時）</option></select></label>
    <label id="fieldArea">貼上 LINE 工項<textarea id="raw" placeholder="直接貼整段 LINE 訊息"></textarea></label>
    <div id="officeArea" hidden><label>非現場常用項目<select id="officeItem"></select></label><label>新增常用項目<input id="officeNew" type="text" maxlength="200" placeholder="輸入常用工作名稱"></label><button id="addFavorite" type="button">加入常用項目</button><p class="hint">只填 1 項、8 小時、100%，不加 TBM-KY。自動記住上次填寫項目；請假的人員工作時間與總時數均為 0。</p></div>
    <button id="preview" type="button">整理與預覽</button><button id="fill" type="button">核對日期並填寫</button><button id="stop" type="button">停止</button>
    <details class="settings"><summary>人員與參數設定</summary><div class="body">
      <label>全日工項目標時數<input id="total" type="number" min="2" max="24" step="1"></label>
      <label><input id="memory" type="checkbox"> 記住常用人員與參數</label>
      <button id="readPeople" type="button">從網站讀取人員</button><div id="people"></div>
      <button id="save" type="button">保存設定</button><button id="clear" type="button">清除已存設定</button>
      <p class="hint">現場模式 TBM-KY 固定 1 小時，初次時數先 1 後 2。一般工作沿用人員時間；請假填 0。</p>
    </div></details><div id="plan"></div><p id="status"></p>
    <p class="hint">填寫後請核對網站表單，再親自點「存檔」。人員設定存於本機；跨頁草稿最長保留 10 分鐘。</p>
  </div></details>`;
  const $ = id => ui.getElementById(id);
  $('date').value = today();
  $('total').value = configuration.total;
  $('memory').checked = configuration.memory;
  function displayOffice(selected = office.last) {
    $('officeItem').replaceChildren(...office.favorites.map(text => { const option = document.createElement('option'); option.value = text; option.textContent = text; return option; }));
    $('officeItem').value = selected;
  }
  function rememberOffice(selected) {
    const value = officeSettings({ ...office, last: selected });
    const serialized = JSON.stringify(value);
    localStorage.setItem(OFFICE_KEY, serialized);
    invariant(localStorage.getItem(OFFICE_KEY) === serialized, '非現場項目記憶保存失敗。'); office = value;
  }
  function displayMode() { const officeMode = $('mode').value === 'office'; $('officeArea').hidden = !officeMode; $('fieldArea').hidden = officeMode; $('plan').replaceChildren(); preview = null; }
  displayOffice();
  $('mode').onchange = displayMode;
  $('officeItem').onchange = () => { preview = null; $('plan').replaceChildren(); };
  $('addFavorite').onclick = () => {
    try { const name = clean($('officeNew').value); const value = officeSettings({ schema: 1, favorites: [...office.favorites, name], last: name }); localStorage.setItem(OFFICE_KEY, JSON.stringify(value)); invariant(localStorage.getItem(OFFICE_KEY) === JSON.stringify(value), '常用項目保存失敗。'); office = value; displayOffice(name); $('officeNew').value = ''; preview = null; $('plan').replaceChildren(); status('已加入常用項目。'); } catch (error) { status(error.message, true); }
  };
  function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
  function department(doc = document) {
    const own = clean(doc.querySelector('form input#DEPT_CD')?.value);
    if (/^[\dA-Z]{4}$/.test(own)) return own;
    const label = clean(doc.querySelector('.tpl-header-navbar > ul > li:first-child > a')?.textContent);
    const found = /^[\dA-Z]{4}/.exec(label);
    invariant(found, '無法辨識目前部門，請提供頁面元件供修正。');
    return found[0];
  }
  function checkActive() {
    invariant(!stopped, '已停止；已填的頁面內容保留，請核對後再操作。');
    const lease = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
    invariant(lease?.owner === owner && lease.expires > Date.now(), '操作鎖已失效或其他分頁正在填寫，請重新核對。');
    lease.expires = Date.now() + 90000;
    localStorage.setItem(LEASE_KEY, JSON.stringify(lease));
  }
  function acquire() {
    const previous = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
    invariant(!previous || previous.expires < Date.now() || previous.owner === owner, '另一個 MMS 分頁正在填寫，請先完成該分頁。');
    localStorage.setItem(LEASE_KEY, JSON.stringify({ owner, expires: Date.now() + 90000 }));
    checkActive();
  }
  function release() {
    try { if (JSON.parse(localStorage.getItem(LEASE_KEY) || 'null')?.owner === owner) localStorage.removeItem(LEASE_KEY); } catch { /* 錯誤會在下次操作顯示。 */ }
  }
  function controls(disabled) {
    for (const element of ui.querySelectorAll('input,textarea,button,select')) if (element.id !== 'stop') element.disabled = disabled;
  }
  async function action(callback) {
    if (busy) return;
    busy = true; stopped = false; controls(true);
    try { acquire(); await callback(); }
    catch (error) { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} status(error.message, true); }
    finally { release(); busy = false; controls(false); }
  }
  async function requestDoc(url, options = {}) {
    checkActive();
    const target = new URL(url, location.origin);
    invariant(target.origin === location.origin && /^\/(?:MMS310(?:\/|$)|Home\/APIEMP\/?$)/i.test(target.pathname), '讀取目標超出工作日誌範圍。');
    const controller = new AbortController(); aborter = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(target.href, { ...options, credentials: 'same-origin', signal: controller.signal });
      invariant(response.ok && new URL(response.url).origin === location.origin && !/\/Login/i.test(new URL(response.url).pathname), '網站登入失效或讀取失敗，請先核對登入。');
      const text = await response.text(); checkActive();
      return new DOMParser().parseFromString(text, 'text/html');
    } finally { clearTimeout(timer); if (aborter === controller) aborter = null; }
  }
  function pageInfo(doc) {
    const pager = doc.querySelector('.pagination-container');
    invariant(pager, '未找到查詢分頁資訊，不能判定資料完整。');
    const match = /第\s*(\d+)\s*頁\s*\/\s*共\s*(\d+)\s*頁/.exec(pager.parentElement.textContent);
    invariant(match && Number(match[2]) <= 20, '查詢結果頁數無法確認或超過 20 頁，請先核對查詢條件。');
    return { page: Number(match[1]), total: Number(match[2]) };
  }
  function readList(doc) {
    const form = doc.querySelector('#QueryFrm[action="/MMS310"]');
    invariant(form?.querySelector('#sday') && form.querySelector('#eday'), '未找到工作日誌查詢表單。');
    const table = form.querySelector('table.table');
    const headers = [...(table?.querySelectorAll('tr:first-child th') || [])].map(th => clean(th.textContent));
    const dateIndex = headers.indexOf('工作日期'), deptIndex = headers.indexOf('部門代碼');
    invariant(dateIndex >= 0 && deptIndex >= 0, '清單缺少工作日期或部門欄。');
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const view = tr.querySelector('a[href^="/MMS310/ViewDetail/"]');
      if (!view) { invariant(!tr.querySelector('td') || tr.querySelectorAll('td').length === 1, '日誌清單有無法辨識的資料列。'); continue; }
      rows.push({ date: dateKey(clean(tr.cells[dateIndex]?.textContent)), dept: clean(tr.cells[deptIndex]?.textContent).slice(0, 4), href: view.getAttribute('href') });
    }
    return { rows, create: form.querySelector('a[href="/MMS310/Create"]')?.getAttribute('href'), ...pageInfo(doc) };
  }
  async function findWorkDate(target, dept) {
    const initial = await requestDoc('/MMS310');
    invariant(initial.querySelector('#QueryFrm #sday') && initial.querySelector('#QueryFrm #eday'), '工作日誌查詢欄位未就緒。');
    const matches = [], fingerprints = new Set();
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      status(`正在核對 ${target} 的工作日期（第 ${page} 頁）…`);
      const body = new URLSearchParams({ keyword: '', DEPT_CD: dept, sday: target, eday: target, page: String(page) });
      const result = readList(await requestDoc('/MMS310', { method: 'POST', body }));
      invariant(result.page === page, '查詢分頁未前進，停止判讀。');
      pages = result.total;
      invariant(result.rows.every(row => row.date === target && row.dept === dept), '日期或部門篩選未生效，停止以免建立重複日誌。');
      const fingerprint = result.rows.map(row => row.href).join('|');
      invariant(!fingerprints.has(fingerprint), '查詢分頁重複，停止判讀。'); fingerprints.add(fingerprint);
      matches.push(...result.rows);
      invariant(matches.length <= 1, '同日期同部門找到多筆日誌，請先選定正確紀錄。');
    }
    return matches[0]?.href || '/MMS310/Create';
  }
  function readItems(doc = document) {
    invariant(doc.querySelector('#ListRowPICS'), '未找到工作內容表格。');
    return [...doc.querySelectorAll('#ListRowPICS tr.ListRowPICS')].map(row => {
      const field = suffix => row.querySelector(`[id^="MM_JR_ITEMS_"][id$="__${suffix}"]`);
      const context = field('CONTEXT'), seq = field('ITEM_SEQ'), hour = field('ITEM_HOUR'), progress = field('ITEM_PERCENT');
      invariant(context && seq && hour && progress, '工項列缺少內容、序號、時數或進度欄位。');
      invariant(!row.querySelector('input[type="file"]')?.files?.length, '已有待上傳附件，請先完成目前人工操作。');
      return { element: row, fields: { context, seq, hour, progress }, context: context.value, seq: seq.value, hour: hour.value, progress: progress.value };
    });
  }
  function readEmployees() {
    invariant(document.querySelector('#ListRowCHARS'), '未找到工作人員相關資料。');
    return [...document.querySelectorAll('#ListRowCHARS tr.ListRowCHARS')].map(row => {
      const field = suffix => row.querySelector(`[id^="MM_JR_EMPS_"][id$="__${suffix}"]`);
      const name = field('EMP_NAME'), csv = field('ITEM_SEQ_CSV'), period = field('DUTY_PERIOD_DESC'), hours = field('MAN_HOUR_NBR');
      invariant(name && csv && period && hours, '人員列缺少姓名、工作項目或系統時間欄。');
      return { element: row, fields: { name, csv, period, hours }, name: clean(name.value), csv: csv.value };
    });
  }
  function currentItems() {
    if (!document.querySelector('#ListRowPICS')) return [];
    return readItems().filter(row => clean(row.context)).map(({ context, seq, hour, progress }) => ({ context, seq, hour, progress }));
  }
  function nativeValue(element, value) {
    checkActive(); invariant(element && !element.disabled && !element.readOnly, '目標欄位不可填寫。');
    const view = element.ownerDocument.defaultView;
    const proto = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, String(value));
    element.dispatchEvent(new view.Event('input', { bubbles: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    invariant(element.value === String(value), '欄位填入後讀回不符，已停止。');
  }
  function waitFor(predicate, message, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        try {
          checkActive(); const result = predicate();
          if (result) return resolve(result);
          if (Date.now() - started >= timeout) return reject(new Error(message));
          setTimeout(tick, 120);
        } catch (error) { reject(error); }
      }; tick();
    });
  }
  function employeeRecords(doc) {
    invariant(doc.querySelector('#QueryFrm[action="/Home/APIEMP"]'), '組員選擇頁未就緒。');
    return [...doc.querySelectorAll('#QueryFrm table.table a[onclick^="refPara("]')].map(link => ({
      name: clean(link.textContent), dept: clean(link.closest('tr').cells[1]?.textContent).slice(0, 4), title: clean(link.closest('tr').cells[2]?.textContent), link
    }));
  }
  async function loadDirectory(dept) {
    const base = await requestDoc('/Home/APIEMP/');
    invariant(base.querySelector('#QueryFrm #DEPT_CD') && base.querySelector('#TITLE_CD'), '選人查詢欄位缺漏。');
    const people = []; let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const body = new URLSearchParams({ DEPT_CD: dept, TITLE_CD: '', keyword: '', page: String(page) });
      const doc = await requestDoc('/Home/APIEMP', { method: 'POST', body });
      const pagination = pageInfo(doc); invariant(pagination.page === page, '選人分頁未前進。'); pages = pagination.total;
      const batch = employeeRecords(doc); invariant(batch.every(person => person.dept === dept), '選人部門篩選未生效。');
      people.push(...batch.map(({ name, dept: code, title }) => ({ name, dept: code, title })));
    }
    invariant(people.length && new Set(people.map(person => person.name)).size === people.length, '人員清單為空或有同名人員，請先核對。');
    return people;
  }
  function displayPeople(names = configuration.people) {
    $('people').replaceChildren();
    const values = [...new Set([...directory.map(person => person.name), ...names])];
    for (const name of values) {
      const label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox'; box.value = name; box.checked = names.includes(name);
      label.append(box, document.createTextNode(name)); $('people').appendChild(label);
    }
  }
  displayPeople();
  function selectedPeople() { return [...$('people').querySelectorAll('input:checked')].map(box => box.value); }
  function parameters() {
    const people = selectedPeople(), total = Number($('total').value);
    invariant(people.length, '請先從網站讀取並勾選填寫人員。');
    settings({ schema: 1, memory: $('memory').checked, total, people });
    return { people, total: $('mode').value === 'office' ? 8 : total, mode: $('mode').value, date: dateKey($('date').value), dept: department() };
  }
  function drawPreview(plan, requested) {
    $('plan').replaceChildren();
    const table = document.createElement('table');
    const header = document.createElement('tr');
    for (const text of ['序', '工項', '時數']) { const th = document.createElement('th'); th.textContent = text; header.appendChild(th); }
    table.appendChild(header);
    for (const row of plan.rows) {
      const tr = document.createElement('tr'), seq = document.createElement('td'), content = document.createElement('td'), hours = document.createElement('td');
      seq.textContent = row.seq; content.className = 'content'; content.textContent = row.context;
      if (row.added && row.seq !== 1) {
        const input = document.createElement('input'); input.type = 'number'; input.min = '.001'; input.step = '1'; input.value = row.hour;
        input.dataset.source = row.source; input.addEventListener('input', () => { preview.hours[row.source] = Number(input.value); preview.edited = true; }); hours.appendChild(input);
      } else hours.textContent = row.hour;
      tr.append(seq, content, hours); table.appendChild(tr);
    }
    $('plan').appendChild(table);
    const note = document.createElement('p'); note.className = 'hint';
    note.textContent = `全日 ${plan.total} 小時；新工項進度 100%。` + (!document.querySelector('#ListRowPICS') ? '核對日期後，將依既有日誌重新分配；手動改過的預覽時數優先。' : '') + (plan.changes.length ? `調整第 ${plan.changes.map(x => x.seq).join('、')} 項：2 → 1 小時。` : '') + (plan.skipped.length ? `第 ${plan.skipped.join('、')} 份輸入已存在／重複，沿用原項目。` : '');
    $('plan').appendChild(note);
    const hourMap = requested.map(() => null);
    for (const row of plan.added) if (row.source !== undefined) hourMap[row.source] = row.hour;
    requested.forEach((job, i) => { if (hourMap[i] === null) hourMap[i] = 1; });
    preview = { raw: $('raw').value, date: $('date').value, total: Number($('total').value), requested, hours: hourMap, plan, edited: false };
  }
  function persistDraft(draft, expected) {
    const saved = { ...draft, expected, created: draft.created || Date.now() };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(saved));
    invariant(sessionStorage.getItem(DRAFT_KEY) === JSON.stringify(saved), '跨頁草稿保存失敗。');
  }
  function move(draft, href) {
    checkActive(); const target = new URL(href, location.origin);
    invariant(target.origin === location.origin && /^\/MMS310(?:\/|$)/.test(target.pathname), '導頁超出工作日誌範圍。');
    persistDraft(draft, target.pathname);
    location.assign(target.href);
  }
  function sameItems(before, after) {
    return before.every((row, i) => after[i] && row.context === after[i].context && Number(row.seq) === Number(after[i].seq) && Number(row.hour) === Number(after[i].hour));
  }
  async function prepareForm(draft) {
    const workDate = document.querySelector('#WORK_DT');
    invariant(workDate && document.querySelector('#ListRowPICS') && document.querySelector('#ListRowCHARS'), '編修／新增表單尚未就緒。');
    invariant(department() === draft.dept, '目前表單部門與查詢部門不同，已停止。');
    const isCreate = /\/Create$/i.test(path);
    if (isCreate && dateKey(workDate.value) !== draft.date) {
      invariant(draft.date !== today(), '網站新增日期不是當天，請先核對。');
      nativeValue(workDate, draft.date);
    }
    invariant(dateKey(workDate.value) === draft.date, '目前表單的工作日期不符，已停止。');
    if (isCreate) {
      const destination = await findWorkDate(draft.date, draft.dept);
      invariant(destination === '/MMS310/Create', '該日期剛建立了日誌，請回列表重新操作以免重複。');
    }
    const before = currentItems();
    invariant(['field', 'office'].includes(draft.mode || 'field'), '填寫類型錯誤。');
    const officeMode = draft.mode === 'office', leave = officeMode && draft.requested[0] === '請假';
    const plan = officeMode ? makeOfficePlan(before, draft.requested) : makePlan(before, draft.requested, draft.total, draft.hours);
    invariant(before.every((row, i) => Number(row.seq) === i + 1), '網站新增會重排序號；目前序號不連續，請先核對。');
    const people = await loadDirectory(draft.dept);
    invariant(draft.people.every(name => people.some(person => person.name === name)), '設定人員已不在目前部門清單，請重新勾選。');
    const existingStaff = readEmployees();
    for (const name of draft.people) {
      const matches = existingStaff.filter(person => person.name === name);
      invariant(matches.length <= 1, '指定姓名在表單重複，請先核對。');
      if (matches.length) mergeCsv(matches[0].csv, plan.assignments, plan.validSequences);
    }
    invariant(sameItems(before, currentItems()), '表單在核對期間被修改，請重新整理預覽。');
    // 先備妥所有資料，才開始改動表單；只點已觀察到的網站新增按鈕。
    for (const change of plan.changes) {
      const row = readItems().find(item => Number(item.seq) === change.seq);
      invariant(Number(row?.hour) === change.before, '待調整工項時數已改變，已停止。');
      nativeValue(row.fields.hour, change.after);
    }
    for (const item of plan.added) {
      let rows = readItems(), blank = rows.find(row => !clean(row.context));
      if (!blank) {
        const button = rows.at(-1)?.element.querySelector('a[onclick="MMS310_AddITEMSRow(this);"]');
        invariant(button, '未找到網站新增工項按鈕。');
        const count = rows.length; checkActive(); button.click();
        await waitFor(() => readItems().length === count + 1, '新增工項後欄位未出現。');
        rows = readItems(); blank = rows.at(-1);
      }
      invariant(blank && !clean(blank.context) && (!clean(blank.seq) || Number(blank.seq) === item.seq), '新增工項序號或空白列不符，已停止。');
      nativeValue(blank.fields.seq, item.seq); nativeValue(blank.fields.context, item.context); nativeValue(blank.fields.hour, item.hour); nativeValue(blank.fields.progress, 100);
    }
    const actual = currentItems();
    invariant(actual.length === plan.rows.length && plan.rows.every((row, i) => canonical(actual[i].context) === canonical(row.context) && Number(actual[i].seq) === row.seq && Number(actual[i].hour) === row.hour), '填寫後工項核對失敗，請檢查已填內容。');
    for (const name of draft.people) {
      checkActive(); let staff = readEmployees(), target = staff.find(person => person.name === name);
      if (!target) {
        target = staff.find(person => !person.name);
        if (!target) {
          const button = staff.at(-1)?.element.querySelector('a[onclick="MMS310_AddCHARSRow(this);"]');
          invariant(button, '未找到網站新增人員按鈕。');
          const count = staff.length; button.click();
          await waitFor(() => readEmployees().length === count + 1, '新增人員後欄位未出現。');
          target = readEmployees().at(-1);
        }
        const select = [...target.element.querySelectorAll('span[onclick]')].find(el => /^winSearch\(\d+,'TITLE_DESC'\)$/.test(el.getAttribute('onclick')));
        invariant(select, '未找到姓名選擇按鈕。'); select.click();
        const frame = await waitFor(() => {
          const element = document.querySelector('iframe[src*="/Home/APIEMP/"]');
          return element?.contentDocument?.querySelector('#QueryFrm table.table') ? element : null;
        }, '組員選擇視窗未就緒。');
        const frameDoc = frame.contentDocument;
        const query = frameDoc.querySelector('#QueryFrm');
        invariant(query?.querySelector('#DEPT_CD') && query.querySelector('[name="keyword"]'), '組員選擇缺少查詢欄位。');
        nativeValue(query.querySelector('#DEPT_CD'), draft.dept);
        nativeValue(query.querySelector('#TITLE_CD'), '');
        nativeValue(query.querySelector('[name="keyword"]'), name);
        nativeValue(query.querySelector('[name="page"]'), 1);
        query.querySelector('button[type="submit"]').click();
        await waitFor(() => frame.contentDocument !== frameDoc && frame.contentDocument?.querySelector('#QueryFrm table.table'), '組員查詢未回傳。');
        const matches = employeeRecords(frame.contentDocument).filter(person => person.name === name && person.dept === draft.dept);
        invariant(pageInfo(frame.contentDocument).total === 1 && matches.length === 1, '組員查詢找不到唯一指定姓名，請在選人視窗核對。');
        checkActive(); matches[0].link.click();
        await waitFor(() => readEmployees().some(person => person.name === name), '選人後姓名未回填。');
        target = readEmployees().find(person => person.name === name);
      }
      const originalPeriod = target.fields.period.value, originalHours = target.fields.hours.value;
      nativeValue(target.fields.csv, mergeCsv(target.fields.csv.value, plan.assignments, plan.validSequences));
      if (leave) { nativeValue(target.fields.period, 0); nativeValue(target.fields.hours, 0); }
      else invariant(target.fields.period.value === originalPeriod && target.fields.hours.value === originalHours, '系統時間或人員總時數在填寫時改變，請核對。');
    }
    invariant(dateKey(workDate.value) === draft.date && Math.abs(currentItems().reduce((sum, item) => sum + Number(item.hour), 0) - draft.total) < 1e-9, '最後日期或時數總和不符，請核對。');
    for (const item of plan.added) invariant(Number(readItems().find(row => Number(row.seq) === item.seq)?.progress) === 100, '新工項進度讀回不為 100%。');
    for (const name of draft.people) {
      const person = readEmployees().find(row => row.name === name);
      invariant(person && person.fields.csv.value === mergeCsv(person.fields.csv.value, plan.assignments, plan.validSequences), '最後人員指派核對失敗。');
      if (leave) invariant(person.fields.period.value === '0' && person.fields.hours.value === '0', '請假人員時間未正確填為 0。');
    }
    if (officeMode) rememberOffice(draft.requested[0]);
    sessionStorage.removeItem(DRAFT_KEY);
    drawPreview(plan, draft.requested);
    status(`已填寫並核對 ${draft.date}，全日 ${draft.total} 小時。請親自核對網站並點「存檔」；助手尚未存檔。`);
  }
  async function proceed(draft) {
    invariant(Date.now() - draft.created <= MAX_AGE, '跨頁草稿已超過 10 分鐘，請重新整理工項。');
    invariant(draft.explicitDate || draft.date === today(), '已跨台灣午夜，請重新核對工作日期。');
    $('date').value = draft.date; $('total').value = draft.total; displayPeople(draft.people);
    $('mode').value = draft.mode || 'field'; displayMode();
    if (draft.mode === 'office') { if (!office.favorites.includes(draft.requested[0])) office.favorites.push(draft.requested[0]); displayOffice(draft.requested[0]); }
    if (/\/ViewDetail\//i.test(path)) {
      const head = document.querySelector('tr.JRHead');
      invariant(head && dateKey(clean(head.cells[2]?.textContent)) === draft.date && clean(head.cells[1]?.textContent) === draft.dept, '檢視頁日期或部門不符。');
      const links = [...document.querySelectorAll('a[href^="/MMS310/Edit/"]')];
      invariant(links.length === 1, '未找到唯一編修連結。'); move(draft, links[0].getAttribute('href')); return;
    }
    if (/\/Create$|\/Edit\//i.test(path)) { await prepareForm(draft); return; }
    const destination = await findWorkDate(draft.date, draft.dept); move(draft, destination);
  }
  $('preview').onclick = () => {
    try {
      const officeMode = $('mode').value === 'office';
      const requested = officeMode ? [$('officeItem').value] : parseLine($('raw').value), total = Number($('total').value);
      drawPreview(officeMode ? makeOfficePlan(currentItems(), requested) : makePlan(currentItems(), requested, total), requested);
      status('整理完成。可修改新增工項時數，核對後按「核對日期並填寫」。');
    } catch (error) { preview = null; status(error.message, true); }
  };
  $('fill').onclick = () => action(async () => {
    const params = parameters(), requested = params.mode === 'office' ? [$('officeItem').value] : parseLine($('raw').value);
    const usePreview = preview?.edited && preview.raw === $('raw').value && preview.date === $('date').value && preview.total === params.total;
    const hours = params.mode === 'field' && usePreview ? preview.hours : null;
    const draft = { ...params, requested, hours, explicitDate: params.date !== today(), created: Date.now() };
    await proceed(draft);
  });
  $('stop').onclick = () => { stopped = true; aborter?.abort(); sessionStorage.removeItem(DRAFT_KEY); release(); status('已停止。已填欄位保留，請核對後再操作。'); };
  $('readPeople').onclick = () => action(async () => {
    const chosen = selectedPeople(); directory = await loadDirectory(department()); displayPeople(chosen);
    status('已讀取目前部門人員，請勾選填寫對象。');
  });
  $('save').onclick = () => {
    try {
      const value = settings({ schema: 1, memory: $('memory').checked, total: Number($('total').value), people: selectedPeople() });
      invariant(directory.length && value.people.length && value.people.every(name => directory.some(person => person.name === name)), '請先從網站讀取並勾選有效人員，再保存設定。');
      configuration = saveSettings(localStorage, value); status(value.memory ? '已記住常用人員與參數，下次自動帶入。' : '記憶模式已停用；下次不載入常用設定。');
    } catch (error) { status(error.message, true); }
  };
  $('clear').onclick = () => {
    try { localStorage.removeItem(SETTINGS_KEY); invariant(localStorage.getItem(SETTINGS_KEY) === null, '清除設定失敗。'); configuration = { schema: 1, memory: false, total: 8, people: [] }; $('memory').checked = false; $('total').value = 8; displayPeople([]); status('已清除記住的人員與參數，網站資料保留。'); } catch (error) { status(error.message, true); }
  };
  console.info(`[MMS小助手 v${VERSION}] 介面已建立。`);
  status(initError || '登入後貼 LINE 訊息；第一次請到設定讀取並勾選人員。', Boolean(initError));
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw && !initError) {
      const draft = JSON.parse(raw);
      if (draft.expected === location.pathname) action(() => proceed(draft));
      else status('有未完成草稿，但目前頁面不符預期；請回原分頁或停止後重新操作。', true);
    }
  } catch (error) { status(`跨頁草稿無法讀取：${error.message}`, true); }
})();
