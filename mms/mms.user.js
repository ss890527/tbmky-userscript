// ==UserScript==
// @name         MMS工作日誌小助手
// @namespace    moonbase.mms.worklog
// @version      0.1.10
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
  const VERSION = '0.1.10';
  const TBM = 'TBM-KY工具箱會議';
  const SETTINGS_KEY = 'moonbase.mms.worklog.settings.v1';
  const OFFICE_KEY = 'moonbase.mms.worklog.office.v1';
  const OFFICE_DEFAULTS = ['文書處理', '資安文書處理'];
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
    const text = line.trim().replace(/\\+$/, '').trim();
    const chat = /^\d{1,2}:\d{2}\s+\S+\s+(.*)$/.exec(text);
    return chat ? chat[1] : text;
  }

  function parseLine(raw) {
    invariant(typeof raw === 'string' && raw.trim(), '請先貼上 LINE 工作訊息。');
    const jobs = [];
    let current = null, pending = null;
    const flush = () => {
      if (!current) return;
      invariant(current.unit && current.started && current.lines.some(x => x.trim()), '某份請修缺少機組別或請修內容，請補齊。');
      jobs.push(`機組別：${current.unit}\n請修內容：${current.lines.join('\n').trim()}`);
      current = null; pending = null;
    };
    for (const original of raw.replace(/\r\n?/g, '\n').split('\n')) {
      const line = stripChat(original);
      const field = /^(機\s*組\s*別\s*[／/]\s*區\s*域\s*別|機\s*組(?:\s*[／/]\s*區\s*域)?\s*別|區\s*域\s*別|請\s*修\s*日\s*期|請\s*修\s*內\s*容)(?:(?:\s*[:：]\s*|\s+)(.*)|\s*)$/.exec(line);
      if (field) {
        const label = field[1].replace(/\s/g, ''), value = clean(field[2]);
        if (label === '請修日期') {
          // 日期可在機組之前或之後；內容尚未開始時不切斷同一份請修。
          if (current?.started) flush();
          pending = value ? null : 'date';
        } else if (label === '請修內容') {
          invariant(current && !current.started, '請修內容缺少對應機組別或機組/區域別，請核對原文。');
          current.started = true; pending = null;
          if (value) current.lines.push(value);
        } else {
          flush(); current = { unit: value, started: false, lines: [] };
          pending = value ? null : 'unit';
        }
        continue;
      }
      if (!line || /^\d+\s*[.．、]$/.test(line)) continue;
      if (/今日值班|^\S*值\s+[A-Z]班|^共用設備\s*[:：]/.test(line)) continue;
      if (pending === 'date') { pending = null; continue; }
      if (pending === 'unit') { current.unit = line; pending = null; continue; }
      if (current?.started) current.lines.push(line);
    }
    flush();
    invariant(jobs.length, '未找到機組／區域與請修內容，請保留這兩個標題及內容。');
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

  function distribute(total, count, step = 1) {
    const units = total / step;
    invariant(Number.isInteger(units) && total > 0 && Number.isInteger(count) && count > 0 && [1, 0.5].includes(step), '可分配時數須符合整點或半小時單位。');
    invariant(units >= count, `工項數超過可分配時數，每項至少 ${step} 小時；請在網站調整。`);
    const base = Math.floor(units / count), extra = units % count;
    return Array.from({ length: count }, (_, index) => (base + (index >= count - extra ? 1 : 0)) * step);
  }

  function makePlan(existing, requested, total = 8, explicitHours = null, scope = null) {
    invariant(Number.isInteger(total) && total >= 2 && total <= 24, '每人目標時數須為 2～24 的整數。');
    invariant(Array.isArray(existing) && Array.isArray(requested), '工項資料格式錯誤。');
    const rows = existing.map(row => ({ ...row, added: false, context: clean(row.context), hour: Number(row.hour), seq: Number(row.seq) }));
    const usedSeq = new Set();
    for (const row of rows) {
      invariant(row.context && Number.isInteger(row.seq) && row.seq > 0 && row.seq <= 999 && !usedSeq.has(row.seq), '既有工項內容／序號有缺漏或重複，請先核對。');
      invariant(Number.isFinite(row.hour) && row.hour >= 0, `既有第 ${row.seq} 項時數格式錯誤。`);
      usedSeq.add(row.seq);
    }
    const selected = scope ? scope.selected : [''];
    invariant(Array.isArray(selected) && selected.length && new Set(selected).size === selected.length, '請選擇不重複的填寫人員。');
    const staff = scope ? scope.employees : [{ name: '', csv: rows.map(row => row.seq).join(',') }];
    const owned = selected.map(name => {
      const matches = staff.filter(person => person.name === name);
      invariant(matches.length <= 1, '指定姓名在表單重複，請先核對。');
      const csv = mergeCsv(matches[0]?.csv || '', [], [...usedSeq]);
      return { name, sequences: csv ? csv.split(',').map(Number) : [] };
    });
    const frozen = new Set();
    for (const person of staff.filter(person => person.name && !selected.includes(person.name))) {
      const csv = mergeCsv(person.csv, [], [...usedSeq]);
      if (csv) csv.split(',').map(Number).forEach(seq => frozen.add(seq));
    }
    const meetings = rows.filter(row => isTbm(row.context));
    invariant(meetings.length <= 1, '既有 TBM 項目重複，請先核對。');
    invariant(!meetings.length || meetings[0].hour === 1, '既有 TBM 會議需為 1 小時；請先核對。');
    let seq = Math.max(0, ...usedSeq), meeting = meetings[0];
    if (!meeting) {
      meeting = { context: TBM, seq: ++seq, hour: 1, progress: 100, added: true };
      rows.push(meeting);
    }
    // 只沿用所有所選人員都已指派的相同工項，避免承接別人的同名工作。
    const common = rows.filter(row => owned.every(person => person.sequences.includes(row.seq)));
    const seen = new Map(common.map(row => [canonical(row.context), row]));
    const skipped = [];
    const requestedRows = [];
    const hours = explicitHours ? explicitHours.map(Number) : null;
    if (hours) invariant(hours.length === requested.length && hours.every(h => Number.isFinite(h) && h > 0), '指定工項時數需全部填入正數。');
    requested.forEach((context, index) => {
      const text = clean(context), key = canonical(text);
      invariant(text && !isTbm(text), '請只提供一般工項，TBM 會議由助手處理。');
      let row = seen.get(key);
      if (row) skipped.push(index + 1);
      else {
        row = { context: text, source: index, seq: ++seq, hour: 0, progress: 100, added: true };
        seen.set(key, row); rows.push(row);
      }
      requestedRows.push(row);
    });
    const assignments = [...new Set([meeting.seq, ...requestedRows.map(row => row.seq)])];
    const proposals = new Map();
    const personAssignments = owned.map(person => {
      const sequences = [...new Set([...person.sequences, ...assignments])].sort((a, b) => a - b);
      const ownRows = rows.filter(row => sequences.includes(row.seq));
      for (const row of ownRows) invariant(row.added || row.hour > 0, `既有第 ${row.seq} 項時數不大於 0，請先處理示範或未完成項目。`);
      const values = new Map(ownRows.map(row => [row.seq, row.hour]));
      if (hours) {
        requestedRows.forEach((row, index) => values.set(row.seq, hours[index]));
      } else if (ownRows.some(row => row.added) || Math.abs(ownRows.reduce((sum, row) => sum + row.hour, 0) - total) > 1e-9) {
        const adjustable = ownRows.filter(row => row.seq !== meeting.seq && !frozen.has(row.seq));
        const fixed = ownRows.filter(row => !adjustable.includes(row)).reduce((sum, row) => sum + row.hour, 0);
        const step = ownRows.length > 8 ? 0.5 : 1;
        invariant(adjustable.length, '既有工項均與其他人共用，請在網站調整時數。');
        const chosen = distribute(total - fixed, adjustable.length, step);
        adjustable.forEach((row, index) => values.set(row.seq, chosen[index]));
      }
      invariant(Math.abs([...values.values()].reduce((sum, hour) => sum + hour, 0) - total) < 1e-9, '本人工項時數合計需等於每人目標。');
      for (const [itemSeq, hour] of values) {
        const row = rows.find(item => item.seq === itemSeq);
        invariant(!frozen.has(itemSeq) || hour === row.hour, '指定時數會改到其他人共用工項，請在網站調整。');
        invariant(!proposals.has(itemSeq) || proposals.get(itemSeq) === hour, '所選人員原工項不同，共用時數無法一致分配；請分開填寫。');
        proposals.set(itemSeq, hour);
      }
      return { name: person.name, sequences, total };
    });
    const changes = [];
    for (const row of rows) {
      if (!proposals.has(row.seq)) continue;
      const hour = proposals.get(row.seq);
      if (!row.added && row.hour !== hour) changes.push({ seq: row.seq, before: row.hour, after: hour });
      row.hour = hour;
    }
    invariant(rows.every(row => row.seq <= 999), '工項序號超過網站上限。');
    return { rows, changes, skipped, total: rows.reduce((sum, row) => sum + row.hour, 0), assignments, personAssignments, validSequences: rows.map(row => row.seq), added: rows.filter(row => row.added) };
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
    const mode = value.mode ?? 'field';
    invariant(['field', 'office', 'afternoon', 'morning', 'holiday', 'leave'].includes(mode), '本機填寫類型無效。');
    const leaveHours = Number(value.leaveHours ?? 4), holidayHours = Number(value.holidayHours ?? 8), overtimeHours = Number(value.overtimeHours ?? 0);
    const morningLeaveHours = Number(value.morningLeaveHours ?? 4);
    const lastOvertimeHours = Number(value.lastOvertimeHours ?? (overtimeHours || 2));
    invariant(Number.isInteger(leaveHours) && leaveHours >= 1 && leaveHours <= 4, '下午請假時數須為 1～4 小時。');
    invariant(Number.isInteger(morningLeaveHours) && morningLeaveHours >= 1 && morningLeaveHours <= 4, '上午請假時數須為 1～4 小時。');
    invariant(Number.isInteger(holidayHours) && holidayHours >= 8 && holidayHours <= 12, '假日加班時數須為 8～12 小時。');
    invariant([0, 2, 3, 4].includes(overtimeHours), '平日加班請選 2、3 或 4 小時。');
    invariant([2, 3, 4].includes(lastOvertimeHours), '平日加班請選 2、3 或 4 小時。');
    const overtimeTexts = { field: '大修工作', office: '', morning: '', ...value.overtimeTexts };
    const legacyDefault = !value.overtimeTexts && mode !== 'field' && value.overtimeText === '大修工作';
    const overtimeText = clean(legacyDefault ? '' : value.overtimeText ?? overtimeTexts[mode] ?? '');
    if (['field', 'office', 'morning'].includes(mode)) overtimeTexts[mode] = overtimeText;
    const holidayText = clean(value.holidayText ?? '');
    const lastOvertimeText = clean(value.lastOvertimeText ?? '大修工作');
    invariant(Object.values(overtimeTexts).every(text => typeof text === 'string' && text.length <= 2000) && overtimeText.length <= 2000 && holidayText.length <= 2000 && lastOvertimeText && lastOvertimeText.length <= 2000, '加班內容最多 2000 字。');
    // memory 僅保留作舊設定兼容；目前一律自動保存與載入。
    return { schema: 1, memory: true, total: 8, people: value.people.map(clean), mode, leaveHours, morningLeaveHours, holidayHours, overtimeHours, lastOvertimeHours, overtimeText, overtimeTexts, holidayText, lastOvertimeText };
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
    const favorites = [...new Set([...OFFICE_DEFAULTS, ...value.favorites].map(clean))].filter(text => !['請假', '整天請假'].includes(text));
    invariant(favorites.every(text => text && text.length <= 200 && !/[\r\n]/.test(text)), '常用項目請填入 1～200 字的單行文字。');
    const last = ['請假', '整天請假'].includes(clean(value.last)) ? OFFICE_DEFAULTS[0] : clean(value.last);
    invariant(last && last.length <= 200 && !/[\r\n]/.test(last), '上次非現場項目請填入 1～200 字的單行文字。');
    return { schema: 1, favorites, last };
  }
  function makeOfficePlan(existing, requested, assignedSequences = []) {
    invariant(requested.length === 1 && clean(requested[0]) && !isTbm(requested[0]), '非現場模式只能填一項工作。');
    const context = clean(requested[0]);
    const rows = existing.map(row => ({ ...row, seq: Number(row.seq), hour: Number(row.hour), added: false }));
    invariant(rows.every(row => clean(row.context) && Number.isInteger(row.seq) && row.seq > 0 && row.seq <= 999 && Number.isFinite(row.hour) && row.hour >= 0) && new Set(rows.map(row => row.seq)).size === rows.length, '既有工項序號或時數格式有誤，請先核對。');
    // 日誌由同部門共用；僅沿用已指派給本次所有所選人員的同一非現場工項。
    const matches = rows.filter(row => assignedSequences.includes(row.seq) && canonical(row.context) === canonical(context) && row.hour === 8 && Number(row.progress) === 100);
    invariant(matches.length <= 1, '所選人員已有多個相同非現場工項，請先核對。');
    let row = matches[0];
    if (!row) {
      const seq = Math.max(0, ...rows.map(item => item.seq)) + 1;
      invariant(seq <= 999, '工項序號超過網站上限。');
      row = { context, seq, hour: 8, progress: 100, source: 0, added: true }; rows.push(row);
    }
    return { rows, changes: [], skipped: row.added ? [] : [1], office: true, requestedTotal: 8, total: rows.reduce((sum, item) => sum + item.hour, 0), assignments: [row.seq], validSequences: rows.map(item => item.seq), added: row.added ? [row] : [] };
  }
  function dutyPeriod(hours) {
    invariant(Number.isInteger(hours) && hours >= 0 && hours <= 12, '工作總時數須為 0～12 整數。');
    if (!hours) return '0';
    // 最後下班時不再加休息；4 小時→1200、8→1630、10→1900。
    const minutes = 8 * 60 + hours * 60 + Math.floor((hours - 1) / 4) * 30;
    return `0800-${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
  }
  function weekday(date) { const day = new Date(`${dateKey(date)}T00:00:00Z`).getUTCDay(); return day > 0 && day < 6; }
  function workload(value, date, requested) {
    const config = settings(value);
    const fullLeave = config.mode === 'leave';
    const overtime = weekday(date) && ['field', 'office', 'morning'].includes(config.mode) && !fullLeave ? config.overtimeHours : 0;
    invariant(!overtime || config.overtimeText, '請輸入加班工作內容。');
    const base = config.mode === 'afternoon' ? 8 - config.leaveHours : config.mode === 'morning' ? 8 - config.morningLeaveHours : config.mode === 'holiday' ? config.holidayHours : 8;
    const total = fullLeave ? 0 : base + overtime;
    const period = config.mode === 'morning' ? `${config.morningLeaveHours === 4 ? '1230' : String(8 + config.morningLeaveHours).padStart(2, '0') + '00'}-${overtime ? dutyPeriod(8 + overtime).split('-')[1] : '1630'}` : dutyPeriod(total);
    return { ...config, base, overtime, total, period, fullLeave, date: dateKey(date) };
  }
  function makeWorkPlan(existing, requested, options, scope) {
    const { base, overtime, total, fullLeave, mode } = options;
    if (fullLeave) requested = ['請假'];
    const valid = existing.map(row => Number(row.seq));
    const assigned = scope.selected.map(name => {
      const people = scope.employees.filter(person => person.name === name);
      invariant(people.length <= 1, '指定姓名在表單重複，請先核對。');
      const csv = mergeCsv(people[0]?.csv || '', [], valid);
      return { name, sequences: csv ? csv.split(',').map(Number) : [], previousHours: Number(people[0]?.hours ?? people[0]?.fields?.hours.value ?? 8) };
    });
    const common = existing.filter(row => assigned.every(person => person.sequences.includes(Number(row.seq))));
    const frozen = new Set(scope.employees.filter(person => person.name && !scope.selected.includes(person.name)).flatMap(person => {
      const csv = mergeCsv(person.csv, [], valid); return csv ? csv.split(',').map(Number) : [];
    }));
    // 用本人指派、已填工時差及上次加班內容辨識，不能假設加班永遠是最後一列。
    const previousOvertime = new Set();
    for (const person of assigned) {
      if (!['field', 'office', 'morning'].includes(mode) || person.previousHours > 12) continue;
      if (mode === 'morning' ? person.sequences.length < 2 : person.previousHours <= 8) continue;
      const matches = existing.filter(row => person.sequences.includes(Number(row.seq)) && !isTbm(row.context) && (mode === 'morning' ? [2, 3, 4].includes(Number(row.hour)) : Number(row.hour) === person.previousHours - 8) && [options.lastOvertimeText, options.overtimeText].some(text => text && canonical(row.context) === canonical(text)));
      invariant(matches.length <= 1, '本人加班工項無法唯一辨識，請先在網站核對。');
      if (matches.length) previousOvertime.add(Number(matches[0].seq));
    }
    let plan;
    if (mode === 'field') {
      const baseStaff = scope.employees.map(person => {
        if (!scope.selected.includes(person.name)) return person;
        const own = assigned.find(item => item.name === person.name);
        return { ...person, csv: own.sequences.filter(seq => !previousOvertime.has(seq)).join(',') };
      });
      plan = makePlan(existing, requested, 8, null, { ...scope, employees: baseStaff });
    } else {
      invariant(requested.length === 1 && clean(requested[0]) && !isTbm(requested[0]), '本次工作請填一項內容。');
      const rows = existing.map(row => ({ ...row, seq: Number(row.seq), hour: Number(row.hour), added: false }));
      invariant(rows.every(row => clean(row.context) && Number.isInteger(row.seq) && row.seq > 0 && row.seq <= 999 && Number.isFinite(row.hour) && row.hour >= 0) && new Set(valid).size === rows.length, '既有工項序號或時數格式有誤。');
      const matches = common.filter(row => !previousOvertime.has(Number(row.seq)) && canonical(row.context) === canonical(requested[0]));
      invariant(matches.length <= 1, '本人有多個相同工項，請先在網站核對。');
      let main = matches[0] && rows.find(row => row.seq === Number(matches[0].seq));
      const changes = [];
      if (!main || (frozen.has(main.seq) && main.hour !== base)) {
        main = { context: clean(requested[0]), seq: Math.max(0, ...valid) + 1, hour: base, progress: 100, added: true }; rows.push(main);
      } else if (main.hour !== base) { changes.push({ seq: main.seq, before: main.hour, after: base }); main.hour = base; }
      plan = { rows, changes, assignments: [main.seq], personAssignments: assigned.map(person => ({ name: person.name, sequences: [main.seq], total: fullLeave ? 8 : total })) };
    }
    if (overtime) {
      const reusable = plan.rows.filter(row => !plan.personAssignments.some(person => person.sequences.includes(row.seq)) && common.some(old => Number(old.seq) === row.seq) && (previousOvertime.has(row.seq) || canonical(row.context) === canonical(options.overtimeText)) && Number(row.progress) === 100);
      invariant(reusable.length <= 1, '本人有多個加班工項，請先在網站核對。');
      let extra = reusable[0];
      if (!extra || (frozen.has(extra.seq) && (extra.hour !== overtime || clean(extra.context) !== options.overtimeText))) {
        extra = { context: options.overtimeText, seq: Math.max(0, ...plan.rows.map(row => row.seq)) + 1, hour: overtime, progress: 100, added: true }; plan.rows.push(extra);
      } else {
        if (extra.hour !== overtime || clean(extra.context) !== options.overtimeText) plan.changes.push({ seq: extra.seq, before: extra.hour, after: overtime, context: options.overtimeText, beforeContext: extra.context });
        extra.hour = overtime; extra.context = options.overtimeText;
      }
      plan.personAssignments.forEach(person => { person.sequences = [...new Set([...person.sequences, extra.seq])].sort((a, b) => a - b); });
      plan.assignments = [...new Set([...plan.assignments, extra.seq])];
    }
    invariant(plan.rows.every(row => row.seq <= 999), '工項序號超過網站上限。');
    plan.personAssignments.forEach(person => {
      const ownTotal = plan.rows.filter(row => person.sequences.includes(row.seq)).reduce((sum, row) => sum + row.hour, 0);
      invariant(ownTotal === (fullLeave ? 8 : total), '本人工項合計不符工作時數，請核對。');
      person.total = fullLeave ? 8 : total;
    });
    return { ...plan, replaceAssignments: true, validSequences: plan.rows.map(row => row.seq), added: plan.rows.filter(row => row.added), total: plan.rows.reduce((sum, row) => sum + row.hour, 0) };
  }
  const core = { VERSION, TBM, SETTINGS_KEY, OFFICE_KEY, OFFICE_DEFAULTS, DRAFT_KEY, MAX_AGE, invariant, clean, dateKey, today, parseLine, canonical, isTbm, distribute, makePlan, makeOfficePlan, makeWorkPlan, dutyPeriod, weekday, workload, officeSettings, mergeCsv, settings, saveSettings };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }
  if (typeof document === 'undefined') return;
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (!/^\/MMS310(?:\/|$)/i.test(path) && path !== '/M300' && !(path === '/' && document.querySelector('a[href="/M300"]'))) return;
  if (document.getElementById('moonbase-mms-assistant')) return;
  const LEASE_KEY = 'moonbase.mms.worklog.lease.v1';
  const OWNER_KEY = 'moonbase.mms.worklog.owner.v1';
  let owner, configuration = settings({ schema: 1, memory: true, total: 8, people: [], mode: 'field' });
  let office = officeSettings();
  let busy = false, directory = [];
  let initError = '';
  try {
    owner = sessionStorage.getItem(OWNER_KEY) || crypto.randomUUID();
    sessionStorage.setItem(OWNER_KEY, owner);
    const raw = localStorage.getItem(SETTINGS_KEY);
    const officeRaw = localStorage.getItem(OFFICE_KEY);
    const officeValue = officeRaw ? JSON.parse(officeRaw) : null;
    if (officeValue) {
      office = officeSettings(officeValue);
      if (JSON.stringify(office) !== officeRaw) {
        localStorage.setItem(OFFICE_KEY, JSON.stringify(office));
        invariant(localStorage.getItem(OFFICE_KEY) === JSON.stringify(office), '常用項目更新保存失敗。');
      }
    }
    if (raw) {
      const previous = JSON.parse(raw);
      // 舊版下午最多 7 小時；新半天規則最多 4，保留其他設定。
      if (Number.isInteger(Number(previous.leaveHours)) && Number(previous.leaveHours) >= 5 && Number(previous.leaveHours) <= 7) previous.leaveHours = 4;
      let saved = settings(previous);
      if (saved.mode === 'office' && ['請假', '整天請假'].includes(clean(officeValue?.last))) saved = settings({ ...saved, mode: 'leave' });
      configuration = saved;
      if (JSON.stringify(saved) !== raw) configuration = saveSettings(localStorage, saved);
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
    .secondary{background:#eef5fa;color:#183047}#fill{width:100%;font-weight:700}#status{white-space:pre-wrap;padding:9px;background:#eef5fa;border-radius:5px;overflow-wrap:anywhere}#status.error{color:#b42318;border:1px solid #e9a2a0;background:#fff0ef;font-weight:700}
    .hint{font-size:12px;color:#476078}#people label{display:flex;gap:7px;align-items:center}table{border-collapse:collapse;width:100%;margin:9px 0}td,th{border-bottom:1px solid #d1dce5;padding:5px;text-align:left;vertical-align:top}td.content{white-space:pre-wrap;overflow-wrap:anywhere;max-width:290px}td input{width:64px!important}details.settings{margin:10px 0;border:1px solid #d1dce5;border-radius:5px}
  </style><details class="panel" open><summary>📝 MMS工作日誌小助手 v${VERSION}</summary><div class="body">
    <label>工作日期<input id="date" type="date"></label>
    <section id="personArea"><strong>填寫人員</strong> <button id="readPeople" class="secondary" type="button">讀取人員</button><div id="people"></div></section>
    <label>填寫類型<select id="mode"><option value="field">灰系統專用</option><option value="office">通用</option><option value="morning">通用（上午請假）</option><option value="afternoon">通用（下午請假）</option><option value="leave">整天請假</option><option value="holiday">假日加班</option></select></label>
    <label id="leaveArea" hidden>下午請假時數<select id="leaveHours">${Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1} 小時</option>`).join('')}</select></label>
    <label id="morningLeaveArea" hidden>上午請假時數<select id="morningLeaveHours">${Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1} 小時</option>`).join('')}</select></label>
    <label id="fieldArea">貼上 LINE 工項<textarea id="raw" placeholder="直接貼整段 LINE 訊息"></textarea></label>
    <div id="officeArea" hidden><label>本次工作項目<select id="officeItem"></select></label><div id="manualArea" hidden><label>本次工作項目<input id="officeText" type="text" maxlength="200" placeholder="手動輸入工作內容"></label><button id="addFavorite" class="secondary" type="button">加入常用項目</button></div></div>
    <div id="holidayArea" hidden><label>加班時數<select id="holidayHours">${Array.from({ length: 5 }, (_, i) => `<option value="${i + 8}">${i + 8} 小時</option>`).join('')}</select></label><label>工作內容與經過<textarea id="holidayText" maxlength="2000" placeholder="輸入本次假日加班工作內容"></textarea></label></div>
    <section id="overtimeArea"><label><input id="overtimeEnabled" type="checkbox"> 平日加班</label><div id="overtimeFields" hidden><label>加班時數<select id="overtimeHours"><option value="2">2 小時</option><option value="3">3 小時</option><option value="4">4 小時</option></select></label><label>加班工作內容<textarea id="overtimeText" maxlength="2000"></textarea></label></div></section>
    <button id="fill" type="button">填寫</button>
    <p id="status"></p>
    <p class="hint">填寫後請核對網站表單，再親自點「存檔」。人員設定存於本機；跨頁草稿最長保留 10 分鐘。</p>
  </div></details>`;
  const $ = id => ui.getElementById(id);
  $('date').value = today();
  $('mode').value = configuration.mode;
  function displayParameters(value, restoreDraft = false) {
    $('leaveHours').value = value.leaveHours; $('morningLeaveHours').value = value.morningLeaveHours; $('holidayHours').value = value.holidayHours;
    // 一般開頁預設不勾；只有當次跨頁草稿還原加班啟用狀態。
    $('holidayText').value = value.holidayText; $('overtimeEnabled').checked = restoreDraft && value.overtimeHours > 0;
    $('overtimeHours').value = value.lastOvertimeHours; $('overtimeText').value = value.overtimeText;
  }
  displayParameters(configuration);
  function displayOffice(selected = office.last) {
    const manual = document.createElement('option'); manual.value = ''; manual.textContent = '手動輸入';
    $('officeItem').replaceChildren(manual, ...office.favorites.map(text => { const option = document.createElement('option'); option.value = text; option.textContent = text; return option; }));
    $('officeItem').value = office.favorites.includes(selected) ? selected : '';
    $('officeText').value = selected;
    $('manualArea').hidden = Boolean($('officeItem').value);
  }
  function rememberOffice(selected) {
    const value = officeSettings({ ...office, last: selected });
    const serialized = JSON.stringify(value);
    localStorage.setItem(OFFICE_KEY, serialized);
    invariant(localStorage.getItem(OFFICE_KEY) === serialized, '非現場項目記憶保存失敗。'); office = value;
  }
  function displayMode() {
    const mode = $('mode').value, officeMode = ['office', 'afternoon', 'morning'].includes(mode);
    $('officeArea').hidden = !officeMode; $('fieldArea').hidden = mode !== 'field';
    $('leaveArea').hidden = mode !== 'afternoon'; $('holidayArea').hidden = mode !== 'holiday';
    $('morningLeaveArea').hidden = mode !== 'morning';
    $('manualArea').hidden = Boolean($('officeItem').value);
    $('overtimeArea').hidden = !['field', 'office', 'morning'].includes(mode) || !clean($('date').value) || !weekday($('date').value);
    $('overtimeFields').hidden = !$('overtimeEnabled').checked;
  }
  displayOffice();
  displayMode();
  $('mode').onchange = () => { $('overtimeText').value = configuration.overtimeTexts[$('mode').value] ?? ''; displayMode(); rememberPeople(); };
  $('officeItem').onchange = () => { if ($('officeItem').value) $('officeText').value = $('officeItem').value; displayMode(); };
  function officeInput() { const text = clean($('officeItem').value || $('officeText').value); invariant(text && text.length <= 200 && !/[\r\n]/.test(text), '請輸入本次工作項目，或選擇常用項目（1～200 字）。'); invariant(!['請假', '整天請假'].includes(text), '請改選填寫類型「整天請假」。'); return text; }
  $('addFavorite').onclick = () => {
    try { const name = officeInput(); const value = officeSettings({ schema: 1, favorites: [...office.favorites, name], last: name }); localStorage.setItem(OFFICE_KEY, JSON.stringify(value)); invariant(localStorage.getItem(OFFICE_KEY) === JSON.stringify(value), '常用項目保存失敗。'); office = value; displayOffice(name); status('已加入常用項目。'); } catch (error) { status(error.message, true); }
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
    for (const element of ui.querySelectorAll('input,textarea,button,select')) element.disabled = disabled;
  }
  async function action(callback) {
    if (busy) return;
    busy = true; controls(true);
    try { acquire(); await callback(); }
    catch (error) { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} status(error.message, true); }
    finally { release(); busy = false; controls(false); }
  }
  async function requestDoc(url, options = {}) {
    checkActive();
    const target = new URL(url, location.origin);
    invariant(target.origin === location.origin && /^\/(?:MMS310(?:\/|$)|Home\/APIEMP\/?$)/i.test(target.pathname), '讀取目標超出工作日誌範圍。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(target.href, { ...options, credentials: 'same-origin', signal: controller.signal });
      invariant(response.ok && new URL(response.url).origin === location.origin && !/\/Login/i.test(new URL(response.url).pathname), '網站登入失效或讀取失敗，請先核對登入。');
      const text = await response.text(); checkActive();
      return new DOMParser().parseFromString(text, 'text/html');
    } finally { clearTimeout(timer); }
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
  function officeSequences(items, names, staff = document.querySelector('#ListRowCHARS') ? readEmployees() : []) {
    const valid = items.map(row => Number(row.seq));
    const assignments = names.map(name => {
      const matches = staff.filter(row => row.name === name);
      invariant(matches.length <= 1, '指定姓名在表單重複，請先核對。');
      return matches.length ? mergeCsv(matches[0].csv, [], valid).split(',').filter(Boolean).map(Number) : [];
    });
    return valid.filter(seq => assignments.length && assignments.every(values => values.includes(seq)));
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
      box.type = 'checkbox'; box.value = name; box.checked = names.includes(name); box.disabled = busy;
      box.addEventListener('change', rememberPeople);
      label.append(box, document.createTextNode(name)); $('people').appendChild(label);
    }
  }
  displayPeople();
  function selectedPeople() { return [...$('people').querySelectorAll('input:checked')].map(box => box.value); }
  function currentSettings() {
    return settings({ schema: 1, memory: true, total: 8, people: selectedPeople(), mode: $('mode').value, leaveHours: Number($('leaveHours').value), morningLeaveHours: Number($('morningLeaveHours').value), holidayHours: Number($('holidayHours').value), holidayText: $('holidayText').value, overtimeHours: $('overtimeEnabled').checked ? Number($('overtimeHours').value) : 0, lastOvertimeHours: Number($('overtimeHours').value), overtimeText: $('overtimeText').value, overtimeTexts: configuration.overtimeTexts, lastOvertimeText: configuration.lastOvertimeText });
  }
  function parameters() {
    const value = currentSettings();
    invariant(value.people.length, '請先從網站讀取並勾選填寫人員。');
    return { ...value, date: dateKey($('date').value), dept: department() };
  }
  function rememberPeople() {
    try {
      const value = currentSettings();
      const available = directory.length ? directory.map(person => person.name) : [...$('people').querySelectorAll('input')].map(box => box.value);
      invariant(value.people.every(name => available.includes(name)), '請先讀取目前部門人員，再勾選。');
      configuration = saveSettings(localStorage, value);
      status('已自動記住上次設定。');
    } catch (error) { status(error.message, true); }
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
    return before.length === after.length && before.every((row, i) => after[i] && row.context === after[i].context && Number(row.seq) === Number(after[i].seq) && Number(row.hour) === Number(after[i].hour));
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
    const existingStaff = readEmployees();
    const staffSnapshot = () => readEmployees().map(person => [person.name, person.csv, person.fields.period.value, person.fields.hours.value]);
    const beforeStaff = JSON.stringify(staffSnapshot());
    const options = workload({ ...configuration, ...draft, total: 8, schema: 1, memory: true }, draft.date, draft.requested);
    const officeMode = ['office', 'afternoon', 'morning'].includes(options.mode);
    const plan = makeWorkPlan(before, draft.requested, options, { selected: draft.people, employees: existingStaff });
    const assignedTo = name => plan.personAssignments?.find(person => person.name === name)?.sequences || plan.assignments;
    invariant(before.every((row, i) => Number(row.seq) === i + 1), '網站新增會重排序號；目前序號不連續，請先核對。');
    const people = await loadDirectory(draft.dept);
    invariant(draft.people.every(name => people.some(person => person.name === name)), '設定人員已不在目前部門清單，請重新勾選。');
    configuration = saveSettings(localStorage, { ...options, total: 8 });
    for (const name of draft.people) {
      const matches = existingStaff.filter(person => person.name === name);
      invariant(matches.length <= 1, '指定姓名在表單重複，請先核對。');
      if (matches.length) mergeCsv(matches[0].csv, assignedTo(name), plan.validSequences);
    }
    invariant(sameItems(before, currentItems()) && beforeStaff === JSON.stringify(staffSnapshot()), '表單在核對期間被修改，請重新按填寫。');
    // 先備妥所有資料，才開始改動表單；只點已觀察到的網站新增按鈕。
    for (const change of plan.changes) {
      const row = readItems().find(item => Number(item.seq) === change.seq);
      invariant(Number(row?.hour) === change.before, '待調整工項時數已改變，已停止。');
      nativeValue(row.fields.hour, change.after);
      if (change.context !== undefined) {
        invariant(row.context === change.beforeContext, '待調整加班內容已改變，已停止。');
        nativeValue(row.fields.context, change.context);
      }
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
      nativeValue(target.fields.csv, mergeCsv(plan.replaceAssignments ? '' : target.fields.csv.value, assignedTo(name), plan.validSequences));
      nativeValue(target.fields.period, options.period); nativeValue(target.fields.hours, options.total);
    }
    invariant(dateKey(workDate.value) === draft.date && Math.abs(currentItems().reduce((sum, item) => sum + Number(item.hour), 0) - plan.total) < 1e-9, '最後日期或時數總和不符，請核對。');
    for (const item of plan.added) invariant(Number(readItems().find(row => Number(row.seq) === item.seq)?.progress) === 100, '新工項進度讀回不為 100%。');
    for (const name of draft.people) {
      const person = readEmployees().find(row => row.name === name);
      invariant(person && person.fields.csv.value === mergeCsv('', assignedTo(name), plan.validSequences), '最後人員指派核對失敗。');
      {
        const sequences = person.fields.csv.value.split(',').map(Number);
        const ownTotal = currentItems().filter(row => sequences.includes(Number(row.seq))).reduce((sum, row) => sum + Number(row.hour), 0);
        invariant(Math.abs(ownTotal - (options.fullLeave ? 8 : options.total)) < 1e-9, '最後本人工項時數不符目標，請核對。');
      }
      invariant(person.fields.period.value === options.period && person.fields.hours.value === String(options.total), '人員工作時間或總時數核對失敗。');
    }
    for (const original of JSON.parse(beforeStaff).filter(person => person[0] && !draft.people.includes(person[0]))) {
      invariant(staffSnapshot().some(person => JSON.stringify(person) === JSON.stringify(original)), '其他人員資料在填寫時改變，請核對。');
    }
    if (officeMode) rememberOffice(draft.requested[0]);
    if (options.overtime) configuration = saveSettings(localStorage, { ...options, total: 8, lastOvertimeText: options.overtimeText });
    sessionStorage.removeItem(DRAFT_KEY);
    status(`已填寫並核對 ${draft.date}，每人 ${options.total} 小時，工作時間 ${options.period}。請親自核對網站並點「存檔」；助手尚未存檔。`);
  }
  async function proceed(draft) {
    invariant(Date.now() - draft.created <= MAX_AGE, '跨頁草稿已超過 10 分鐘，請重新整理工項。');
    invariant(draft.explicitDate || draft.date === today(), '已跨台灣午夜，請重新核對工作日期。');
    $('date').value = draft.date; displayPeople(draft.people);
    displayParameters(settings({ ...configuration, ...draft, total: 8, schema: 1, memory: true }), true);
    $('mode').value = draft.mode || 'field'; displayMode();
    if (draft.mode === 'field') $('raw').value = draft.requested.join('\n\n');
    if (['office', 'afternoon', 'morning'].includes(draft.mode)) { displayOffice(draft.requested[0]); displayMode(); }
    if (/\/ViewDetail\//i.test(path)) {
      const head = document.querySelector('tr.JRHead');
      invariant(head && dateKey(clean(head.cells[2]?.textContent)) === draft.date && clean(head.cells[1]?.textContent) === draft.dept, '檢視頁日期或部門不符。');
      const links = [...document.querySelectorAll('a[href^="/MMS310/Edit/"]')];
      invariant(links.length === 1, '未找到唯一編修連結。'); move(draft, links[0].getAttribute('href')); return;
    }
    if (/\/Create$|\/Edit\//i.test(path)) { await prepareForm(draft); return; }
    const destination = await findWorkDate(draft.date, draft.dept); move(draft, destination);
  }
  $('fill').onclick = () => action(async () => {
    const params = parameters(), requested = params.mode === 'leave' ? ['請假'] : ['office', 'afternoon', 'morning'].includes(params.mode) ? [officeInput()] : params.mode === 'holiday' ? [clean($('holidayText').value)] : parseLine($('raw').value);
    if (params.mode === 'holiday') invariant(requested[0], '請填入假日加班的工作內容與經過。');
    workload(params, params.date, requested);
    const draft = { ...params, requested, hours: null, explicitDate: params.date !== today(), created: Date.now() };
    await proceed(draft);
  });
  $('readPeople').onclick = () => action(async () => {
    const chosen = selectedPeople(); directory = await loadDirectory(department()); displayPeople(chosen);
    status('已讀取目前部門人員，請勾選填寫對象。');
  });
  $('date').onchange = displayMode;
  for (const id of ['leaveHours', 'morningLeaveHours', 'holidayHours', 'holidayText', 'overtimeEnabled', 'overtimeHours', 'overtimeText']) $(id).onchange = () => { displayMode(); rememberPeople(); };
  console.info(`[MMS小助手 v${VERSION}] 介面已建立。`);
  status(initError || '先勾選填寫人員，再按「填寫」。首次使用請按「讀取人員」。', Boolean(initError));
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw && !initError) {
      const draft = JSON.parse(raw);
      if (draft.expected === location.pathname) action(() => proceed(draft));
      else status('有未完成草稿，但目前頁面不符預期；請回原分頁或重新按「填寫」。', true);
    }
  } catch (error) { status(`跨頁草稿無法讀取：${error.message}`, true); }
})();
