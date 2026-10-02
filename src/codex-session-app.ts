export function codexSessionHtml(nonce: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex 工作階段 · Seekah</title>
<style nonce="${nonce}">
:root { color-scheme:light; --brand:#145c4f; --brand-soft:#dcebe6; --canvas:#f2f4f3; --paper:#fff; --ink:#202825; --muted:#68756f; --line:#d7ddda; --danger:#b34239; --warning:#ad6b20; --shadow:0 2px 9px rgba(25,41,35,.09); }
* { box-sizing:border-box; }
html,body { width:100%; min-width:760px; min-height:100%; margin:0; background:var(--canvas); color:var(--ink); font:14px/1.45 "Segoe UI", "Noto Sans TC", sans-serif; }
button { font:inherit; cursor:pointer; }
button:focus-visible, a:focus-visible { outline:3px solid #e5ae36; outline-offset:1px; }
.app { min-height:100vh; }
.header { display:flex; align-items:center; gap:18px; padding:18px 26px; border-bottom:1px solid #0e473d; background:var(--brand); color:#fff; }
.header-copy { min-width:0; flex:1; }
.header h1 { margin:0; font:700 23px/1.1 Georgia,serif; }
.header p { margin:5px 0 0; color:#c5d9d2; font-size:12px; }
.header-actions { display:flex; align-items:center; gap:8px; }
.btn { min-height:34px; padding:7px 11px; border:1px solid var(--line); border-radius:4px; background:var(--paper); color:var(--ink); text-decoration:none; }
.btn:hover { border-color:#89a79d; background:#f3f8f6; }
.btn.primary { border-color:#fff; background:#fff; color:#0f493f; font-weight:700; }
.btn.link { border-color:transparent; background:transparent; color:#e6f0ec; }
.main { display:grid; gap:16px; max-width:1700px; margin:0 auto; padding:22px 26px 42px; }
.toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:9px; padding:13px 15px; border:1px solid var(--line); border-radius:5px; background:var(--paper); box-shadow:var(--shadow); }
.toolbar .status { margin-left:auto; color:var(--muted); font-size:12px; }
.toolbar .status.error { color:var(--danger); }
.summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.card { min-width:0; padding:14px 16px; border:1px solid var(--line); border-radius:5px; background:var(--paper); box-shadow:var(--shadow); }
.card-label { color:var(--muted); font-size:11px; }
.card-value { margin-top:4px; color:var(--ink); font-size:18px; font-variant-numeric:tabular-nums; }
.workspace { display:grid; grid-template-columns:minmax(300px,.78fr) minmax(460px,1.5fr); gap:16px; min-height:560px; }
.panel { min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:5px; background:var(--paper); box-shadow:var(--shadow); }
.panel-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:15px 17px; border-bottom:1px solid var(--line); }
.panel-head h2 { margin:0; font-size:16px; }
.panel-head p { margin:4px 0 0; color:var(--muted); font-size:12px; }
.session-list { max-height:calc(100vh - 310px); min-height:500px; overflow:auto; }
.session-row { width:100%; display:block; padding:13px 15px; border:0; border-bottom:1px solid #e7ebe9; background:transparent; color:var(--ink); text-align:left; }
.session-row:hover, .session-row.selected { background:var(--brand-soft); }
.session-row .id { display:block; overflow-wrap:anywhere; font-weight:700; }
.session-row .meta { display:block; margin-top:4px; color:var(--muted); font-size:11px; }
.empty { padding:60px 20px; color:var(--muted); text-align:center; }
.detail { min-width:0; overflow:auto; padding:16px 18px 26px; }
.detail-empty { color:var(--muted); }
.detail-title { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
.detail-title h2 { min-width:0; margin:0; font-size:17px; overflow-wrap:anywhere; }
.badge { display:inline-block; flex:0 0 auto; padding:3px 7px; border-radius:3px; background:var(--brand-soft); color:var(--brand); font-size:11px; font-weight:700; }
.badge.warning { background:#fff1d9; color:var(--warning); }
.detail-meta { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-bottom:16px; }
.detail-meta div { min-width:0; padding:9px 10px; border:1px solid var(--line); background:#f8faf9; }
.detail-meta strong { display:block; margin-bottom:3px; color:var(--muted); font-size:10px; }
.detail-meta span { display:block; overflow-wrap:anywhere; }
.detail-section { margin-top:18px; }
.detail-section h3 { margin:0 0 7px; font-size:13px; }
.event-row, .reference-row { display:grid; grid-template-columns:minmax(150px,1fr) 80px minmax(0,2fr); gap:9px; align-items:start; padding:7px 0; border-bottom:1px solid #edf0ee; font-size:12px; }
.event-row:last-child, .reference-row:last-child { border-bottom:0; }
.reference-row { grid-template-columns:minmax(0,1.8fr) 120px minmax(130px,1fr); }
.reference-path { overflow-wrap:anywhere; font-family:"Cascadia Mono",Consolas,monospace; }
.reference-meta { color:var(--muted); }
.reference-actions { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:6px; }
.reference-actions .btn { min-height:28px; padding:4px 7px; font-size:11px; }
.reference-actions select { min-height:28px; max-width:160px; border:1px solid var(--line); border-radius:4px; background:var(--paper); color:var(--ink); font-size:11px; }
.low-reference-details { margin-top:10px; padding:8px 10px; border:1px solid var(--line); background:#f8faf9; }
.low-reference-details summary { cursor:pointer; color:var(--muted); font-size:12px; }
.low-reference-details .reference-row:last-child { border-bottom:0; }
.mono { font-family:"Cascadia Mono",Consolas,monospace; font-variant-numeric:tabular-nums; }
.note { color:var(--muted); font-size:12px; }
@media (max-width:1050px) { html,body { min-width:0; } .workspace { grid-template-columns:1fr; } .session-list { max-height:360px; min-height:180px; } .summary { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="app">
<header class="header">
  <div class="header-copy"><h1>Codex 工作階段</h1><p>唯讀解析本機 rollout metadata；只顯示事件統計、絕對路徑與來源分類，不顯示對話內容。</p></div>
  <div class="header-actions"><a id="back" class="btn link" href="/">← 回到工作台</a><button id="refresh" class="btn primary" type="button">重新整理</button></div>
</header>
<main class="main">
  <section class="toolbar" aria-label="Codex 工作階段工具列"><span class="note">來源：可設定 Codex home 的 sessions/rollout-*.jsonl；不讀取 history、attachments 或 SQLite。</span><span id="status-message" class="status" role="status" aria-live="polite">讀取中…</span></section>
  <section class="summary" aria-label="Codex 摘要">
    <div class="card"><div class="card-label">工作階段</div><div id="summary-sessions" class="card-value">—</div></div>
    <div class="card"><div class="card-label">抽取 reference</div><div id="summary-references" class="card-value">—</div></div>
    <div class="card"><div class="card-label">已在 Seekah 索引</div><div id="summary-indexed" class="card-value">—</div></div>
  </section>
  <section class="workspace">
    <section class="panel"><div class="panel-head"><div><h2>工作階段清單</h2><p>點選工作階段查看 path reference。</p></div></div><div id="session-list" class="session-list"></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Reference 詳細資料</h2><p>只呈現路徑、來源、信心與索引狀態。</p></div></div><div id="session-detail" class="detail"><div class="detail-empty">尚未選取工作階段。</div></div></section>
  </section>
  <p class="note">此頁不執行 Codex 工作階段或開啟附件；已索引 reference 可釘選或加入分類，右側上下文欄仍由工作台目前的選取流程管理。</p>
</main>
</div>
<script nonce="${nonce}">
(() => {
  "use strict";
  const state = { sessions: [], selected: "", loading: false, libraryGroups: [] };
  const $ = id => document.getElementById(id);
  function text(value) { return value === null || value === undefined ? "" : String(value); }
  function make(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
  function token() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; } }
  function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? text(value) : new Intl.DateTimeFormat("zh-TW", { dateStyle:"short", timeStyle:"medium", hour12:false }).format(date); }
  function sourceLabel(value) { return ({ "seekah-prompt":"Seekah prompt", "user-provided":"使用者提供", "seekah-mcp":"Seekah MCP", "codex-tool":"Codex tool" })[value] || text(value); }
  function actionButton(label, action) { const node = make("button", "btn", label); node.type = "button"; node.addEventListener("click", event => { event.stopPropagation(); void action(); }); return node; }
  async function request(pathname, options = {}) {
    const headers = { "X-LocalDocSearch-Token": token(), ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
    const response = await fetch(pathname, { ...options, headers, cache: "no-store" });
    let data = null;
    try { data = await response.json(); } catch { /* response is not JSON */ }
    if (!response.ok) throw new Error(data && data.error ? data.error : "Codex 工作階段讀取失敗。");
    return data;
  }
  function renderSummary() {
    const references = state.sessions.reduce((total, session) => total + Number(session.referenceCount || 0), 0);
    $("summary-sessions").textContent = String(state.sessions.length);
    $("summary-references").textContent = String(references);
    $("summary-indexed").textContent = "詳細資料載入後顯示";
  }
  function renderList() {
    const list = $("session-list");
    list.replaceChildren();
    if (!state.sessions.length) { list.append(make("div", "empty", "目前沒有可解析的 Codex rollout。")); return; }
    if (!state.sessions.some(session => session.id === state.selected)) state.selected = state.sessions[0].id;
    for (const session of state.sessions) {
      const row = make("button", "session-row" + (session.id === state.selected ? " selected" : ""));
      row.type = "button";
      row.addEventListener("click", () => { state.selected = session.id; renderList(); void loadDetail(session.id); });
      row.append(make("span", "id", session.id));
      const lowCount = Number(session.lowReferenceCount || 0);
      row.append(make("span", "meta", text(session.cwd || "無 cwd") + " · " + String(session.visibleReferenceCount ?? session.referenceCount ?? 0) + " refs"
        + (lowCount ? " · " + lowCount + " 低信心" : "") + " · " + formatDate(session.lastEventAt || session.startedAt)));
      list.append(row);
    }
  }
  function metaGrid(items) {
    const meta = make("div", "detail-meta");
    for (const item of items) { const cell = make("div"); cell.append(make("strong", "", item[0]), make("span", "", text(item[1]))); meta.append(cell); }
    return meta;
  }
  function libraryPayload(reference) {
    if (!reference || !reference.indexed || typeof reference.seekahReference !== "string" || !reference.seekahReference) return null;
    const pathValue = typeof reference.indexedPath === "string" && reference.indexedPath ? reference.indexedPath : reference.path;
    const name = pathValue.split(/[\\\\/]/u).filter(Boolean).pop() || pathValue;
    return { path: pathValue, reference: reference.seekahReference, name };
  }
  async function loadLibraryGroups() {
    try {
      const data = await request("/api/library/groups");
      state.libraryGroups = Array.isArray(data && data.groups) ? data.groups : [];
    } catch {
      state.libraryGroups = [];
    }
  }
  async function pinReference(reference) {
    const body = libraryPayload(reference);
    if (!body) return;
    try {
      await request("/api/library/pinned", { method: "PUT", body: JSON.stringify(body) });
      $("status-message").textContent = "已釘選文件。";
    } catch (error) {
      $("status-message").textContent = error.message || "釘選操作失敗。";
      $("status-message").className = "status error";
    }
  }
  async function addReferenceToGroup(reference, groupId) {
    const body = libraryPayload(reference);
    if (!body || !groupId) return;
    try {
      await request("/api/library/groups/" + encodeURIComponent(String(groupId)) + "/items", { method: "POST", body: JSON.stringify(body) });
      $("status-message").textContent = "已加入分類。";
    } catch (error) {
      $("status-message").textContent = error.message || "加入分類失敗。";
      $("status-message").className = "status error";
    }
  }
  function referenceRow(reference, allowLibraryActions) {
    const row = make("div", "reference-row");
    const pathCell = make("span", "reference-path", reference.path);
    const sources = Array.isArray(reference.sources) && reference.sources.length ? reference.sources.map(sourceLabel).join("、") : sourceLabel(reference.source);
    const kindLabel = reference.kind === "directory" ? "資料夾" : reference.kind === "file" ? "檔案" : "";
    const sourceCell = make("span", "reference-meta", sources + " · " + text(reference.confidence) + (kindLabel ? " · " + kindLabel : ""));
    const status = (reference.exists ? "磁碟存在" : "磁碟不存在") + " · " + (reference.indexed ? "已在 Seekah 索引" : "未在 Seekah 索引");
    const indexCell = make("span", "reference-meta", status + " · " + String(reference.occurrences || 0) + " 次");
    if (reference.seekahReference) indexCell.append(make("div", "mono", reference.seekahReference));
    if (allowLibraryActions && reference.indexed && reference.seekahReference) {
      const actions = make("div", "reference-actions");
      actions.append(actionButton("釘選", () => pinReference(reference)));
      const select = document.createElement("select");
      select.setAttribute("aria-label", "選擇分類");
      select.append(new Option(state.libraryGroups.length ? "加入分類…" : "尚無分類", ""));
      for (const group of state.libraryGroups) select.append(new Option(group.name, String(group.id)));
      select.addEventListener("click", event => event.stopPropagation());
      actions.append(select, actionButton("加入分類", () => {
        if (!select.value) {
          $("status-message").textContent = "請先在工作台建立分類。";
          return;
        }
        return addReferenceToGroup(reference, select.value);
      }));
      indexCell.append(actions);
    }
    row.append(pathCell, sourceCell, indexCell);
    return row;
  }
  function renderDetail(session) {
    const detail = $("session-detail");
    detail.replaceChildren();
    if (!session) { detail.append(make("div", "detail-empty", "尚未選取工作階段。")); return; }
    const title = make("div", "detail-title");
    title.append(make("h2", "", session.sessionId));
    title.append(make("span", "badge" + (session.parseStatus === "skipped" || session.parseMode !== "structured" ? " warning" : ""), session.parseStatus === "skipped" ? "skipped" : session.parseMode));
    detail.append(title);
    const references = Array.isArray(session.references) ? session.references : [];
    const lowReferences = Array.isArray(session.lowReferences) ? session.lowReferences : [];
    const referenceCount = Number(session.referenceCount ?? references.length + lowReferences.length);
    detail.append(metaGrid([["cwd", session.cwd || "—"], ["開始", formatDate(session.startedAt)], ["最後事件", formatDate(session.lastEventAt)], ["事件數", session.eventCount], ["無效行", session.invalidLineCount], ["reference 數", referenceCount]]));
    const events = make("section", "detail-section");
    events.append(make("h3", "", "事件類型統計"));
    const eventEntries = Object.entries(session.eventTypes || {});
    if (!eventEntries.length) events.append(make("div", "detail-empty", "沒有事件統計。"));
    for (const entry of eventEntries) { const row = make("div", "event-row"); row.append(make("span", "mono", entry[0]), make("span", "mono", entry[1]), make("span", "", "")); events.append(row); }
    detail.append(events);
    const refs = make("section", "detail-section");
    refs.append(make("h3", "", "磁碟存在或已索引的 references"));
    if (!references.length) refs.append(make("div", "detail-empty", "沒有磁碟存在或已索引的 reference。"));
    for (const reference of references) refs.append(referenceRow(reference, true));
    if (lowReferences.length) {
      const low = make("details", "low-reference-details");
      low.append(make("summary", "", "可能已移動或其他電腦的路徑（" + lowReferences.length + "）"));
      const lowList = make("div", "");
      for (const reference of lowReferences) lowList.append(referenceRow(reference, false));
      low.append(lowList);
      refs.append(low);
    }
    detail.append(refs);
  }
  async function loadDetail(id) {
    if (!id) { renderDetail(null); return; }
    try { renderDetail(await request("/api/codex/sessions/" + encodeURIComponent(id) + "/references")); }
    catch (error) { const detail = $("session-detail"); detail.replaceChildren(make("div", "detail-empty", error.message || "工作階段詳細資料讀取失敗。")); }
  }
  async function load() {
    if (state.loading) return;
    state.loading = true;
    $("status-message").textContent = "讀取中…";
    $("status-message").className = "status";
    try {
      const data = await request("/api/codex/sessions");
      state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      await loadLibraryGroups();
      renderSummary(); renderList();
      if (state.selected) await loadDetail(state.selected); else renderDetail(null);
      const indexed = state.selected ? $("session-detail").querySelectorAll(".reference-row") : [];
      $("summary-indexed").textContent = indexed.length ? String([...indexed].filter(row => row.textContent.includes("已在 Seekah 索引")).length) : "0";
      $("status-message").textContent = "已更新 · " + formatDate(new Date().toISOString());
    } catch (error) { $("status-message").textContent = error.message || "Codex 工作階段讀取失敗。"; $("status-message").className = "status error"; }
    finally { state.loading = false; }
  }
  $("back").href = "/#" + encodeURIComponent(token());
  $("refresh").addEventListener("click", () => void load());
  void load();
})();
</script>
</body>
</html>`;
}
