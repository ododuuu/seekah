export function traceHtml(nonce: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>seekah Trace 診斷</title>
<style nonce="${nonce}">
:root { color-scheme: light; --brand:#145c4f; --brand-soft:#dcebe6; --canvas:#f2f4f3; --paper:#fff; --ink:#202825; --muted:#68756f; --line:#d7ddda; --danger:#b34239; --warning:#ad6b20; --shadow:0 2px 9px rgba(25,41,35,.09); }
* { box-sizing:border-box; }
html, body { width:100%; min-width:1000px; min-height:100%; margin:0; background:var(--canvas); color:var(--ink); font:14px/1.45 "Segoe UI", "Noto Sans TC", sans-serif; }
button, select { font:inherit; }
button { cursor:pointer; }
button:disabled { cursor:not-allowed; opacity:.55; }
button:focus-visible, select:focus-visible { outline:3px solid #e5ae36; outline-offset:1px; }
.app { min-height:100vh; }
.header { display:flex; align-items:center; gap:18px; padding:18px 26px; border-bottom:1px solid #0e473d; background:var(--brand); color:#fff; }
.header h1 { margin:0; font:700 23px/1.1 Georgia, serif; }
.header p { margin:5px 0 0; color:#c5d9d2; font-size:12px; }
.header-copy { min-width:0; flex:1; }
.header-actions { display:flex; align-items:center; gap:8px; }
.btn { min-height:34px; padding:7px 11px; border:1px solid var(--line); border-radius:4px; background:var(--paper); color:var(--ink); }
.btn:hover { border-color:#89a79d; background:#f3f8f6; }
.btn.primary { border-color:#fff; background:#fff; color:var(--brand-2, #0f493f); font-weight:700; }
.btn.link { border-color:transparent; background:transparent; color:#e6f0ec; }
.main { display:grid; gap:16px; max-width:1700px; margin:0 auto; padding:22px 26px 42px; }
.toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:9px; padding:13px 15px; border:1px solid var(--line); border-radius:5px; background:var(--paper); box-shadow:var(--shadow); }
.toolbar label { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
.toolbar select { min-height:32px; padding:5px 26px 5px 8px; border:1px solid var(--line); border-radius:4px; background:var(--paper); color:var(--ink); }
.toolbar .status { margin-left:auto; color:var(--muted); font-size:12px; }
.toolbar .status.error { color:var(--danger); }
.summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.card { min-width:0; padding:14px 16px; border:1px solid var(--line); border-radius:5px; background:var(--paper); box-shadow:var(--shadow); }
.card-label { color:var(--muted); font-size:11px; }
.card-value { margin-top:4px; overflow:hidden; color:var(--ink); font-size:18px; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
.card-value.path { font:12px/1.4 "Cascadia Mono", Consolas, monospace; }
.workspace { display:grid; grid-template-columns:minmax(360px, .85fr) minmax(500px, 1.6fr); gap:16px; min-height:550px; }
.panel { min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:5px; background:var(--paper); box-shadow:var(--shadow); }
.panel-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:15px 17px; border-bottom:1px solid var(--line); }
.panel-head h2 { margin:0; font-size:16px; }
.panel-head p { margin:4px 0 0; color:var(--muted); font-size:12px; }
.trace-list { max-height:calc(100vh - 340px); min-height:490px; overflow:auto; }
.trace-row { width:100%; display:grid; grid-template-columns:78px minmax(0,1fr) auto; gap:8px; padding:12px 15px; border:0; border-bottom:1px solid #e7ebe9; background:transparent; color:var(--ink); text-align:left; }
.trace-row:hover, .trace-row.selected { background:var(--brand-soft); }
.trace-row:last-child { border-bottom:0; }
.trace-row .type { color:var(--brand); font-weight:700; }
.trace-row .type.error { color:var(--danger); }
.trace-row .subject { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.trace-row .meta { margin-top:3px; color:var(--muted); font-size:11px; }
.trace-row .duration { color:var(--muted-strong, #56635d); font-variant-numeric:tabular-nums; white-space:nowrap; }
.empty { padding:60px 20px; color:var(--muted); text-align:center; }
.detail { min-width:0; overflow:auto; padding:16px 18px 26px; }
.detail-empty { color:var(--muted); }
.detail-title { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
.detail-title h2 { min-width:0; margin:0; font-size:17px; overflow-wrap:anywhere; }
.badge { display:inline-block; flex:0 0 auto; padding:3px 7px; border-radius:3px; background:var(--brand-soft); color:var(--brand); font-size:11px; font-weight:700; }
.badge.error { background:#f8e5e2; color:var(--danger); }
.detail-meta { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-bottom:16px; }
.detail-meta div { min-width:0; padding:9px 10px; border:1px solid var(--line); background:#f8faf9; }
.detail-meta strong { display:block; margin-bottom:3px; color:var(--muted); font-size:10px; }
.detail-meta span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.detail-section { margin-top:18px; }
.detail-section h3 { margin:0 0 7px; font-size:13px; }
.phase-row, .count-row { display:grid; grid-template-columns:minmax(145px,1fr) 90px minmax(80px,2fr); gap:9px; align-items:center; padding:5px 0; border-bottom:1px solid #edf0ee; font-size:12px; }
.phase-row:last-child, .count-row:last-child { border-bottom:0; }
.phase-bar { height:7px; border-radius:99px; background:var(--brand); }
.mono { font-family:"Cascadia Mono", Consolas, monospace; font-variant-numeric:tabular-nums; }
.raw { max-height:380px; overflow:auto; margin:0; padding:13px; border:1px solid var(--line); background:#f7f9f8; font:11px/1.5 "Cascadia Mono", Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.note { color:var(--muted); font-size:12px; }
@media (max-width:1100px) { html,body { min-width:0; } .workspace { grid-template-columns:1fr; } .trace-list { max-height:390px; min-height:200px; } .summary { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
</head>
<body>
<div class="app">
<header class="header">
  <div class="header-copy"><h1>Trace 診斷</h1><p>搜尋與 answer 的持久化 phase、候選來源、counts、bottleneck 與錯誤紀錄。</p></div>
  <div class="header-actions"><a id="back" class="btn link" href="/">← 回到工作台</a><button id="refresh" class="btn primary" type="button">重新整理</button></div>
</header>
<main class="main">
  <section class="toolbar" aria-label="Trace 篩選">
    <label>類型<select id="type"><option value="">全部</option><option value="search">search</option><option value="answer">answer</option></select></label>
    <label>狀態<select id="status"><option value="">全部</option><option value="success">success</option><option value="error">error</option></select></label>
    <label>筆數<select id="limit"><option value="50">50</option><option value="100" selected>100</option><option value="200">200</option><option value="500">500</option></select></label>
    <span id="status-message" class="status" role="status" aria-live="polite">讀取中…</span>
  </section>
  <section class="summary" aria-label="Trace 摘要">
    <div class="card"><div class="card-label">目前載入事件</div><div id="summary-count" class="card-value">—</div></div>
    <div class="card"><div class="card-label">錯誤事件</div><div id="summary-errors" class="card-value">—</div></div>
    <div class="card"><div class="card-label">目前最慢</div><div id="summary-slowest" class="card-value">—</div></div>
    <div class="card"><div class="card-label">JSONL log</div><div id="summary-path" class="card-value path" title="">—</div></div>
  </section>
  <section class="workspace">
    <section class="panel"><div class="panel-head"><div><h2>最近事件</h2><p>自動每 5 秒重新讀取；新事件會出現在最上方。</p></div></div><div id="trace-list" class="trace-list"></div></section>
    <section class="panel"><div class="panel-head"><div><h2>事件詳細資料</h2><p>點左側事件查看完整 trace JSON。</p></div></div><div id="trace-detail" class="detail"><div class="detail-empty">尚未選取事件。</div></div></section>
  </section>
  <p class="note">log 只寫入本機資料目錄，最多保留 5 個檔案、每個 2 MiB；trace 不包含 API Key、上下文正文或 answer 正文。</p>
</main>
</div>
<script nonce="${nonce}">
(() => {
  "use strict";
  const state = { data: null, selected: "", loading: false };
  const $ = id => document.getElementById(id);
  function token() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; } }
  function text(value) { return value === null || value === undefined ? "" : String(value); }
  function make(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
  function formatMs(value) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(2) + " ms" : "—"; }
  function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? text(value) : new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "medium", hour12: false }).format(date); }
  function subject(trace) { return trace.type === "search" ? (trace.query || "（空查詢）") : (trace.question || "（無問題）"); }
  function primary(trace) { return trace.type === "search" ? text(trace.candidateStrategy || "none") : [trace.provider, trace.model].filter(Boolean).join(" / ") || "尚未選路由"; }
  async function api() {
    const params = new URLSearchParams();
    if ($("type").value) params.set("type", $("type").value);
    if ($("status").value) params.set("status", $("status").value);
    params.set("limit", $("limit").value);
    const response = await fetch("/api/traces?" + params.toString(), { headers: { "X-LocalDocSearch-Token": token() }, cache: "no-store" });
    let data = null;
    try { data = await response.json(); } catch { /* response is not JSON */ }
    if (!response.ok) throw new Error(data && data.error ? data.error : "無法讀取 Trace log。");
    return data;
  }
  function renderSummary(data) {
    const traces = Array.isArray(data.traces) ? data.traces : [];
    const errors = traces.filter(item => item.status === "error").length;
    const slowest = traces.reduce((best, item) => !best || Number(item.durationMs) > Number(best.durationMs) ? item : best, null);
    $("summary-count").textContent = String(traces.length);
    $("summary-errors").textContent = String(errors);
    $("summary-slowest").textContent = slowest ? formatMs(slowest.durationMs) : "—";
    $("summary-path").textContent = text(data.path) || "—";
    $("summary-path").title = text(data.path);
  }
  function renderList(data) {
    const list = $("trace-list");
    list.replaceChildren();
    const traces = Array.isArray(data.traces) ? data.traces : [];
    if (!traces.length) { list.append(make("div", "empty", "目前沒有符合篩選的 Trace。")); return; }
    if (!traces.some(item => item.traceId === state.selected)) state.selected = traces[0].traceId;
    for (const trace of traces) {
      const row = make("button", "trace-row" + (trace.traceId === state.selected ? " selected" : ""));
      row.type = "button";
      row.addEventListener("click", () => { state.selected = trace.traceId; renderList(data); renderDetail(trace); });
      const type = make("span", "type" + (trace.status === "error" ? " error" : ""), trace.type + (trace.status === "error" ? " · error" : ""));
      const body = make("span", "subject", subject(trace));
      body.append(make("span", "meta", formatDate(trace.completedAt) + " · " + primary(trace)));
      row.append(type, body, make("span", "duration", formatMs(trace.durationMs)));
      list.append(row);
    }
  }
  function renderDetail(trace) {
    const detail = $("trace-detail");
    detail.replaceChildren();
    if (!trace) { detail.append(make("div", "detail-empty", "尚未選取事件。")); return; }
    const title = make("div", "detail-title");
    title.append(make("h2", "", subject(trace)), make("span", "badge" + (trace.status === "error" ? " error" : ""), trace.type + " · " + text(trace.status)));
    detail.append(title);
    const meta = make("div", "detail-meta");
    for (const item of [["Trace ID", trace.traceId], ["完成時間", formatDate(trace.completedAt)], ["總耗時", formatMs(trace.durationMs)],
      ["Bottleneck（self）", trace.bottleneck], ["Bottleneck（inclusive）", trace.inclusiveBottleneck || trace.bottleneck],
      ["主要來源", primary(trace)], ["錯誤碼", trace.errorCode || "—"]]) {
      const cell = make("div", "", ""); cell.append(make("strong", "", item[0]), make("span", "", text(item[1]))); meta.append(cell);
    }
    detail.append(meta);
    const phaseSection = make("section", "detail-section", ""); phaseSection.append(make("h3", "", "Phase timing（inclusive / self）"));
    const inclusivePhases = trace.phasesMs || {};
    const selfPhases = trace.phaseSelfMs || {};
    const phaseEntries = Object.entries(inclusivePhases).sort((left, right) => Number(right[1]) - Number(left[1]));
    const maxPhase = Math.max(1, ...phaseEntries.map(item => Number(item[1]) || 0));
    for (const [name, value] of phaseEntries) {
      const row = make("div", "phase-row"); const bar = make("div", "phase-bar", "");
      bar.style.width = String(Math.max(0, Math.min(100, Number(value) / maxPhase * 100))) + "%";
      row.append(make("span", "mono", name), make("span", "mono", formatMs(value) + " / " + formatMs(selfPhases[name] ?? value)), bar);
      phaseSection.append(row);
    }
    detail.append(phaseSection);
    const countSection = make("section", "detail-section", ""); countSection.append(make("h3", "", "Counts"));
    for (const [name, value] of Object.entries(trace.counts || {})) { const row = make("div", "count-row"); row.append(make("span", "mono", name), make("span", "mono", text(value)), make("span", "", "")); countSection.append(row); }
    detail.append(countSection);
    const rawSection = make("section", "detail-section", ""); rawSection.append(make("h3", "", "Raw JSON"), make("pre", "raw", JSON.stringify(trace, null, 2))); detail.append(rawSection);
  }
  async function load() {
    if (state.loading) return;
    state.loading = true;
    $("status-message").textContent = "讀取中…";
    $("status-message").className = "status";
    try {
      const data = await api(); state.data = data; renderSummary(data); renderList(data);
      const selected = (data.traces || []).find(item => item.traceId === state.selected) || (data.traces || [])[0];
      if (selected) { state.selected = selected.traceId; renderList(data); renderDetail(selected); } else renderDetail(null);
      $("status-message").textContent = "已更新 · " + formatDate(new Date().toISOString());
    } catch (error) { $("status-message").textContent = error.message || "Trace log 讀取失敗。"; $("status-message").className = "status error"; }
    finally { state.loading = false; }
  }
  $("back").href = "/#" + encodeURIComponent(token());
  $("refresh").addEventListener("click", () => void load());
  for (const id of ["type", "status", "limit"]) $(id).addEventListener("change", () => { state.selected = ""; void load(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void load(); });
  setInterval(() => { if (!document.hidden) void load(); }, 5000);
  void load();
})();
</script>
</body>
</html>`;
}
