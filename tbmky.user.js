// ==UserScript==
// @name         TBM-KY上傳小助手
// @namespace    moonbase.tbmky
// @version      1.2.0
// @updateURL    https://raw.githubusercontent.com/ss890527/tbmky-userscript/main/tbmky.meta.js
// @downloadURL  https://raw.githubusercontent.com/ss890527/tbmky-userscript/main/tbmky.user.js
// @description  選擇勞務包、填寫表單及帶出宣導；三張 JPG 與最後送出由使用者操作。
// @match        http://*/TBMKY/*.aspx
// @match        https://*/TBMKY/*.aspx
// @grant        none
// @sandbox      raw
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const PAGE = decodeURIComponent(location.pathname).toLowerCase();
  if (!['/tbmky/default.aspx', '/tbmky/uploadform .aspx'].includes(PAGE)) return;
  console.info('[TBM-KY v1.2.0] 腳本開始執行。');
  // 設定只存目前網站的 localStorage；公開程式不包含內部網址或工作名稱。
  const JOBS_KEY = 'moonbase.tbmky.jobs.v1';
  let JOBS = [];
  let settingsError = '';
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || !saved.length || saved.some(name => typeof name !== 'string' || !name.trim()) || new Set(saved).size !== saved.length) throw new Error('本機勞務包設定無效，請重新從網站讀取並勾選。');
      JOBS = saved;
    }
  } catch (caught) { settingsError = caught.message; }
  const INITIAL_HAZARDS = [0, 1, 2, 3, 4, 5, 6, 9, 10, 13, 21];
  const HAZARD_NAMES = ['墜落、滾落', '跌倒', '被撞', '物體飛落', '物體倒塌、崩塌', '被夾、被捲', '被切、割、攛傷', '踩踏', '溺斃', '與高溫、低溫接觸', '感電', '輻射', '粉塵', '噪音', '物體破裂', '與有害物接觸', '爆炸', '火災', '化學物質洩漏', '缺氧、窒息、中毒', '振動', '不當動作'];
  const PROFILE_KEY = 'moonbase.tbmky.hazards.v1.';
  const PREFIX = 'ContentPlaceHolder1_';
  const KEY = 'moonbase.tbmky.prepare.v1';
  const TTL = 10 * 60 * 1000;
  const TIMEOUT = 95 * 1000;
  const nonce = `${Date.now()}-${Math.random()}`;
  const byId = name => document.getElementById(PREFIX + name);
  let state = null;
  let prm = null;
  let ends = 0;
  let running = false;
  let error = '';
  let blocked = false;

  const host = document.createElement('div');
  host.id = 'moonbase-tbmky-assistant';
  document.body.appendChild(host);
  const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:14px;top:14px;z-index:2147483646;font:14px/1.55 system-ui,sans-serif;color:#192638}
      details{width:min(380px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#fff;border:1px solid #bbc9d8;border-radius:10px;box-shadow:0 5px 24px #0005}
      summary{padding:10px 14px;background:#e9f2ff;cursor:pointer;font-weight:700}
      .body{padding:12px 14px}label{display:block;margin-bottom:10px;font-weight:600}
      select,input,textarea{display:block;box-sizing:border-box;width:100%;font:inherit;margin-top:4px;padding:7px;border:1px solid #94a5bb;border-radius:5px;background:#fff;color:#192638}
      textarea{min-height:74px;resize:vertical}button{font:inherit;padding:8px 10px;border:0;border-radius:5px;background:#155db1;color:white;cursor:pointer}
      button:disabled{opacity:.5;cursor:default}#stop{background:#5c6776;margin-left:5px}
      p{margin:9px 0}#status{white-space:pre-wrap;background:#f0f5fb;padding:9px;border-radius:5px;overflow-wrap:anywhere}#files{font-size:12px;overflow-wrap:anywhere}
      #status.is-error{color:#b42318;background:#fff0f0;border:1px solid #f1a6a0;font-weight:700}
      .hint{font-size:12px;color:#465972}
      .body details{width:auto;max-height:none;box-shadow:none}
      .hazards{display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;margin:8px 0}.hazards label,.other{font-weight:400;font-size:12px;margin:0;display:flex;align-items:flex-start;gap:4px}
      input[type=checkbox]{width:auto;display:inline;margin:3px 0 0;flex:none}
    </style>
    <details open><summary>TBM-KY上傳小助手 v1.2.0</summary><div class="body">
      <details id="job-settings"><summary>⚙ 本機勞務包設定</summary><div class="body">
        <p class="hint">進入資料上傳頁，先在網站選「承攬商」，等工作選單載入，再讀取。名稱直接來自網站，不用手打；只保存到這台電腦的瀏覽器。</p>
        <button id="read-jobs" type="button">從網站讀取勞務包</button>
        <div id="job-choices"></div><p id="job-settings-status" class="hint"></p>
        <button id="save-jobs" type="button" disabled>儲存勾選的常用包</button>
      </div></details>
      <label>本次勞務包<select id="job"></select></label>
      <label>執行紀錄日期<input id="date" type="date"></label>
      <label>工作內容概要（可修改）<textarea id="summary"></textarea></label>
      <details id="hazard-editor"><summary>本包危害設定（可展開修改）</summary><div class="body">
        <p id="profile-status" class="hint"></p>
        <div class="hazards">${HAZARD_NAMES.map((name, index) => `<label><input id="hazard-${index}" type="checkbox">${index + 1}.${name}</label>`).join('')}</div>
        <label class="other"><input id="other" type="checkbox">23.其他</label><input id="other-text" type="text" placeholder="勾選其他時必填說明">
        <p class="hint">每個包分開記憶。填寫時完全套用本設定；你手動點網站「開始上傳」時，會記住網頁最新勾選。</p>
      </div></details>
      <button id="start" type="button">填寫並帶出宣導事項</button><button id="stop" type="button" disabled>停止</button>
      <p id="status" role="status" aria-live="polite">先選勞務包及日期，再開始填寫。請先完成填寫，再選附件。</p>
      <p id="files"></p><p class="hint">登入、三張 JPG 選檔及最後「開始上傳」由你操作。可點標題收合面板。</p>
    </div></details>`;
  const el = id => ui.getElementById(id);
  let jobChoices = [];
  function refreshJobs(preferred = '') {
    el('job').textContent = '';
    for (const name of JOBS) {
      const option = document.createElement('option');
      option.value = option.textContent = name;
      el('job').appendChild(option);
    }
    el('job').value = JOBS.includes(preferred) ? preferred : (JOBS[0] || '');
  }
  refreshJobs();
  el('job-settings').open = !JOBS.length;
  const taipei = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = name => taipei.find(item => item.type === name).value;
  el('date').value = `${part('year')}-${part('month')}-${part('day')}`;
  el('summary').value = JOBS[0] || '';

  function validProfile(profile) {
    return Boolean(profile && Array.isArray(profile.hazards) && profile.hazards.every(index => Number.isInteger(index) && index >= 0 && index < HAZARD_NAMES.length) && new Set(profile.hazards).size === profile.hazards.length && typeof profile.other === 'boolean' && typeof profile.otherText === 'string' && (!profile.other || profile.otherText.trim()));
  }
  function profileKey(job) { return PROFILE_KEY + encodeURIComponent(job); }
  function readProfile(job) {
    const raw = localStorage.getItem(profileKey(job));
    if (!raw) return null;
    const profile = JSON.parse(raw);
    if (!validProfile(profile)) throw new Error('這個包的危害記憶無效，請重新勾選；親自點網站「開始上傳」時會重新建立。');
    return profile;
  }
  function writeProfile(job, profile) {
    if (!JOBS.includes(job) || !validProfile(profile)) throw new Error('危害設定無效；勾選「其他」時必須填寫說明。');
    const value = JSON.stringify(profile);
    localStorage.setItem(profileKey(job), value);
    if (localStorage.getItem(profileKey(job)) !== value) throw new Error('危害設定儲存失敗，請改用人工操作。');
  }
  function showProfile(profile) {
    for (let index = 0; index < HAZARD_NAMES.length; index++) el(`hazard-${index}`).checked = profile.hazards.includes(index);
    el('other').checked = profile.other;
    el('other-text').value = profile.other ? profile.otherText : '';
  }
  function editorProfile() {
    const profile = { hazards: HAZARD_NAMES.flatMap((name, index) => el(`hazard-${index}`).checked ? [index] : []), other: el('other').checked, otherText: el('other').checked ? el('other-text').value.trim() : '' };
    if (!validProfile(profile)) throw new Error('勾選「23.其他」時請填寫說明。');
    return profile;
  }
  function loadProfile() {
    try {
      const profile = readProfile(el('job').value);
      showProfile(profile || { hazards: INITIAL_HAZARDS, other: false, otherText: '' });
      el('hazard-editor').open = !profile;
      el('profile-status').textContent = profile ? '已載入這個包上次上傳時記住的勾選；可修改。' : '第一次使用：先前的 11 項僅供修改。請確認勾選；親自點網站「開始上傳」時會自動建立記憶。';
    } catch (caught) {
      showProfile({ hazards: [], other: false, otherText: '' });
      el('hazard-editor').open = true;
      el('profile-status').textContent = caught.message;
    }
  }
  function pageProfile() {
    const hazards = HAZARD_NAMES.flatMap((name, index) => enabled(`CheckBoxList3_${index}`).checked ? [index] : []);
    const other = enabled('CheckBox2').checked;
    const profile = { hazards, other, otherText: other ? enabled('TextBox3').value.trim() : '' };
    if (!validProfile(profile)) throw new Error('網頁勾選「其他」但未填說明，尚未更新記憶。');
    return profile;
  }
  function rememberPage() {
    if (complete() || busy() || (state && state.stage !== 'review')) throw new Error('請等表單填寫完成再儲存目前勾選。');
    if (!targetMatches()) throw new Error('網頁尚未選取承攬商，未更新危害記憶。');
    const job = selected(byId('DropDownList3'));
    if (!JOBS.includes(job)) throw new Error('網頁的勞務包不在目前清單，未更新危害記憶。');
    const profile = pageProfile();
    writeProfile(job, profile);
    if (state?.stage === 'review' && state.job === job) { state.profile = profile; save(); }
    if (el('job').value === job) { showProfile(profile); el('profile-status').textContent = '已記住網頁目前勾選，下次同一包會套用。'; }
    return job;
  }

  function dateParts(value) {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
    if (!match) throw new Error('請選擇有效的執行紀錄日期。');
    const [y, m, d] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (y < 1911 || date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) {
      throw new Error('執行紀錄日期無效。');
    }
    return [y, m, d];
  }
  function formattedDate(value) {
    return dateParts(value).map((number, index) => index ? String(number).padStart(2, '0') : number).join('/');
  }
  function sameDate(left, right) {
    try { return dateParts(left).join('-') === dateParts(right).join('-'); } catch { return false; }
  }
  function enabled(name) {
    const node = byId(name);
    if (!node || node.disabled) throw new Error(`找不到可用的 ${name} 欄位，請改用人工操作。`);
    return node;
  }
  function text(node) { return node?.textContent.trim() || ''; }
  function selected(node) { return text(node?.options?.[node.selectedIndex]); }
  function complete() { return text(byId('Label3')) === '上傳完成!'; }
  function hasFiles() {
    return [1, 2, 3].some(number => {
      const input = document.getElementById(`ctl00_${PREFIX}AsyncFileUpload${number}_ctl02`);
      return input?.files?.length || input?.value || /上傳成功|已上傳/.test(text(byId(`Label${14 + number}`))) || text(byId(`Label${4 + number}`)) === '已上傳';
    });
  }
  function busy() { return Boolean(prm?.get_isInAsyncPostBack()); }
  function status(message, isError = false) {
    el('status').className = isError ? 'is-error' : '';
    el('status').textContent = message;
  }
  function fileHint() {
    const folder = el('date').value.replaceAll('-', '');
    el('files').textContent = `人工選檔位置：桌面 / TBM-KY / ${el('job').value} / ${folder}\n依序選：作業活動照片、TBM-KY紀錄表-正面、TBM-KY紀錄表-反面（JPG）。`;
  }
  function controls() {
    const active = Boolean(state && state.stage !== 'review');
    for (const id of ['job', 'date', 'summary']) el(id).disabled = active || blocked;
    for (const id of [...HAZARD_NAMES.map((name, index) => `hazard-${index}`), 'other', 'other-text']) el(id).disabled = active || blocked;
    el('start').disabled = active || blocked || !JOBS.length;
    el('read-jobs').disabled = active || blocked;
    el('save-jobs').disabled = active || blocked || !jobChoices.length;
    el('stop').disabled = !active;
    fileHint();
  }
  function save() {
    sessionStorage.setItem(KEY, JSON.stringify(state));
    if (sessionStorage.getItem(KEY) !== JSON.stringify(state)) throw new Error('無法保存本次進度，請改用人工操作。');
  }
  function clear() {
    state = null;
    try { sessionStorage.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
    controls();
  }
  function fail(message) {
    clear();
    status(`${message}\n已停止後續自動操作，請核對目前表單。`, true);
  }
  function next(stage) {
    state.stage = stage;
    state.changed = Date.now();
    save();
  }
  function waitFor(stage, action) {
    state.wait = { nonce, ends };
    next(stage);
    action();
  }
  function returned() {
    if (busy()) return false;
    if (state.wait.nonce !== nonce || ends > state.wait.ends) return true;
    if (Date.now() - state.changed > TIMEOUT) throw new Error('網站回傳逾時。請查看網站訊息，不自動重試。');
    return false;
  }
  function setValue(node, value) {
    if (node.value === value) return;
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function targetMatches() { return selected(byId('DropDownList1')) === '承攬商'; }
  function jobMatches() { return selected(byId('DropDownList3')) === state.job; }
  function verify() {
    if (!sameDate(byId('TextBox1')?.value || '', state.date) || !targetMatches() || !jobMatches() || byId('TextBox6')?.value !== state.summary || HAZARD_NAMES.some((name, index) => !byId(`CheckBoxList3_${index}`) || byId(`CheckBoxList3_${index}`).checked !== state.profile.hazards.includes(index)) || !byId('CheckBox2') || byId('CheckBox2').checked !== state.profile.other || (state.profile.other && byId('TextBox3')?.value !== state.profile.otherText)) {
      throw new Error('回傳後的日期、勞務包、概要或危害勾選與本次設定不符，請人工核對。');
    }
  }
  function attachLifecycle() {
    if (prm) return;
    const manager = window.Sys?.WebForms?.PageRequestManager?.getInstance();
    if (!manager) return;
    prm = manager;
    prm.add_endRequest((sender, args) => {
      ends++;
      if (args.get_error?.()) error = '網站非同步回傳失敗，請查看網站顯示的錯誤。';
    });
  }
  function tick() {
    if (running) return;
    running = true;
    try {
      attachLifecycle();
      if (complete()) {
        blocked = true;
        clear();
        const filesDone = [5, 6, 7].every(number => text(byId(`Label${number}`)) === '已上傳');
        status(filesDone ? '網站顯示「上傳完成!」，三張附件均為「已上傳」。請核對日期與勞務包；本頁不再自動填寫。' : '網站顯示「上傳完成!」。請人工核對三張附件狀態、日期與勞務包；本頁不再自動填寫。');
        return;
      }
      if (!state || state.stage === 'review') return;
      if (error) throw new Error(error);
      if (Date.now() - state.started > TTL) throw new Error('本次自動填寫進度已過期，請重新核對後開始。');
      if (PAGE === '/tbmky/default.aspx') return;
      if (busy()) {
        if (Date.now() - state.changed > TIMEOUT) throw new Error('網站仍在處理且已逾時，請人工查看結果。');
        return;
      }
      if (hasFiles()) throw new Error('已選取或上傳附件，為避免表單更新影響附件，停止自動填寫。');
      switch (state.stage) {
        case 'target': {
          setValue(enabled('TextBox1'), formattedDate(state.date));
          if (targetMatches()) { next('work'); break; }
          const select = enabled('DropDownList1');
          const option = Array.from(select.options).find(item => text(item) === '承攬商');
          if (!option) throw new Error('網站沒有「承攬商」選項，請人工操作。');
          status('正在選擇承攬商，等待網站回傳…');
          waitFor('await-target', () => setValue(select, option.value));
          break;
        }
        case 'await-target':
          if (!returned()) break;
          if (!targetMatches()) throw new Error('網站回傳後未選取承攬商。');
          next('work');
          break;
        case 'work': {
          if (!targetMatches()) throw new Error('TBM-KY 對象已變更，請重新核對。');
          const select = enabled('DropDownList3');
          const matches = Array.from(select.options).filter(item => text(item) === state.job && !item.disabled);
          if (matches.length > 1) throw new Error('網站有重複工作名稱，請改用人工操作。');
          const option = matches[0];
          if (!option) throw new Error(`網站選單沒有「${state.job}」，請確認名稱或改用人工操作。`);
          if (jobMatches()) { next('fill'); break; }
          status('正在選擇勞務包，等待網站回傳…');
          waitFor('await-work', () => setValue(select, option.value));
          break;
        }
        case 'await-work':
          if (!returned()) break;
          if (!targetMatches() || !jobMatches()) throw new Error('網站回傳後的勞務包與本次選擇不符。');
          next('fill');
          break;
        case 'fill': {
          if (!targetMatches() || !jobMatches()) throw new Error('對象或勞務包已變更，請重新核對。');
          const date = enabled('TextBox1');
          const summary = enabled('TextBox6');
          const hazards = HAZARD_NAMES.map((name, index) => enabled(`CheckBoxList3_${index}`));
          const other = enabled('CheckBox2');
          const otherText = enabled('TextBox3');
          enabled('Button9');
          setValue(date, formattedDate(state.date));
          setValue(summary, state.summary);
          for (const [index, checkbox] of [...hazards, other].entries()) {
            const checked = index < hazards.length ? state.profile.hazards.includes(index) : state.profile.other;
            if (checkbox.checked === checked) continue;
            checkbox.checked = checked;
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          }
          setValue(otherText, state.profile.other ? state.profile.otherText : '');
          verify();
          next('publicity');
          break;
        }
        case 'publicity':
          verify();
          status('表單已填寫，正在帶出本次日期的工安宣導事項…');
          waitFor('await-publicity', () => enabled('Button9').click());
          break;
        case 'await-publicity':
          if (!returned()) break;
          verify();
          next('review');
          controls();
          status('填寫完成，宣導請求已回傳。請核對第⑦項內容與確認要求，再依序手動選三張 JPG。每欄顯示「上傳成功」後，由你點網站的「開始上傳」。');
          break;
        default: throw new Error('進度資料無效，請重新開始。');
      }
    } catch (caught) {
      fail(caught.message);
    } finally { running = false; }
  }
  function settingOptions() {
    attachLifecycle();
    if (blocked || complete() || busy() || (state && state.stage !== 'review')) throw new Error('請等網站與自動填寫完成後再設定。');
    if (hasFiles()) throw new Error('已有附件，請完成本次操作後再設定勞務包。');
    if (PAGE !== '/tbmky/uploadform .aspx' || !targetMatches()) throw new Error('請進入資料上傳頁，手動在網站選「承攬商」，等工作選單載入再讀取。');
    const options = Array.from(enabled('DropDownList3').options).filter(option => !option.disabled && option.value && option.value !== '0' && text(option) && !/^(請選擇|請選取|選擇工作|--.*--)$/.test(text(option)));
    const names = options.map(text);
    if (!names.length) throw new Error('網站尚未提供可選工作，請等待或核對網站。');
    if (new Set(names).size !== names.length) throw new Error('網站有重複工作名稱，無法安全辨識；請改用人工操作。');
    return names;
  }
  el('read-jobs').addEventListener('click', () => {
    try {
      const names = settingOptions();
      el('job-choices').textContent = '';
      jobChoices = [];
      for (const name of names) {
        const label = document.createElement('label');
        label.className = 'other';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = JOBS.includes(name);
        const caption = document.createElement('span');
        caption.textContent = name;
        label.appendChild(checkbox);
        label.appendChild(caption);
        el('job-choices').appendChild(label);
        jobChoices.push({ name, checkbox });
      }
      el('job-settings-status').textContent = `已讀取 ${names.length} 個工作；勾選這台常用的包，再儲存。`;
      controls();
    } catch (caught) {
      jobChoices = [];
      el('job-choices').textContent = '';
      controls();
      el('job-settings-status').textContent = caught.message;
    }
  });
  el('save-jobs').addEventListener('click', () => {
    try {
      const current = settingOptions();
      const chosen = jobChoices.filter(item => item.checkbox.checked).map(item => item.name);
      if (!chosen.length) throw new Error('請至少勾選一個常用勞務包。');
      if (chosen.some(name => !current.includes(name))) throw new Error('網站選單已變動，請重新讀取再勾選。');
      const value = JSON.stringify(chosen);
      localStorage.setItem(JOBS_KEY, value);
      if (localStorage.getItem(JOBS_KEY) !== value) throw new Error('本機設定儲存失敗，請改用人工操作。');
      const previous = el('job').value;
      JOBS = chosen;
      clear();
      refreshJobs(previous);
      el('summary').value = el('job').value;
      loadProfile();
      controls();
      el('job-settings').open = false;
      el('job-settings-status').textContent = `已保存 ${JOBS.length} 個常用包；更新腳本會保留。`;
      status('本機勞務包已設定。核對日期、概要與危害後開始填寫。');
    } catch (caught) { el('job-settings-status').textContent = caught.message; }
  });
  el('job').addEventListener('change', () => {
    el('summary').value = el('job').value;
    loadProfile();
    fileHint();
    if (state?.stage === 'review') { clear(); status('勞務包已變更，請重新填寫並核對宣導與附件。'); }
  });
  // 只觀察使用者的最終提交動作，不觸發、阻擋或重送網站提交。
  function rememberSubmission() {
    try { rememberPage(); }
    catch (caught) { status(`本次危害未能記住：${caught.message}\n網站提交由原頁面處理。`, true); }
  }
  document.addEventListener('click', event => {
    if (event.target?.id === PREFIX + 'Button1' && !event.target.disabled) rememberSubmission();
  }, true);
  document.addEventListener('submit', event => {
    if (event.submitter?.id === PREFIX + 'Button1' && !event.submitter.disabled) rememberSubmission();
  }, true);
  for (const id of ['date', 'summary']) el(id).addEventListener('input', () => {
    fileHint();
    if (state?.stage === 'review') { clear(); status('本次設定已變更，請重新填寫並核對宣導與附件。'); }
  });
  el('stop').addEventListener('click', () => {
    clear();
    status('已停止後續自動操作。已填內容保留；網站已送出的回傳仍可能完成。');
  });
  el('start').addEventListener('click', () => {
    try {
      if (blocked || complete()) throw new Error('本頁已完成上傳，請勿重複操作。');
      if (state && state.stage !== 'review') return;
      attachLifecycle();
      if (busy()) throw new Error('網站正在處理，請等完成後再開始。');
      if (hasFiles()) throw new Error('請在選取附件前完成自動填寫；目前已有附件，請使用人工核對。');
      const job = el('job').value;
      const date = el('date').value;
      const summary = el('summary').value.trim();
      if (!JOBS.includes(job) || !summary) throw new Error('請選擇勞務包並填寫工作內容概要。');
      dateParts(date);
      const profile = editorProfile();
      el('profile-status').textContent = '本次危害草稿已確認；親自點網站「開始上傳」時會自動記住。';
      el('hazard-editor').open = false;
      error = '';
      state = { job, date, summary, profile, stage: 'target', started: Date.now(), changed: Date.now() };
      save();
      controls();
      if (PAGE === '/tbmky/default.aspx') {
        status('正在前往資料上傳頁…');
        location.assign(new URL('/TBMKY/UploadForm%20.aspx', location.origin).href);
      } else tick();
    } catch (caught) { fail(caught.message); }
  });
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!JOBS.includes(saved.job) || !validProfile(saved.profile) || typeof saved.summary !== 'string' || !saved.summary.trim() || !Number.isFinite(saved.started) || Date.now() - saved.started > TTL || !['target', 'work', 'fill', 'publicity', 'await-target', 'await-work', 'await-publicity', 'review'].includes(saved.stage) || (saved.stage.startsWith('await-') && (!saved.wait || typeof saved.wait.nonce !== 'string' || !Number.isFinite(saved.wait.ends))) || !Number.isFinite(saved.changed)) throw new Error('先前進度已過期或無效，請核對後重新開始。');
      dateParts(saved.date);
      state = saved;
      el('job').value = saved.job;
      el('date').value = saved.date;
      el('summary').value = saved.summary;
      showProfile(saved.profile);
      el('profile-status').textContent = '本次執行使用開始時確認的危害設定。';
      status(saved.stage === 'review' ? '前次填寫已完成。請重新核對網站表單、第⑦項與三張附件，再手動送出。' : '接續本次填寫進度…');
    }
  } catch (caught) { fail(caught.message); }
  if (!state && JOBS.length) loadProfile();
  if (!JOBS.length) status(settingsError || '首次使用：展開「⚙ 本機勞務包設定」，從網站讀取並勾選常用包。', Boolean(settingsError));
  controls();
  console.info('[TBM-KY v1.2.0] 介面已建立。');
  tick();
  setInterval(tick, 300);
})();
