import { productVersion } from "./version.js";

export const MCP_APP_RESOURCE_URI = "ui://localdocsearch/search-context-v1.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const MCP_APP_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Seekah 搜尋工作台</title>
  <style>
    :root { color-scheme: light dark; --bg: var(--color-background-primary, Canvas); --panel: var(--color-background-secondary, color-mix(in srgb, Canvas 94%, CanvasText 6%)); --text: var(--color-text-primary, CanvasText); --muted: var(--color-text-secondary, color-mix(in srgb, CanvasText 66%, transparent)); --accent: var(--color-accent, #3157d5); --line: var(--color-border, color-mix(in srgb, CanvasText 18%, transparent)); --danger: #b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font-sans, ui-sans-serif, system-ui, sans-serif); }
    main { max-width: 960px; margin: 0 auto; padding: 16px; }
    h1 { margin: 0; font-size: 20px; }
    .subtitle, .meta { color: var(--muted); }
    .subtitle { margin: 2px 0 14px; }
    .toolbar, .actions, .pager { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .toolbar input[type="search"] { flex: 1 1 320px; }
    input, select, textarea, button { font: inherit; color: inherit; }
    input[type="search"], select, textarea { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); padding: 9px 10px; }
    textarea { width: 100%; min-height: 72px; resize: vertical; }
    button { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 8px 12px; cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; }
    button:disabled { opacity: .48; cursor: not-allowed; }
    #status { min-height: 24px; margin: 10px 0; color: var(--muted); }
    #status.error { color: var(--danger); }
    #results { display: grid; gap: 8px; }
    .result { display: grid; grid-template-columns: auto 1fr; gap: 10px; padding: 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
    .path { overflow-wrap: anywhere; font-weight: 650; }
    .snippet { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .footer { display: grid; gap: 10px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
    .spacer { flex: 1; }
    @media (max-width: 560px) { main { padding: 12px; } .actions button { flex: 1 1 180px; } }
  </style>
</head>
<body>
<main>
  <h1>Seekah 搜尋工作台</h1>
  <p class="subtitle">所有搜尋都在已建立的本機索引內；只有你勾選的片段會加入目前 AI 對話。</p>
  <form id="search-form" class="toolbar">
    <input id="query" type="search" maxlength="1000" autocomplete="off" placeholder="輸入文件中的文字" aria-label="搜尋文字" required>
    <select id="mode" aria-label="搜尋模式">
      <option value="phrase">完整片語</option>
      <option value="all-terms">全部詞</option>
    </select>
    <button class="primary" type="submit">搜尋</button>
  </form>
  <div id="status" role="status" aria-live="polite">正在連接 Host…</div>
  <div class="pager">
    <button id="previous" type="button" disabled>上一頁</button>
    <span id="page-label" class="meta">尚未搜尋</span>
    <button id="next" type="button" disabled>下一頁</button>
    <span class="spacer"></span>
    <strong id="selection-count">已選 0 / 20</strong>
    <button id="clear" type="button" disabled>清空選取</button>
  </div>
  <section id="results" aria-label="搜尋結果"></section>
  <section class="footer" aria-label="送入 AI">
    <label for="question">要問 AI 的問題（選填；只有按下「加入並送出問題」才會送出）</label>
    <textarea id="question" maxlength="4000" placeholder="例如：請比較這些文件對驗收條件的差異。"></textarea>
    <div class="actions">
      <button id="add-context" class="primary" type="button" disabled>加入 AI 上下文</button>
      <button id="add-and-ask" type="button" disabled>加入並送出問題</button>
    </div>
  </section>
</main>
<script>
(() => {
  'use strict';
  const MAX_SELECTIONS = 20;
  const pending = new Map();
  const selected = new Map();
  let nextRequestId = 1;
  let currentPage = 1;
  let pageCount = 1;
  let ready = false;
  let initialSearchStarted = false;
  const queryEl = document.getElementById('query');
  const modeEl = document.getElementById('mode');
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const previousEl = document.getElementById('previous');
  const nextEl = document.getElementById('next');
  const pageLabelEl = document.getElementById('page-label');
  const selectionCountEl = document.getElementById('selection-count');
  const clearEl = document.getElementById('clear');
  const addContextEl = document.getElementById('add-context');
  const addAndAskEl = document.getElementById('add-and-ask');
  const questionEl = document.getElementById('question');

  function request(method, params) {
    const id = nextRequestId++;
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  function errorText(error) {
    if (error && typeof error.message === 'string') return error.message;
    if (error && error.error && typeof error.error.message === 'string') return error.error.message;
    return 'Host 未完成這個要求。';
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function setBusy(busy) {
    document.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = busy; });
    if (!busy) updateControls();
  }

  function updateControls() {
    const count = selected.size;
    selectionCountEl.textContent = '已選 ' + count + ' / ' + MAX_SELECTIONS;
    clearEl.disabled = count === 0;
    addContextEl.disabled = count === 0 || !ready;
    addAndAskEl.disabled = count === 0 || !ready || !questionEl.value.trim();
    previousEl.disabled = !ready || currentPage <= 1;
    nextEl.disabled = !ready || currentPage >= pageCount;
  }

  function clearSelections(message) {
    selected.clear();
    resultsEl.querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = false; });
    updateControls();
    if (message) setStatus(message, false);
  }

  function appendText(parent, className, value) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = value;
    parent.appendChild(element);
  }

  function renderResults(data) {
    resultsEl.replaceChildren();
    currentPage = Number(data.page) || 1;
    pageCount = Number(data.pageCount) || 1;
    const total = Number(data.total) || 0;
    pageLabelEl.textContent = '第 ' + currentPage + ' / ' + pageCount + ' 頁，共 ' + total + (data.totalRelation === 'gte' ? ' 筆以上' : ' 筆');
    const items = Array.isArray(data.results) ? data.results : [];
    if (!items.length) appendText(resultsEl, 'meta', '沒有符合的文件。');
    items.forEach(item => {
      const card = document.createElement('label');
      card.className = 'result';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(String(item.reference));
      box.setAttribute('aria-label', '選取 ' + String(item.path || item.reference));
      const body = document.createElement('div');
      appendText(body, 'path', String(item.path || ''));
      const details = [String(item.reference || ''), String(item.extension || ''), String(item.location || ''), String(item.reason || '')].filter(Boolean).join(' · ');
      appendText(body, 'meta', details);
      appendText(body, 'snippet', String(item.snippet || ''));
      box.addEventListener('change', () => {
        const reference = String(item.reference || '');
        if (box.checked && !selected.has(reference) && selected.size >= MAX_SELECTIONS) {
          box.checked = false;
          setStatus('一次最多選取 20 份文件。', true);
          return;
        }
        if (box.checked) selected.set(reference, { query: String(data.query || ''), reference });
        else selected.delete(reference);
        updateControls();
      });
      card.append(box, body);
      resultsEl.appendChild(card);
    });
    updateControls();
  }

  async function callTool(name, args) {
    const result = await request('tools/call', { name, arguments: args });
    if (result && result.isError) {
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map(item => item && item.type === 'text' ? item.text : '').filter(Boolean).join('\n');
      throw new Error(text || 'Seekah 工具回報錯誤。');
    }
    return result || {};
  }

  async function searchPage(page) {
    const query = queryEl.value.trim();
    if (!query) { setStatus('請先輸入搜尋文字。', true); return; }
    initialSearchStarted = true;
    setBusy(true);
    setStatus('正在搜尋本機索引…', false);
    try {
      const result = await callTool('search_documents', { query, mode: modeEl.value, page, pageSize: 20 });
      if (!result.structuredContent) throw new Error('Host 沒有回傳結構化搜尋結果。');
      renderResults(result.structuredContent);
      setStatus('搜尋完成。勾選要交給 AI 的文件片段。', false);
    } catch (error) {
      setStatus(errorText(error), true);
    } finally {
      setBusy(false);
    }
  }

  function maybeSearchInitialQuery() {
    if (!ready || initialSearchStarted || !queryEl.value.trim()) return;
    initialSearchStarted = true;
    void searchPage(1);
  }

  async function prepareAndUpdate() {
    if (!selected.size) throw new Error('請先勾選至少一份文件。');
    const result = await callTool('prepare_context', { selections: Array.from(selected.values()), mode: modeEl.value, passages: 3 });
    const content = Array.isArray(result.content) ? result.content : [];
    const markdown = content.map(item => item && item.type === 'text' ? item.text : '').filter(Boolean).join('\n');
    if (!markdown) throw new Error('沒有可加入的已選上下文。');
    await request('ui/update-model-context', {
      content: [{ type: 'text', text: markdown }],
      structuredContent: result.structuredContent || { selectedCount: selected.size }
    });
    return selected.size;
  }

  async function addContext(andAsk) {
    if (andAsk && !questionEl.value.trim()) { setStatus('請先填寫要問 AI 的問題。', true); return; }
    setBusy(true);
    setStatus('正在重新驗證並建立已選上下文…', false);
    try {
      const count = await prepareAndUpdate();
      if (andAsk) {
        await request('ui/message', { role: 'user', content: [{ type: 'text', text: questionEl.value.trim() }] });
        setStatus('已加入 ' + count + ' 份文件片段並送出問題。', false);
      } else {
        setStatus('已加入 ' + count + ' 份文件片段；下一則訊息可直接使用。', false);
      }
    } catch (error) {
      setStatus(errorText(error), true);
    } finally {
      setBusy(false);
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(message.error);
      else task.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-input') {
      const args = message.params && message.params.arguments ? message.params.arguments : {};
      if (typeof args.query === 'string') queryEl.value = args.query;
      if (args.mode === 'all-terms' || args.mode === 'phrase') modeEl.value = args.mode;
      maybeSearchInitialQuery();
    }
    if (message.method === 'ui/notifications/tool-result') {
      const data = message.params && message.params.structuredContent;
      if (data && typeof data.query === 'string') queryEl.value = data.query;
      if (data && (data.mode === 'phrase' || data.mode === 'all-terms')) modeEl.value = data.mode;
      maybeSearchInitialQuery();
    }
    if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
      window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    }
  }, { passive: true });

  document.getElementById('search-form').addEventListener('submit', event => { event.preventDefault(); void searchPage(1); });
  previousEl.addEventListener('click', () => { void searchPage(currentPage - 1); });
  nextEl.addEventListener('click', () => { void searchPage(currentPage + 1); });
  clearEl.addEventListener('click', () => clearSelections('已清空選取。'));
  modeEl.addEventListener('change', () => {
    clearSelections('搜尋模式已變更，既有選取已清空；請重新搜尋。');
    resultsEl.replaceChildren();
    currentPage = 1;
    pageCount = 1;
    pageLabelEl.textContent = '模式已變更，請重新搜尋';
    updateControls();
  });
  questionEl.addEventListener('input', updateControls);
  addContextEl.addEventListener('click', () => { void addContext(false); });
  addAndAskEl.addEventListener('click', () => { void addContext(true); });

  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'localdocsearch-search-app', version: '${productVersion}' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
  }).then(() => {
    ready = true;
    notify('ui/notifications/initialized', {});
    setStatus('已連接。請輸入文字搜尋本機索引。', false);
    updateControls();
    maybeSearchInitialQuery();
  }).catch(error => setStatus('無法初始化 MCP App：' + errorText(error), true));
})();
</script>
</body>
</html>`;
