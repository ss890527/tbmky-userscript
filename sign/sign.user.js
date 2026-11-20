// ==UserScript==
// @name         行動簽核小幫手
// @namespace    moonbase.ei.sign
// @version      0.1.0
// @description  行動假單「代理人簽核」與行動加班「出勤簽核」自動選好同意（不送出，由你核對後按確認送出）；請假頁自動關閉進入提示並帶入上次的代理人。
// @match        https://service.taipower.com.tw/EI/LTRWD/*
// @match        https://service.taipower.com.tw/EI/PARWD/*
// @updateURL    https://raw.githubusercontent.com/ss890527/tbmky-userscript/main/sign/sign.meta.js
// @downloadURL  https://raw.githubusercontent.com/ss890527/tbmky-userscript/main/sign/sign.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '0.1.0';
  const AGENT_KEY = 'moonbase.ei.sign.agent.v1';
  const JUMP_KEY = 'moonbase.ei.sign.jumped.v1';
  const PAGES = { login: 'Login', index: 'Index', agentsign: 'AgentSign', signpage: 'SignPage', page: 'Page' };
  const SIGN_PATH = { LTRWD: '/EI/LTRWD/AgentSign', PARWD: '/EI/PARWD/SignPage' };
  const SYSTEM_NAME = { LTRWD: '行動假單', PARWD: '行動加班' };

  const normalizeText = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function parsePage(pathname) {
    const match = /^\/EI\/(LTRWD|PARWD)(?:\/([^/?#]*))?/i.exec(pathname || '');
    if (!match) return null;
    const key = (match[2] || 'index').toLowerCase();
    return { system: match[1].toUpperCase(), page: PAGES[key] || 'Other' };
  }

  // 「出勤簽核（1）」→ 1；沒有數字回 null。
  function parsePendingCount(text) {
    const match = /[（(]\s*(\d+)\s*[）)]/.exec(String(text ?? ''));
    return match ? Number(match[1]) : null;
  }

  // 假單只認 value=1 且文字剛好是「同意」；加班只認「同意(不再確認)」。
  function isApproveOption(system, option) {
    const text = normalizeText(option.textContent);
    if (system === 'LTRWD') return option.value === '1' && text === '同意';
    if (system === 'PARWD') return option.value === 'approveSkipPaySelPage' && text.startsWith('同意');
    return false;
  }

  function isIdleChoice(select) {
    const current = select.options[select.selectedIndex];
    return !current || current.value === '' || normalizeText(current.textContent) === '不處理';
  }

  // 只把「不處理」改成同意；已有其他選擇不動。不點任何按鈕。
  function applyApprove(doc, system) {
    const selects = Array.from(doc.querySelectorAll('select[id^="selOpinion_"]'));
    const result = { total: selects.length, set: 0, already: 0, other: 0, missing: 0 };
    for (const select of selects) {
      const option = Array.from(select.options).find(item => isApproveOption(system, item));
      if (!option) { result.missing += 1; continue; }
      if (select.value === option.value) { result.already += 1; continue; }
      if (!isIdleChoice(select)) { result.other += 1; continue; }
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      if (select.value === option.value) result.set += 1; else result.missing += 1;
    }
    return result;
  }

  function describeApprove(result) {
    if (!result.total) return '沒有待簽項目。';
    const parts = [];
    const agreed = result.set + result.already;
    if (agreed) parts.push(`${agreed} 筆已設為同意`);
    if (result.other) parts.push(`${result.other} 筆已有其他選擇，未更動`);
    if (result.missing) parts.push(`${result.missing} 筆找不到「同意」選項，請手動處理`);
    return `${parts.join('；')}。${agreed ? '請核對後自行按「確認送出」。' : ''}`;
  }

  // 只標示「確認送出」，絕不點擊。
  function highlightSubmit(doc) {
    const buttons = Array.from(doc.querySelectorAll('button')).filter(button => normalizeText(button.textContent) === '確認送出');
    for (const button of buttons) button.style.outline = '3px solid #e67e22';
    if (buttons[0] && buttons[0].scrollIntoView) buttons[0].scrollIntoView({ block: 'center' });
    return buttons.length;
  }

  async function waitFor(check, timeout = 8000, step = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  function safeStorage(win, name) {
    try { const store = win[name]; store.getItem('x'); return store; } catch { return null; }
  }
  const readItem = (store, key) => { try { return store ? store.getItem(key) : null; } catch { return null; } };
  const writeItem = (store, key, value) => { try { if (store) store.setItem(key, value); } catch { /* 無儲存空間時不記憶 */ } };

  function createPanel(doc) {
    const box = doc.createElement('div');
    box.id = 'moonbase-ei-sign-panel';
    box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:280px;background:#fff;color:#111;border:2px solid #2d6cdf;border-radius:8px;padding:8px 10px;font:14px/1.5 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    const title = doc.createElement('div');
    title.textContent = `行動簽核小幫手 v${VERSION}`;
    title.style.cssText = 'font-weight:bold;cursor:pointer;';
    const body = doc.createElement('div');
    title.addEventListener('click', () => { body.style.display = body.style.display === 'none' ? '' : 'none'; });
    const lines = doc.createElement('div');
    const actions = doc.createElement('div');
    actions.style.cssText = 'margin-top:6px;';
    body.append(lines, actions);
    box.append(title, body);
    (doc.body || doc.documentElement).appendChild(box);
    const byId = new Map();
    return {
      setLine(id, text) {
        let node = byId.get(id);
        if (!node) { node = doc.createElement('div'); byId.set(id, node); lines.appendChild(node); }
        node.textContent = text;
      },
      addButton(label, onClick) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'margin:2px 4px 2px 0;padding:4px 8px;';
        button.addEventListener('click', onClick);
        actions.appendChild(button);
      },
    };
  }

  function go(win, doc, selector, fallbackPath) {
    const anchor = selector ? doc.querySelector(selector) : null;
    const href = anchor && anchor.getAttribute('href');
    if (href && !/^(javascript:|#)/i.test(href)) win.location.assign(new URL(href, win.location.href).href);
    else win.location.assign(win.location.origin + fallbackPath);
  }

  async function runLogin(doc, panel) {
    const input = doc.querySelector('#rwd_recapt');
    if (input) input.focus();
    panel.setLine('main', '請輸入驗證碼並自行按「登入」。');
  }

  async function runIndex(win, doc, panel, info, session) {
    const flag = `${JUMP_KEY}.${info.system}`;
    if (info.system === 'LTRWD') {
      panel.addButton('前往簽核代理', () => go(win, doc, '#nav_AgentSign', SIGN_PATH.LTRWD));
      panel.addButton('前往請假', () => go(win, doc, '#nav_page', '/EI/LTRWD/Page'));
      if (readItem(session, flag)) { panel.setLine('main', '已在首頁。'); return; }
      writeItem(session, flag, '1');
      panel.setLine('main', '登入後第一次進首頁，前往簽核代理…');
      go(win, doc, '#nav_AgentSign', SIGN_PATH.LTRWD);
      return;
    }
    panel.addButton('前往出勤簽核', () => go(win, doc, '#div_Sign > a', SIGN_PATH.PARWD));
    const anchor = await waitFor(() => doc.querySelector('#div_Sign > a'), 5000);
    const count = anchor ? parsePendingCount(anchor.textContent) : null;
    if (readItem(session, flag)) { panel.setLine('main', count === null ? '已在首頁。' : `出勤簽核待簽 ${count} 筆。`); return; }
    writeItem(session, flag, '1');
    if (count > 0) {
      panel.setLine('main', `出勤簽核待簽 ${count} 筆，前往簽核…`);
      go(win, doc, '#div_Sign > a', SIGN_PATH.PARWD);
    } else {
      panel.setLine('main', count === 0 ? '目前沒有待簽出勤。' : '找不到待簽數量，請自行進入出勤簽核。');
    }
  }

  async function runSign(doc, panel, info) {
    const ready = await waitFor(() => doc.querySelector('select[id^="selOpinion_"]'), 8000);
    if (!ready) { panel.setLine('main', '沒有待簽項目（或尚未載入）。'); return; }
    const result = applyApprove(doc, info.system);
    const shown = highlightSubmit(doc);
    panel.setLine('main', describeApprove(result));
    if (!shown) panel.setLine('submit', '找不到「確認送出」按鈕，請自行確認頁面。');
  }

  function findNoticeOk(doc) {
    const buttons = Array.from(doc.querySelectorAll('.bootbox .modal-footer button'));
    if (buttons.length !== 1 || normalizeText(buttons[0].textContent) !== 'OK') return null;
    return buttons[0];
  }

  function agentLinks(doc) {
    return Array.from(doc.querySelectorAll('#sel_agent ul li > a'));
  }

  async function runLeave(doc, panel, store) {
    // 記住使用者本人手選的代理人（只在本機瀏覽器，不寫入程式或 Git）。
    doc.addEventListener('click', event => {
      const link = event.isTrusted && event.target && event.target.closest ? event.target.closest('#sel_agent ul li > a') : null;
      if (!link) return;
      const text = normalizeText(link.textContent);
      if (text) { writeItem(store, AGENT_KEY, text); panel.setLine('agent', '已記住這次選的代理人。'); }
    }, true);

    const ok = await waitFor(() => findNoticeOk(doc), 4000);
    if (ok) {
      const bootbox = ok.closest('.bootbox');
      const body = bootbox && bootbox.querySelector('.modal-body');
      const text = normalizeText(body && body.textContent).slice(0, 60);
      ok.click();
      panel.setLine('dialog', `已關閉進入提示${text ? `（${text}）` : ''}。`);
      await sleep(300);
    }
    const saved = readItem(store, AGENT_KEY);
    if (!saved) { panel.setLine('agent', '尚未記住代理人：請手選一次，之後自動帶入。'); return; }
    const link = await waitFor(() => agentLinks(doc).find(item => normalizeText(item.textContent) === saved), 15000);
    if (!link) { panel.setLine('agent', '找不到上次的代理人選項，請手選（會重新記住）。'); return; }
    if (link.parentElement && /\b(active|selected)\b/.test(link.parentElement.className)) { panel.setLine('agent', '代理人已是上次的選擇。'); return; }
    link.click();
    panel.setLine('agent', '已帶入上次的代理人。其他欄位與送出請自行處理。');
  }

  async function main(win, doc) {
    const info = parsePage(win.location.pathname);
    if (!info) return;
    const panel = createPanel(doc);
    panel.setLine('system', SYSTEM_NAME[info.system]);
    const local = safeStorage(win, 'localStorage');
    const session = safeStorage(win, 'sessionStorage');
    try {
      if (info.page === 'Login') await runLogin(doc, panel);
      else if (info.page === 'Index') await runIndex(win, doc, panel, info, session);
      else if ((info.system === 'LTRWD' && info.page === 'AgentSign') || (info.system === 'PARWD' && info.page === 'SignPage')) await runSign(doc, panel, info);
      else if (info.system === 'LTRWD' && info.page === 'Page') await runLeave(doc, panel, local);
    } catch (error) {
      panel.setLine('error', `小幫手發生錯誤：${normalizeText(error && error.message)}。請自行操作。`);
    }
  }

  const api = { VERSION, normalizeText, parsePage, parsePendingCount, isApproveOption, applyApprove, describeApprove, highlightSubmit, main };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && window.document && !window.__moonbaseEiSignNoAutoStart) main(window, window.document);
})();
