import { formatZeroResultExclusionHint } from "./describe-exclusion.js";
export function workbenchHtml(nonce: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>seekah 本機文件工作台</title>
<style nonce="${nonce}">
/* tokens/base */
:root {
  color-scheme: light dark;
  --brand: #145c4f;
  --brand-2: #0f493f;
  --brand-soft: #dcebe6;
  --canvas: #f2f4f3;
  --paper: #ffffff;
  --sidebar: #f7f8f8;
  --ink: #202825;
  --muted: #68756f;
  --muted-strong: #56635d;
  --line: #d7ddda;
  --line-strong: #bac5bf;
  --danger: #b34239;
  --warning: #ad6b20;
  --shadow: 0 2px 9px rgba(25, 41, 35, 0.09);
  --sidebar-width: 246px;
  --focus: #e1a42a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --brand: #58b69e;
    --brand-2: #8fe0cb;
    --brand-soft: #173d35;
    --canvas: #151b19;
    --paper: #202825;
    --sidebar: #1b2420;
    --ink: #eff7f2;
    --muted: #a5b7af;
    --muted-strong: #c8d5ce;
    --line: #3a4842;
    --line-strong: #5a6b63;
    --danger: #ff9c91;
    --warning: #f0bd69;
  }
}
/* tokens/base */
* { box-sizing: border-box; }
html, body { min-width: 1180px; width: 100%; height: 100%; margin: 0; overflow: hidden; }
body {
  background: var(--canvas);
  color: var(--ink);
  font: 14px/1.45 "Segoe UI", "Noto Sans TC", sans-serif;
}
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .52; }
button:focus-visible, input:focus-visible, select:focus-visible, [tabindex="0"]:focus-visible {
  outline: 3px solid #e5ae36;
  outline-offset: 1px;
}
[hidden] { display: none !important; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
#app { width: 100%; height: 100%; }

/* app shell/topbar/sidebar */
.app-shell {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  grid-template-rows: 58px minmax(0, 1fr);
  overflow: hidden;
}
.topbar {
  grid-column: 1 / -1;
  min-width: 0;
  height: 58px;
  display: grid;
  grid-template-columns: 230px minmax(360px, 760px) minmax(0, 1fr);
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  background: var(--brand);
  color: #fff;
}
.brand {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
  font: 700 21px/1 Georgia, serif;
  letter-spacing: .02em;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255,255,255,.6);
  border-radius: 50%;
  font: 700 16px/1 Georgia, serif;
}
.brand-subtitle {
  margin-left: 8px;
  color: rgba(255,255,255,.7);
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
}
.global-search {
  position: relative;
  min-width: 0;
}
.global-search span {
  position: absolute;
  z-index: 1;
  left: 12px;
  top: 9px;
  color: #b9d1c9;
  font-size: 18px;
  line-height: 1;
}
.global-search input {
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 0 36px;
  border: 1px solid rgba(255,255,255,.32);
  border-radius: 5px;
  outline: 0;
  background: rgba(0,0,0,.09);
  color: #fff;
}
.global-search input::placeholder { color: #b9d1c9; }
.top-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.top-actions .top-button {
  min-height: 34px;
  padding: 7px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #e6f0ec;
}
.top-actions .top-button:hover { background: rgba(255,255,255,.1); color: #fff; }
.top-actions .theme-button { min-width: auto; }
.local-status {
  min-width: 0;
  max-width: 230px;
  margin-left: 2px;
  overflow: hidden;
  color: #c5d9d2;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 50%;
  background: #9de0a8;
  vertical-align: 1px;
}
.sidebar {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 16px 10px 24px;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}
.nav-group {
  margin: 17px 10px 6px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.nav-group:first-child { margin-top: 2px; }
.nav-list, .root-nav-list { display: grid; }
.nav-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  border-radius: 5px;
  padding: 9px 11px;
  background: transparent;
  color: var(--ink);
  text-align: left;
}
.nav-button:hover { background: #ebefed; }
.nav-button[aria-current="page"] {
  background: var(--brand-soft);
  color: var(--brand-2);
  font-weight: 700;
}
.nav-icon {
  width: 18px;
  color: var(--muted);
  text-align: center;
}
.nav-button[aria-current="page"] .nav-icon { color: var(--brand); }
.nav-count {
  margin-left: auto;
  border-radius: 99px;
  padding: 1px 7px;
  background: #e6eae8;
  color: var(--muted-strong);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.nav-count:empty { display: none; }
.nav-button[aria-current="page"] .nav-count { background: #c7dfd6; color: var(--brand-2); }
.root-nav-list .root-path-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-empty {
  padding: 9px 11px;
  color: var(--muted);
  font-size: 12px;
}
.sidebar-footer {
  margin: 24px 10px 0;
  padding: 15px 0 0;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 11px;
}
.sidebar-footer strong { color: var(--ink); }
.sidebar-footer strong::before, .local-status::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: #6ed3a4;
  vertical-align: 1px;
}

/* common controls */
.main {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 24px 26px 55px;
  background: var(--canvas);
}
.page { width: 100%; max-width: none; margin: 0; }
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  margin-bottom: 15px;
}
.page-header h1 {
  margin: 0;
  color: var(--ink);
  font-size: 26px;
  line-height: 1.45;
  letter-spacing: -.025em;
}
.page-header p { margin: 3px 0 0; color: var(--muted); }
.page-header-actions, .button-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}
.button-label { color: var(--muted); font-size: 12px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--paper);
  color: var(--ink);
  white-space: nowrap;
}
.btn:hover:not(:disabled) { background: #f3f6f4; color: var(--ink); }
.btn.primary { border-color: var(--brand); background: var(--brand); color: #fff; font-weight: 700; }
.btn.primary:hover:not(:disabled) { background: var(--brand-2); color: #fff; }
.btn.danger { border-color: var(--danger); color: var(--danger); }
.btn.danger-fill { border-color: var(--danger); background: var(--danger); color: #fff; font-weight: 700; }
.btn.subtle { border-color: transparent; background: transparent; color: var(--muted); }
.btn.small { min-height: 30px; padding: 4px 8px; font-size: 11px; }
.segmented { display: inline-flex; }
.segmented .btn { border-radius: 0; margin-left: -1px; }
.segmented .btn:first-child { margin-left: 0; border-radius: 4px 0 0 4px; }
.segmented .btn:last-child { border-radius: 0 4px 4px 0; }
.segmented .btn[aria-pressed="true"] { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-2); font-weight: 700; }
.status {
  min-height: 24px;
  margin: 10px 0;
  color: var(--muted-strong);
}
.status.ok { color: var(--brand-2); }
.status.warn { color: var(--warning); }
.status.error { color: var(--danger); }
.status[role="status"] { overflow-wrap: anywhere; }
#search-status:not(.error) {
  position: absolute;
  width: 1px;
  height: 1px;
  min-height: 0;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.panel {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--paper);
  box-shadow: var(--shadow);
}
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}
.panel-head h2 { margin: 0; font-size: 16px; }
.panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.empty-state {
  padding: 34px 20px;
  border: 1px dashed var(--line-strong);
  border-radius: 4px;
  background: var(--paper);
  color: var(--muted);
  text-align: center;
}
.empty-state strong { display: block; margin-bottom: 5px; color: var(--ink); }
.path-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "Cascadia Mono", Consolas, monospace;
}

/* documents/list/table */
.scope-bar {
  position: sticky;
  z-index: 4;
  top: -24px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 -6px 18px;
  padding: 13px 6px;
  border: 0;
  background: var(--canvas);
  box-shadow: 0 8px 10px -12px rgba(36,55,47,.8);
}
.document-query {
  min-width: 0;
  flex: 0 1 auto;
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr);
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--paper);
  overflow: hidden;
}
.document-query select {
  border: 0;
  border-right: 1px solid var(--line);
  padding: 0 8px;
  background: #f8faf9;
  color: var(--ink);
}
.document-query input {
  width: 100%;
  min-width: 200px;
  border: 0;
  padding: 0 10px;
  outline: 0;
  background: var(--paper);
  color: var(--ink);
}
.mode-switch {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}
.mode-switch .btn[aria-pressed="false"] { display: none; }
.mode-switch .btn[aria-pressed="true"] {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand-2);
}
.scope-summaries {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  margin: 0;
}
.scope-summary {
  display: inline-flex;
  align-items: center;
  height: 34px;
}
.scope-summary strong { display: none; }
.scope-summary select {
  max-width: 150px;
  height: 34px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 0 24px 0 8px;
  background: var(--paper);
  color: var(--ink);
  font-size: 12px;
}
.filter-reset {
  flex: 0 0 auto;
  border: 0;
  padding: 0 4px;
  background: transparent;
  color: var(--muted-strong);
  text-decoration: underline;
}
.search-submit { display: inline-flex; flex: 0 0 auto; }
.results-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 12px;
}
.results-toolbar > div:first-child { display: flex; align-items: baseline; gap: 8px; }
.results-toolbar strong { font-size: 12px; font-weight: 400; }
.results-toolbar span { color: var(--muted); font-size: 12px; }
.pagination { display: inline-flex; align-items: center; gap: 0; margin-left: auto; }
.pagination .btn { min-width: 30px; min-height: 28px; height: 28px; border-color: var(--line); border-radius: 0; margin-left: -1px; }
.pagination-label { display: grid; min-width: 30px; height: 28px; margin: 0; place-items: center; border: 1px solid var(--brand); background: var(--brand); color: #fff !important; font-size: 12px; }
.result-list {
  display: grid;
  gap: 24px;
  padding: 20px 24px 24px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--paper);
}
.document-row { min-width: 0; max-width: 780px; padding-left: 12px; border-left: 3px solid transparent; }
.document-row.is-selected { border-left-color: var(--brand); }
.document-title {
  max-width: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--brand);
  font-size: 18px;
  font-weight: 650;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}
.document-title.btn:hover:not(:disabled) { background: transparent; color: var(--brand-2); text-decoration: underline; }
.document-path { display: flex; gap: 8px; min-width: 0; margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.document-crumbs { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-format { flex: none; }
.snippet {
  display: -webkit-box;
  margin: 6px 0 0;
  overflow: hidden;
  color: #3d4843;
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.snippet.is-muted { color: var(--muted); }
.snippet mark { padding: 0 1px; background: #f3d889; color: inherit; }

.result-passages-group { min-width: 0; margin-top: 7px; }
.result-passages {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.result-passage {
  display: grid;
  grid-template-columns: minmax(88px, 31%) minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
  padding: 4px 0;
  border-top: 1px solid var(--line);
}
.result-passage-label {
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  -webkit-user-select: none;
  user-select: none;
}
.result-passage-location, .result-passage-terms { display: block; }
.result-passage-terms { color: var(--muted-strong); }
.result-passage-snippet {
  display: -webkit-box;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #3d4843;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.result-passage-snippet mark { padding: 0 1px; background: #f3d889; color: inherit; }
.result-passages-omitted { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.documents-table .result-passages { margin-top: 7px; }
.documents-table .result-passage { grid-template-columns: minmax(72px, 36%) minmax(0, 1fr); gap: 6px; }
.documents-table .result-passage-snippet { font-size: 12px; line-height: 1.4; }

.document-title, .document-title.btn, .table-title, .table-title.btn,
.document-path, .document-crumbs, .snippet, .file-name, .context-item-name, .context-item-meta {
  -webkit-user-select: text;
  user-select: text;
}
.copy-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 5px; }
.copy-action { display: inline-flex; align-items: center; gap: 4px; }
.copy-feedback { min-width: 3.4em; color: var(--brand-2); font-size: 11px; white-space: nowrap; }
.clipboard-fallback { position: fixed; top: 0; left: -10000px; width: 1px; height: 1px; opacity: 0; }
.copy-control.btn { min-height: 24px; padding: 3px 7px; }
.document-actions { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 6px; }
.link-action.btn { min-height: 0; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 12px; }
.link-action.btn:hover:not(:disabled) { background: transparent; color: var(--brand); text-decoration: underline; }
.table-wrap {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--paper);
  box-shadow: var(--shadow);
}
.documents-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.documents-table th {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line-strong);
  background: #edf1ef;
  color: #59665f;
  font-size: 11px;
  font-weight: 700;
  text-align: left;
}
.documents-table td { padding: 10px; border-bottom: 1px solid #e7ebe9; overflow: hidden; text-align: left; text-overflow: ellipsis; vertical-align: middle; white-space: nowrap; }
.documents-table td:nth-child(2) { white-space: normal; }
.documents-table tr:last-child td { border-bottom: 0; }
.documents-table tbody tr:hover, .documents-table tbody tr.is-selected { background: #e8f2ee; }
.documents-table td:first-child, .documents-table th:first-child { width: 42px; text-align: center; }
.documents-table th:first-child { font-size: 0; }
.documents-table th:nth-child(2) { width: 29%; }
.documents-table th:nth-child(4) { width: 11%; }
.documents-table th:nth-child(5) { width: 15%; }
.documents-table th:nth-child(6) { width: 12%; }
.table-title {
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--brand);
  font-weight: 700;
  text-align: left;
  overflow-wrap: anywhere;
}
.table-title:hover { color: var(--brand-2); text-decoration: underline; }
.table-empty { height: 96px; color: var(--muted); text-align: center !important; }
.table-check { width: 18px; height: 18px; accent-color: var(--brand); }
.bulk-bar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding: 11px 13px;
  border: 1px solid #7fa89c;
  background: #eff8f4;
  box-shadow: 0 -5px 20px rgba(31,62,51,.12);
}
.bulk-bar strong { margin-right: auto; color: var(--brand-2); }

/* temporary files */
.drop-zone {
  display: block;
  min-height: 0;
  margin-bottom: 14px;
  padding: 70px;
  border: 1px dashed var(--line-strong);
  border-radius: 0;
  background: var(--paper);
  color: var(--muted);
  text-align: center;
}
.drop-zone.is-dragging { border-color: var(--brand); background: var(--brand-soft); }
.drop-zone strong { display: block; margin-bottom: 5px; color: var(--ink); font-size: 14px; }
.drop-zone small { display: block; max-width: 720px; margin: 0 auto; font-size: 14px; }
.file-list { display: grid; gap: 8px; }
.file-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--line);
  background: var(--paper);
}
.file-row input { width: 18px; height: 18px; accent-color: var(--brand); }
.file-name { font-weight: 700; overflow-wrap: anywhere; }
.file-meta { margin-top: 3px; color: var(--muted); font-size: 12px; }
.file-status { max-width: 300px; color: var(--muted); text-align: right; overflow-wrap: anywhere; }
.file-status.indexed { color: var(--brand-2); }
.file-status.error, .file-status.encrypted { color: var(--danger); }
.file-row-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px 10px; }
.file-row-actions .copy-actions { margin-top: 0; }
.file-status.warn { color: var(--warning); }

/* roots and trash */
.roots-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--line);
  background: var(--paper);
  box-shadow: var(--shadow);
}
.roots-table th, .roots-table td { padding: 12px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
.roots-table th { background: color-mix(in srgb, var(--sidebar) 80%, var(--line)); color: var(--muted-strong); font-size: 11px; font-weight: 700; }
.roots-table tr:last-child td { border-bottom: 0; }
.roots-table th:first-child, .roots-table td:first-child { display: none; }
.roots-table th:nth-child(2) { width: 42%; }
.root-path { font: 12px/1.45 "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
.root-focus-button { padding: 0; border: 0; background: transparent; color: var(--ink); font: inherit; text-align: left; overflow-wrap: anywhere; }
.root-focus-button:hover { color: var(--brand-2); text-decoration: underline; }
.root-state { color: var(--muted-strong); }
.root-state.good { color: var(--brand); font-weight: 650; }
.root-state.good::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #6ed3a4; vertical-align: 1px; }
.root-state.bad { color: var(--danger); }
.root-state.warn { color: var(--warning); }
.root-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.root-selection-toolbar { display: none; }
.root-add { display: none; margin-top: 16px; }
.root-add.has-draft { display: block; }
.root-add-body { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: end; padding: 16px 18px; }
.root-add-field { min-width: 0; }
.root-add-field label { display: block; margin-bottom: 5px; color: var(--muted-strong); font-size: 12px; }
.root-add-field input { width: 100%; height: 38px; padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--sidebar); color: var(--ink); }
.root-instructions { margin: 0; padding: 0 18px 14px; color: var(--muted-strong); font-size: 12px; }
#index-status-message:not(.warn):not(.error), #trash-status-message {
  position: absolute;
  width: 1px;
  height: 1px;
  min-height: 0;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
#trash-page .page-header { margin-bottom: 15px; }
.trash-toolbar { display: none; }
.trash-table, .trash-table tbody { display: block; width: 100%; }
.trash-table thead { display: none; }
.trash-table tr {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 13px;
  align-items: center;
  padding: 15px;
  border: 1px solid var(--line);
  border-bottom: 0;
  background: var(--paper);
}
.trash-table tr:last-child { border-bottom: 1px solid var(--line); }
.trash-table td { display: block; min-width: 0; padding: 0; border: 0; }
.trash-table td:first-child { width: 28px; text-align: left; }
.trash-path h2 { margin: 0; color: var(--ink); font: 600 14px/1.4 "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
.trash-path p { margin: 3px 0 0; color: var(--muted-strong); font-size: 12px; }
.trash-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 7px; }
.roots-table .root-empty-row td { display: table-cell; padding: 70px; color: var(--muted-strong); text-align: center; }
.trash-table .trash-empty-row { display: block; padding: 70px; color: var(--muted-strong); text-align: center; }
.trash-table .trash-empty-row td { width: auto; text-align: center; }

/* context drawer/preview dialog */
.scrim {
  position: fixed;
  z-index: 8;
  inset: 58px 0 0;
  width: 100%;
  border: 0;
  background: rgba(18, 26, 22, .42);
}
.context-drawer {
  position: fixed;
  z-index: 9;
  top: 58px;
  right: 0;
  bottom: 0;
  width: min(390px, calc(100vw - 30px));
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line-strong);
  background: var(--paper);
  box-shadow: -6px 0 22px rgba(25, 41, 35, .16);
}
.context-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--line); }
.context-drawer-head h2 { margin: 0; font-size: 17px; }
.context-drawer-head p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.context-drawer-body { min-height: 0; overflow: auto; padding: 14px 16px; }
.context-section + .context-section { margin-top: 20px; }
.context-section h3 { margin: 0 0 7px; color: var(--muted); font-size: 12px; }
.context-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 9px 0; border-bottom: 1px solid var(--line); }
.context-item:last-child { border-bottom: 0; }
.context-item-name { min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.context-item-meta { margin-top: 3px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.context-item-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.context-drawer-footer { padding: 14px 16px 18px; border-top: 1px solid var(--line); }
.context-drawer-footer .btn { width: 100%; }
.preview-dialog { width: min(920px, calc(100vw - 52px)); }
.settings-dialog { width: min(540px, calc(100vw - 52px)); }
.delete-dialog { width: min(540px, calc(100vw - 52px)); }
dialog {
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid #66746d;
  border-radius: 5px;
  background: var(--paper);
  color: var(--ink);
  box-shadow: 0 24px 70px rgba(0,0,0,.3);
}
dialog::backdrop { background: rgba(19,28,24,.55); }
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 17px 19px; border-bottom: 1px solid var(--line); }
.dialog-head h2 { margin: 0; font-size: 19px; }
.dialog-head p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.dialog-body { padding: 20px; }
.dialog-body > p:first-child { margin-top: 0; color: var(--muted); }
.dialog-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 7px; padding: 13px 19px; border-top: 1px solid var(--line); background: #f6f8f7; }
.setting-toggle-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; color: var(--ink); font-size: 13px; }
.dialog-actions .setting-toggle-row { margin-right: auto; }
.setting-toggle-copy { min-width: 0; display: grid; gap: 3px; }
.setting-toggle-copy strong { font-weight: 650; }
.setting-toggle-state { color: var(--muted); font-size: 11px; }
.setting-switch {
  position: relative;
  flex: none;
  width: 48px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--muted);
  color: transparent;
  transition: background .16s ease, border-color .16s ease;
}
.setting-switch::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--paper);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
  content: "";
  transition: transform .16s ease;
}
.setting-switch[aria-checked="true"] { border-color: var(--brand-2); background: var(--brand); }
.setting-switch[aria-checked="true"]::after { transform: translateX(20px); }
.setting-switch[aria-busy="true"] { background: var(--line-strong); }
.setting-switch[aria-busy="true"]::after { opacity: .7; }
.setting-switch:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.startup-catchup-banner {
  display: grid;
  gap: 8px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid #d49b32;
  border-left: 5px solid #d49b32;
  border-radius: 4px;
  background: #fff7df;
  color: var(--ink);
}
.workbench-open-banner { border-color: #4f8eb5; border-left-color: #4f8eb5; background: #eaf5fb; }
.workbench-open-banner .startup-catchup-warning { color: #2e5c78; }
.startup-catchup-banner h2 { margin: 0; font-size: 16px; }
.startup-catchup-banner p { margin: 0; }
.startup-catchup-warning { color: #815b00; font-size: 12px; font-weight: 650; }
.startup-catchup-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.startup-catchup-status { min-height: 1.2em; }
.startup-catchup-mode-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 190px); align-items: center; gap: 12px; margin-top: 12px; }
.startup-catchup-mode-row label { display: grid; gap: 3px; }
.startup-catchup-mode-row label strong { font-weight: 650; }
.startup-catchup-mode-row select { width: 100%; min-height: 34px; padding: 5px 8px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--paper); color: var(--ink); }
.startup-catchup-mode-status { margin: 5px 0 0; color: var(--muted); font-size: 11px; }
.startup-catchup-mode-help { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
@media (max-width: 520px) {
  .startup-catchup-mode-row { grid-template-columns: 1fr; }
}
@media (prefers-color-scheme: dark) {
  .autoupdate-settings { background: var(--sidebar); }
  .dialog-actions { background: var(--sidebar); }
}
.preview-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; color: var(--muted); font-size: 12px; }
.preview-meta strong { color: var(--ink); }
.preview-text {
  max-height: min(58vh, 560px);
  min-height: 210px;
  overflow: auto;
  margin: 14px 0;
  padding: 16px;
  border: 1px solid var(--line);
  background: var(--sidebar);
  color: var(--ink);
  font: 13px/1.55 "Cascadia Mono", Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.preview-progress { width: 100%; height: 12px; accent-color: var(--brand); }
.preview-status { min-height: 22px; margin: 9px 0 0; color: var(--muted); }
.settings-section + .settings-section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.settings-section h3 { margin: 0 0 8px; font-size: 14px; }
.settings-section p { margin: 0 0 11px; color: var(--muted); font-size: 12px; }
.autoupdate-settings { display: grid; gap: 11px; margin-top: 11px; padding: 12px; border: 1px solid var(--line); background: #f8faf9; }
.autoupdate-settings-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.autoupdate-settings-head strong { font-size: 12px; }
.autoupdate-settings-head .btn { padding: 5px 9px; font-size: 11px; }
.settings-number-row { display: grid; grid-template-columns: minmax(0, 1fr) 118px; align-items: center; gap: 12px; }
.settings-number-row label { display: grid; gap: 2px; font-size: 12px; }
.settings-number-row small, .settings-help { color: var(--muted); font-size: 11px; }
.settings-number-row input { width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--paper); color: var(--ink); font: inherit; }
.settings-help { margin: 0; }
.autoupdate-summary { display: grid; gap: 5px; padding-top: 3px; }
.autoupdate-summary-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; font-size: 11px; }
.autoupdate-summary-row span:first-child { color: var(--muted); }
.autoupdate-summary-row span:last-child { overflow-wrap: anywhere; }
.autoupdate-status { margin: 0; }
.delete-detail { padding: 12px; border: 1px solid var(--line); background: var(--sidebar); white-space: pre-wrap; overflow-wrap: anywhere; }
.delete-warning { margin-top: 12px; color: var(--danger); font-weight: 700; }
.toast {
  position: fixed;
  z-index: 20;
  right: 20px;
  bottom: 20px;
  max-width: min(460px, calc(100vw - 40px));
  padding: 10px 13px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--paper);
  box-shadow: var(--shadow);
  color: var(--ink);
}

/* desktop width adjustments */
@media (max-width: 1320px) {
  :root { --sidebar-width: 220px; }
  .topbar { grid-template-columns: 204px minmax(300px, 1fr) auto; gap: 18px; }
  .scope-bar { gap: 6px; }
  .document-query { flex: 1 1 300px; }
  .document-query select, .scope-summary select { max-width: 126px; }
  .result-passage { grid-template-columns: minmax(76px, 35%) minmax(0, 1fr); gap: 6px; }
  .result-passage-snippet { font-size: 12px; line-height: 1.4; }
}
/* reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
(() => {
  "use strict";
  const MAX = 20;
  const searchClientHeader = (() => {
    try { return crypto.randomUUID(); }
    catch { return "browser-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }
  })();
  const state = {
    route: "documents",
    mode: "phrase",
    sortMode: "relevance",
    searchField: "all",
    rootFilter: "",
    typeFilter: "",
    statusFilter: "",
    queryDraft: "",
    submittedQuery: "",
    data: null,
    searchState: "idle",
    searchMessage: "尚未搜尋。",
    searchKind: "",
    searchSeq: 0,
    searchController: null,
    searchCancelTimer: null,
    searchCancelVisible: false,
    searchElapsedSeconds: 0,
    selected: new Map(),
    imported: new Map(),
    indexStatus: null,
    exclusions: null,
    exclusionPreview: null,
    exclusionPreviewReady: false,
    emptyExplainMessage: "",
    indexNotice: "",
    indexNoticeKind: "",
    statusRefreshBusy: false,
    statusRevision: 0,
    supportedExtensions: [],
    addRootDraft: "",
    selectedRoots: new Set(),
    selectedTrash: new Set(),
    folderPickerBusy: false,
    deleteConfirmation: true,
    deleteConfirmationSaving: false,
    totalMode: "fast",
    totalModeSaving: false,
    counting: false,
    autoupdateEnabled: false,
    autoupdateSaving: false,
    startupCatchupMode: "auto",
    startupCatchupSaving: false,
    startupCatchupPendingMode: "auto",
    startupCatchupActionBusy: false,
    startupCatchupActionFailed: false,
    startupCatchupActionMessage: "",
    startupCatchupDeferred: false,
    startupCatchupDeferredInstanceId: "",
    workbenchOpenMode: "ask",
    workbenchOpenSaving: false,
    workbenchOpenPendingMode: "ask",
    workbenchOpenActionBusy: false,
    workbenchOpenActionFailed: false,
    workbenchOpenActionMessage: "",
    workbenchOpenDismissed: false,
    workbenchOpenEvaluationDone: false,
    workbenchOpenStatusStale: false,
    autoupdateStartupSupported: false,
    autoupdateStartupEnabled: false,
    autoupdateStartupSaving: false,
    autoupdateDebounceMs: 1500,
    autoupdateReconcileMs: 21600000,
    preview: null,
    previewSeq: 0,
    focusRoot: "",
    focusAfterDrawer: null,
    dialogTrigger: null,
  };

  const $ = id => document.getElementById(id);
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className, action) {
    const node = make("button", "btn" + (className ? " " + className : ""), text);
    node.type = "button";
    if (action) node.addEventListener("click", action);
    return node;
  }
  async function copyText(value) {
    const text = escapeText(value);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {}
    }
    const textarea = make("textarea", "clipboard-fallback", "");
    textarea.value = text;
    textarea.setAttribute("aria-hidden", "true");
    textarea.tabIndex = -1;
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch {}
    textarea.remove();
    if (!copied) throw new Error("剪貼簿複製失敗，請改用滑鼠選取後按 Ctrl+C。");
  }
  function documentPathValue(item) {
    const value = item && item.path !== undefined ? item.path : item && item.filename;
    return escapeText(value);
  }
  function documentFilenameValue(item) {
    const explicit = escapeText(item && item.filename);
    if (explicit) return explicit;
    const full = documentPathValue(item);
    return full.split(/[\\\\/]/u).pop() || full;
  }
  function hasSelectionWithin(element) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.toString()) return false;
    const range = selection.getRangeAt(0);
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return Boolean(anchor && focus
      && element.contains(range.commonAncestorContainer)
      && element.contains(anchor)
      && element.contains(focus));
  }
  function openDocumentTitle(item, event) {
    const element = event && event.currentTarget;
    if (element instanceof Element && hasSelectionWithin(element)) return;
    void documentAction(item, "open");
  }
  function copyControl(label, value) {
    const feedback = make("span", "copy-feedback", "");
    feedback.setAttribute("aria-live", "polite");
    feedback.setAttribute("aria-atomic", "true");
    let timer = 0;
    const control = button(label, "small copy-control", async () => {
      try {
        await copyText(value);
        feedback.textContent = "已複製";
        clearTimeout(timer);
        timer = setTimeout(() => { feedback.textContent = ""; }, 1800);
      } catch (error) {
        feedback.textContent = "複製失敗";
        showToast(error.message || "複製失敗，請改用滑鼠選取後按 Ctrl+C。");
      }
    });
    const wrapper = make("span", "copy-action", "");
    wrapper.append(control, feedback);
    return wrapper;
  }
  function resultCopyActions(item) {
    const actions = make("div", "copy-actions", "");
    actions.append(copyControl("複製路徑", documentPathValue(item)), copyControl("複製檔名", documentFilenameValue(item)));
    return actions;
  }
  function navButton(action) {
    const node = make("button", "nav-button", "");
    node.type = "button";
    if (action) node.addEventListener("click", action);
    return node;
  }
  function iconButton(text, label, action) {
    const node = make("button", "btn", text);
    node.type = "button";
    node.setAttribute("aria-label", label);
    if (action) node.addEventListener("click", action);
    return node;
  }
  function setStatus(id, text, kind) {
    const node = $(id);
    if (!node) return;
    node.textContent = text || "";
    node.className = "status" + (kind ? " " + kind : "");
  }
  function syncSettingSwitch(id, enabled, options = {}) {
    const node = $(id);
    if (!node) return;
    const busy = options.busy === true;
    node.setAttribute("aria-checked", String(Boolean(enabled)));
    node.setAttribute("aria-busy", String(busy));
    node.disabled = busy || options.disabled === true;
    const stateText = $(id + "-state");
    if (stateText) stateText.textContent = busy ? "處理中…" : enabled ? "已開啟" : "已關閉";
  }
  function settingSwitch(id, labelId, labelText, save) {
    const row = make("div", "setting-toggle-row", "");
    const copy = make("div", "setting-toggle-copy", "");
    const label = make("strong", "", labelText);
    label.id = labelId;
    const stateText = make("span", "setting-toggle-state", "已關閉");
    stateText.id = id + "-state";
    stateText.setAttribute("role", "status");
    stateText.setAttribute("aria-live", "polite");
    copy.append(label, stateText);
    const node = make("button", "setting-switch", "");
    node.id = id;
    node.type = "button";
    node.setAttribute("role", "switch");
    node.setAttribute("aria-checked", "false");
    node.setAttribute("aria-busy", "false");
    node.setAttribute("aria-labelledby", labelId);
    node.setAttribute("aria-describedby", stateText.id);
    node.addEventListener("click", () => { if (!node.disabled) void save(node.getAttribute("aria-checked") !== "true"); });
    node.addEventListener("keydown", event => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (!node.disabled) node.click();
    });
    row.append(copy, node);
    return row;
  }
  function preserveSettingResponses(indexStatus, revision) {
    if (revision === state.statusRevision) return indexStatus;
    const current = state.indexStatus || {};
    return {
      ...indexStatus,
      ...(current.deleteConfirmation !== undefined ? { deleteConfirmation: current.deleteConfirmation } : {}),
      ...(current.totalMode !== undefined ? { totalMode: current.totalMode } : {}),
      ...(current.startupCatchupMode !== undefined ? { startupCatchupMode: current.startupCatchupMode } : {}),
      ...(current.workbenchOpenMode !== undefined ? { workbenchOpenMode: current.workbenchOpenMode } : {}),
      ...(current.autoupdate ? { autoupdate: current.autoupdate } : {}),
      ...(current.autoupdateStartup ? { autoupdateStartup: current.autoupdateStartup } : {}),
    };
  }
  function validStartupCatchupMode(value) {
    return value === "ask" || value === "auto" || value === "off";
  }
  function validWorkbenchOpenMode(value) {
    return value === "ask" || value === "auto" || value === "off";
  }
  function workbenchOpenModeLabel(mode) {
    return mode === "ask" ? "開啟時提醒" : mode === "auto" ? "開啟時自動補捉" : "不主動處理";
  }
  function workbenchOpenLive() {
    const autoupdate = state.indexStatus && state.indexStatus.autoupdate;
    return autoupdate && autoupdate.enabled === true && autoupdate.live ? autoupdate.live : null;
  }
  function workbenchOpenIsRunning() {
    const live = workbenchOpenLive();
    return Boolean(live && (live.mode === "background" || live.mode === "foreground"));
  }
  function workbenchOpenHasVolumeRoot() {
    const roots = state.indexStatus && Array.isArray(state.indexStatus.roots) ? state.indexStatus.roots : [];
    return roots.some(root => {
      const value = typeof root === "string" ? root : root && typeof root.path === "string" ? root.path : "";
      return /^[A-Za-z]:[\\\\/]*$/u.test(value);
    });
  }
  function workbenchOpenLastSuccessfulSync() {
    const roots = state.indexStatus && Array.isArray(state.indexStatus.roots) ? state.indexStatus.roots : [];
    const values = roots.map(root => root && typeof root.lastSuccessfulSync === "string" ? root.lastSuccessfulSync : "")
      .filter(value => value);
    const latest = values.sort().pop();
    return latest ? autoupdateTimeText(latest) : "尚無成功同步記錄";
  }
  function workbenchOpenEligible() {
    const status = state.indexStatus;
    return Boolean(status && status.state === "available"
      && (!status.autoupdate || status.autoupdate.available !== false)
      && Array.isArray(status.roots) && status.roots.length > 0
      && !isIndexing() && !workbenchOpenIsRunning());
  }
  function startupCatchupModeLabel(mode) {
    return mode === "ask" ? "詢問後補捉" : mode === "off" ? "不補捉" : "自動補捉";
  }
  function startupCatchupStateLabel(stateValue) {
    return ({ none: "未啟動", pending: "等待決定", running: "執行中", complete: "已完成", skipped: "已略過" })[stateValue] || "未知";
  }
  function startupCatchupLive() {
    const autoupdate = state.indexStatus && state.indexStatus.autoupdate;
    return autoupdate && autoupdate.live && autoupdate.live.startupCatchup
      ? autoupdate.live.startupCatchup : null;
  }
  function startupCatchupHasVolumeRoot(live) {
    const roots = live && Array.isArray(live.roots) ? live.roots : [];
    return roots.some(root => {
      const value = typeof root === "string" ? root : root && typeof root.path === "string" ? root.path : "";
      return /^[A-Za-z]:[\\\\/]*$/u.test(value);
    });
  }
  function applyAutoupdateResponse(data) {
    if (!data || !data.autoupdate || typeof data.autoupdate.enabled !== "boolean") return false;
    state.workbenchOpenStatusStale = false;
    state.autoupdateEnabled = data.autoupdate.enabled;
    const responseMode = data.startupCatchupMode
      ?? (data.autoupdate.live && data.autoupdate.live.startupCatchup && data.autoupdate.live.startupCatchup.mode);
    const responseWorkbenchMode = data.workbenchOpenMode;
    state.indexStatus = {
      ...(state.indexStatus || {}),
      autoupdate: data.autoupdate,
      ...(data.autoupdateSettings ? { autoupdateSettings: data.autoupdateSettings } : {}),
      ...(validStartupCatchupMode(responseMode) ? { startupCatchupMode: responseMode } : {}),
      ...(validWorkbenchOpenMode(responseWorkbenchMode) ? { workbenchOpenMode: responseWorkbenchMode } : {}),
    };
    if (!state.startupCatchupSaving && validStartupCatchupMode(responseMode)) state.startupCatchupMode = responseMode;
    if (!state.workbenchOpenSaving && validWorkbenchOpenMode(responseWorkbenchMode)) state.workbenchOpenMode = responseWorkbenchMode;
    syncSettingSwitch("settings-autoupdate", state.autoupdateEnabled, { busy: state.autoupdateSaving });
    renderAutoupdateSummary();
    return true;
  }
  function applyAutoupdateStartupResponse(data) {
    if (!data || !data.autoupdateStartup || typeof data.autoupdateStartup.enabled !== "boolean") return false;
    state.autoupdateStartupEnabled = data.autoupdateStartup.enabled;
    state.indexStatus = { ...(state.indexStatus || {}), autoupdateStartup: data.autoupdateStartup };
    syncSettingSwitch("settings-autoupdate-startup", state.autoupdateStartupEnabled, {
      busy: state.autoupdateStartupSaving,
      disabled: !state.autoupdateStartupSupported,
    });
    return true;
  }
  function setNotice(text, kind) {
    state.indexNotice = text || "";
    state.indexNoticeKind = kind || "";
    setStatus("index-status-message", state.indexNotice, state.indexNoticeKind);
  }
  function showToast(text) {
    const node = $("toast");
    node.textContent = text;
    node.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { node.hidden = true; }, 2800);
  }
  function token() {
    try { return decodeURIComponent(location.hash.slice(1)); }
    catch { return ""; }
  }
  async function api(path, init) {
    const options = init ? { ...init } : {};
    const headers = new Headers(options.headers || {});
    headers.set("X-LocalDocSearch-Token", token());
    if (options.body && !(options.body instanceof Blob) && typeof options.body !== "string") {
      headers.set("content-type", "application/json");
      options.body = JSON.stringify(options.body);
    }
    options.headers = headers;
    const response = await fetch(path, options);
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const message = data && typeof data.error === "string" ? data.error : "本機服務拒絕要求。";
      const error = new Error(message);
      error.status = response.status;
      if (data && typeof data.code === "string") error.code = data.code;
      throw error;
    }
    return data;
  }
  function clearSearchCancellation() {
    clearInterval(state.searchCancelTimer);
    state.searchCancelTimer = null;
    state.searchCancelVisible = false;
    state.searchElapsedSeconds = 0;
  }
  function cancelSearch() {
    if (state.searchController) state.searchController.abort();
  }
  function searchRequestOptions(controller, body) {
    return {
      method: "POST",
      body,
      signal: controller.signal,
      headers: { "X-LocalDocSearch-Client": searchClientHeader },
    };
  }
  function isCancelledSearch(error, controller) {
    return controller.signal.aborted || error && (error.name === "AbortError" || error.status === 499 || error.code === "SEARCH_CANCELLED");
  }
  function restoreCancelledSearch(seq, controller, previous) {
    if (seq !== state.searchSeq || state.searchController !== controller) return;
    clearSearchCancellation();
    state.searchController = null;
    state.data = previous.data;
    state.submittedQuery = previous.submittedQuery;
    state.queryDraft = previous.queryDraft;
    state.searchState = state.data ? "success" : "idle";
    state.searchMessage = "搜尋已取消";
    state.searchKind = "warn";
    state.counting = false;
    syncQueryInputs();
    renderDocuments();
    const restoredQuery = previous.queryDraft;
    if ($("document-query")) $("document-query").value = restoredQuery;
    if ($("global-query")) $("global-query").value = restoredQuery;
  }
  function selectedCount() {
    let count = state.selected.size;
    for (const item of state.imported.values()) if (item.selected) count++;
    return count;
  }
  function selectedTemporaryCount() {
    let count = 0;
    for (const item of state.imported.values()) if (item.selected) count++;
    return count;
  }
  function isIndexing() {
    return Boolean(state.indexOperationBusy || state.indexStatus && state.indexStatus.indexing
      && ["running", "stopping"].includes(state.indexStatus.indexing.state));
  }
  function documentTotal() {
    const counts = state.indexStatus && state.indexStatus.counts;
    if (!counts) return null;
    return Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  }
  function syncQueryInputs() {
    const global = $("global-query");
    const page = $("document-query");
    if (global && global.value !== state.queryDraft) global.value = state.queryDraft;
    if (page && page.value !== state.queryDraft) page.value = state.queryDraft;
  }
  function updateNav() {
    const currentRoute = state.route;
    document.querySelectorAll("[data-route]").forEach(node => {
      if (node instanceof HTMLButtonElement) {
        const rootItem = Boolean(node.dataset.rootPath);
        const current = rootItem
          ? currentRoute === "roots" && state.focusRoot === node.dataset.rootPath
          : node.dataset.route === currentRoute;
        if (current) node.setAttribute("aria-current", "page");
        else node.removeAttribute("aria-current");
      }
    });
    const title = $("main-title");
    if (title) title.textContent = state.route === "documents" ? "文件" : state.route === "temporary" ? "臨時文件" : state.route === "roots" ? "根目錄" : state.route === "trash" ? "垃圾桶" : "";
  }
  function switchPageVisibility() {
    document.querySelectorAll("[data-page]").forEach(node => { node.hidden = node.dataset.page !== state.route; });
    updateNav();
  }
  function navigate(route, focusRoot) {
    if (route === "roots") state.focusRoot = focusRoot || "";
    state.route = route;
    switchPageVisibility();
    if (route === "documents") renderDocuments();
    if (route === "temporary") renderTemporary();
    if (route === "roots") { renderRoots(); void refreshStatus(); }
    if (route === "trash") { renderTrash(); void refreshStatus(); }
    if (route === "documents") {
      setTimeout(() => { if (state.route === "documents") $("document-query")?.focus(); }, 0);
    }
    if (route === "roots" && state.focusRoot) {
      setTimeout(() => {
        const target = document.querySelector("[data-root-row='" + CSS.escape(state.focusRoot) + "']");
        if (target instanceof HTMLElement) target.focus();
      }, 0);
    }
  }
  function routeFromTopSearch() {
    state.route = "documents";
    switchPageVisibility();
  }
  function replaceOptions(select, options, value) {
    if (!select) return;
    select.replaceChildren(...options.map(option => new Option(option.label, option.value)));
    select.value = options.some(option => option.value === value) ? value : "";
  }
  function renderScopeSummaries() {
    const roots = state.indexStatus && Array.isArray(state.indexStatus.roots) ? state.indexStatus.roots : [];
    replaceOptions($("scope-root"), [{ label: "所有根目錄", value: "" }, ...roots.map(root => ({ label: root.path, value: root.path }))], state.rootFilter);
    replaceOptions($("scope-format"), [{ label: "所有格式", value: "" }, ...state.supportedExtensions.map(value => ({ label: value.slice(1).toUpperCase(), value }))], state.typeFilter);
    replaceOptions($("scope-parse"), [
      { label: "所有解析狀態", value: "" }, { label: "可讀", value: "indexed" }, { label: "不支援", value: "unsupported" },
      { label: "解析錯誤", value: "error" }, { label: "加密", value: "encrypted" }, { label: "無文字", value: "no_text" },
      { label: "過大", value: "too_large" },
    ], state.statusFilter);
  }
  function renderSidebar() {
    const total = $("nav-doc-count");
    const temp = $("nav-temp-count");
    const rootCount = $("nav-root-count");
    const trash = $("nav-trash-count");
    const context = $("nav-context-count");
    if (total) total.textContent = documentTotal() === null ? "" : String(documentTotal());
    if (temp) temp.textContent = String(state.imported.size);
    if (rootCount) rootCount.textContent = state.indexStatus && Array.isArray(state.indexStatus.roots) ? String(state.indexStatus.roots.length) : "";
    if (trash) trash.textContent = state.indexStatus && Array.isArray(state.indexStatus.trash) ? String(state.indexStatus.trash.length) : "";
    if (context) context.textContent = String(selectedCount());
    const rootList = $("sidebar-roots");
    rootList.replaceChildren();
    const roots = state.indexStatus && Array.isArray(state.indexStatus.roots) ? state.indexStatus.roots : [];
    if (!roots.length) {
      rootList.append(make("div", "sidebar-empty", "尚無根目錄"));
    } else {
      for (const root of roots) {
        const item = navButton(() => navigate("roots", root.path));
        item.dataset.route = "roots";
        item.dataset.rootPath = root.path;
        item.title = root.path;
        const icon = make("span", "nav-icon", "⌁");
        const label = make("span", "root-path-label", escapeText(root.path).split(/[\\\\/]/u).filter(Boolean).pop() || root.path);
        const count = make("span", "nav-count", String(root.documentCount));
        item.append(icon, label, count);
        rootList.append(item);
      }
    }
    updateNav();
    const indexState = state.indexStatus && state.indexStatus.indexing;
    const statusText = indexState && ["running", "stopping"].includes(indexState.state) ? indexState.message
      : indexState && ["stopped", "failed"].includes(indexState.state) ? indexState.message
      : state.indexStatus && state.indexStatus.state === "available" ? "索引可用"
      : state.indexStatus && state.indexStatus.state === "missing" ? "尚無索引"
      : state.indexStatus && state.indexStatus.state === "unavailable" ? "索引狀態暫時無法讀取"
      : "索引狀態未知";
    const sidebarStatus = $("sidebar-status");
    if (sidebarStatus) sidebarStatus.textContent = statusText;
  }
  function escapeText(value) { return value === null || value === undefined ? "" : String(value); }
  function documentRootPath(item) {
    let rootPath = escapeText(item && item.root);
    if (!rootPath && item && item.path) {
      const itemPath = escapeText(item.path).replaceAll("/", "\\\\").toLocaleLowerCase();
      const roots = state.indexStatus && Array.isArray(state.indexStatus.roots) ? state.indexStatus.roots : [];
      for (const root of roots) {
        const candidate = escapeText(root.path).replaceAll("/", "\\\\").replace(/\\\\+$/u, "");
        const normalized = candidate.toLocaleLowerCase();
        if (itemPath === normalized || itemPath.startsWith(normalized + "\\\\")) {
          if (!rootPath || candidate.length > rootPath.length) rootPath = candidate;
        }
      }
    }
    return rootPath;
  }
  function documentRootLabel(item) {
    return documentRootPath(item).split(/[\\\\/]/u).filter(Boolean).pop() || "";
  }
  /** 根目錄名稱 › 子資料夾 › 檔名（SPEC §57.1）；根目錄只顯示最後一段，像搜尋引擎只顯示網域。 */
  function documentBreadcrumb(item) {
    const full = escapeText(item.path);
    const rootPath = documentRootPath(item).replace(/[\\\\/]+$/u, "");
    const inside = rootPath && full.toLocaleLowerCase().startsWith(rootPath.toLocaleLowerCase())
      ? full.slice(rootPath.length) : full;
    const parts = inside.split(/[\\\\/]/u).filter(Boolean);
    const rootName = rootPath.split(/[\\\\/]/u).filter(Boolean).pop() || rootPath;
    return (rootName ? [rootName, ...parts] : parts).join(" › ");
  }
  const localDateTime = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  function formatLocalDateTime(value) {
    if (!value) return "未提供移除時間";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未提供移除時間" : localDateTime.format(date);
  }
  function termsForHighlight() {
    const query = state.submittedQuery || state.queryDraft;
    if (!query.trim()) return [];
    if (state.mode === "phrase") return [query];
    return query.trim().split(/\\s+/u).filter(Boolean);
  }
  function appendHighlighted(parent, value, terms = termsForHighlight()) {
    const text = escapeText(value);
    const highlightTerms = Array.isArray(terms) ? terms : termsForHighlight();
    const termsToHighlight = highlightTerms.filter(term => term.length > 0);
    if (!termsToHighlight.length || !text) { parent.append(document.createTextNode(text)); return; }
    const lower = text.toLocaleLowerCase();
    const ranges = [];
    for (const term of termsToHighlight) {
      const needle = term.toLocaleLowerCase();
      let from = 0;
      while (needle && from < lower.length) {
        const found = lower.indexOf(needle, from);
        if (found < 0) break;
        ranges.push({ start: found, end: found + needle.length });
        from = found + Math.max(needle.length, 1);
      }
    }
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = 0;
    for (const range of ranges) {
      if (range.start < cursor) continue;
      if (range.start > cursor) parent.append(document.createTextNode(text.slice(cursor, range.start)));
      const mark = make("mark", "", text.slice(range.start, range.end));
      parent.append(mark);
      cursor = range.end;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }
  function makeResultPassages(item) {
    const passages = Array.isArray(item && item.passages) ? item.passages : [];
    const omittedTerms = Number.isSafeInteger(item && item.omittedTerms) && item.omittedTerms > 0 ? item.omittedTerms : 0;
    if (passages.length <= 1 && omittedTerms === 0) return null;
    const group = make("div", "result-passages-group", "");
    if (passages.length > 1) {
      const list = make("ul", "result-passages", "");
      list.setAttribute("aria-label", "搜尋命中段落");
      passages.forEach((passage, index) => {
        const current = passage || {};
        const location = escapeText(current.location) || "未提供位置";
        const terms = Array.isArray(current.terms) ? current.terms.map(escapeText).filter(Boolean) : [];
        const termText = terms.length ? "命中詞：" + terms.join("、") : "命中詞：未提供";
        const entry = make("li", "result-passage", "");
        entry.setAttribute("aria-label", "第 " + (index + 1) + " 段；" + location + "；" + termText);
        const label = make("div", "result-passage-label", "");
        label.setAttribute("aria-label", location + "；" + termText);
        label.append(make("span", "result-passage-location", location), make("span", "result-passage-terms", termText));
        const snippetText = escapeText(current.snippet);
        const snippet = make("p", "result-passage-snippet", "");
        if (snippetText) appendHighlighted(snippet, snippetText, terms);
        else snippet.textContent = "沒有可顯示的片段";
        entry.append(label, snippet);
        list.append(entry);
      });
      group.append(list);
    }
    if (omittedTerms > 0) {
      const note = make("p", "result-passages-omitted", "還有 " + omittedTerms + " 個詞未列出");
      note.setAttribute("role", "note");
      group.append(note);
    }
    return group;
  }
  function selectedReference(reference) {
    const temporary = state.imported.get(reference);
    return temporary ? Boolean(temporary.selected) : state.selected.has(reference);
  }
  function makeResultCheckbox(item) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "table-check";
    input.checked = selectedReference(item.temporary ? item.id : item.reference);
    input.disabled = Boolean(item.temporary && item.status !== "indexed");
    input.setAttribute("aria-label", "選取 " + escapeText(item.path));
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("change", () => item.temporary
      ? toggleImported(state.imported.get(item.id), input.checked)
      : toggleSelection(item, input.checked));
    return input;
  }
  function resultActions(item) {
    const actions = make("div", "document-actions");
    actions.append(resultCopyActions(item));
    if (item.temporary) {
      const source = state.imported.get(item.id);
      const toggle = button(source?.selected ? "移出上下文" : "加入上下文", "link-action",
        () => source && toggleImported(source, !source.selected));
      toggle.disabled = !source || source.status !== "indexed";
      actions.append(toggle);
      return actions;
    }
    const reveal = button("顯示所在位置", "link-action", () => void documentAction(item, "reveal"));
    const toggle = button(selectedReference(item.reference) ? "移出上下文" : "加入上下文", "link-action", () => toggleSelection(item, !selectedReference(item.reference)));
    actions.append(reveal, toggle);
    return actions;
  }
  function makeDocumentRow(item) {
    const resultKey = item.temporary ? item.id : item.reference;
    const row = make("article", "document-row" + (selectedReference(resultKey) ? " is-selected" : ""));
    row.dataset.reference = resultKey;
    const name = documentFilenameValue(item);
    // 點標題直接開啟原檔，像搜尋引擎點連結（SPEC §57.1）。
    const title = item.temporary ? make("strong", "document-title", name)
      : button(name, "document-title", event => openDocumentTitle(item, event));
    title.title = item.temporary ? escapeText(item.path) : "開啟 " + escapeText(item.path);
    const pathNode = make("div", "document-path", "");
    pathNode.title = item.path;
    pathNode.append(make("span", "document-crumbs", item.temporary ? escapeText(item.path) : documentBreadcrumb(item)),
      make("span", "document-format", String(item.extension || "").replace(".", "").toUpperCase()));
    const passages = Array.isArray(item && item.passages) ? item.passages : [];
    const passageBlock = makeResultPassages(item);
    const snippet = make("p", "snippet");
    if (!item.temporary && item.filenameOnly) {
      snippet.classList.add("is-muted");
      snippet.textContent = "檔名符合";
    } else if (item.snippet) appendHighlighted(snippet, item.snippet);
    else {
      snippet.classList.add("is-muted");
      snippet.textContent = "沒有可顯示的片段";
    }
    row.append(title, pathNode);
    if (passages.length > 1) row.append(passageBlock);
    else {
      row.append(snippet);
      if (passageBlock) row.append(passageBlock);
    }
    row.append(resultActions(item));
    return row;
  }
  function makeTableRow(item) {
    const resultKey = item.temporary ? item.id : item.reference;
    const row = document.createElement("tr");
    row.classList.toggle("is-selected", selectedReference(resultKey));
    row.dataset.reference = resultKey;
    const checkCell = document.createElement("td");
    checkCell.append(makeResultCheckbox(item));
    const titleCell = document.createElement("td");
    const title = item.temporary ? make("strong", "table-title", documentFilenameValue(item))
      : button(documentFilenameValue(item), "table-title", event => openDocumentTitle(item, event));
    title.title = item.path;
    const passageBlock = makeResultPassages(item);
    titleCell.append(title, resultCopyActions(item));
    if (passageBlock) titleCell.append(passageBlock);
    const rootCell = document.createElement("td");
    rootCell.textContent = documentRootLabel(item) || "未提供";
    rootCell.title = item.root || rootCell.textContent;
    const formatCell = document.createElement("td");
    formatCell.textContent = String(item.extension || "").replace(".", "").toUpperCase();
    const locationCell = document.createElement("td");
    locationCell.textContent = item.location || "未提供";
    const statusCell = document.createElement("td");
    statusCell.textContent = item.status === "indexed" ? "可讀" : (item.status || "未提供");
    row.append(checkCell, titleCell, rootCell, formatCell, locationCell, statusCell);
    return row;
  }
  function appendTableMessage(body, text) {
    const row = document.createElement("tr");
    const cell = make("td", "table-empty", text);
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
  }
  function totalLabel(data) {
    // SPEC §52.3: fast mode reports a lower bound once 500 documents match.
    return data.totalRelation === "gte" ? data.total + " 筆以上" + (state.counting ? "（計算中…）" : "") : data.total + " 筆";
  }
  function resultRange(data) {
    if (!data || !data.total) return "沒有結果";
    const start = (data.page - 1) * data.pageSize + 1;
    const end = Math.min(data.page * data.pageSize, data.accessibleTotal);
    return "第 " + start + "–" + end + " 筆，共 " + totalLabel(data) + (data.truncatedToFirst500 ? "；僅開放前 500 筆" : "");
  }
  async function explainEmptyPath(input, resultNode) {
    const requested = input.value.trim();
    if (!requested) {
      resultNode.textContent = "請輸入檔案路徑。";
      return;
    }
    resultNode.textContent = "正在重新計算目前排除與索引狀態…";
    try {
      const data = await api("/api/explain", { method: "POST", body: { path: requested } });
      state.emptyExplainMessage = data.message || "未提供說明。";
      resultNode.textContent = state.emptyExplainMessage;
    } catch (error) {
      state.emptyExplainMessage = error.message || "檔案說明查詢失敗。";
      resultNode.textContent = state.emptyExplainMessage;
    }
  }
  function emptySearchState(emptyText) {
    const empty = make("div", "empty-state", "");
    empty.append(make("strong", "", emptyText), make("p", "empty-exclusion-hint", ${JSON.stringify(formatZeroResultExclusionHint("workbench"))}));
    const form = make("form", "empty-explain-form", "");
    form.id = "search-empty-explain-form";
    const label = make("label", "", "檢查某個檔案為何搜不到");
    label.htmlFor = "search-empty-explain-path";
    const input = document.createElement("input");
    input.id = "search-empty-explain-path";
    input.type = "text";
    input.maxLength = 16_384;
    input.placeholder = "輸入檔案路徑";
    input.autocomplete = "off";
    const submit = button("檢查", "primary", undefined);
    submit.id = "search-empty-explain-button";
    submit.type = "submit";
    const result = make("p", "empty-explain-result", state.emptyExplainMessage);
    result.id = "search-empty-explain-result";
    form.append(label, input, submit, result);
    form.addEventListener("submit", event => { event.preventDefault(); void explainEmptyPath(input, result); });
    empty.append(form);
    return empty;
  }
  function renderDocuments() {
    syncQueryInputs();
    renderScopeSummaries();
    const data = state.data;
    const resultList = $("document-list");
    const tableWrap = $("document-table-wrap");
    const tableBody = $("document-table-body");
    resultList.replaceChildren();
    tableBody.replaceChildren();
    const title = $("results-title");
    const subtitle = $("results-subtitle");
    const range = $("pagination-label");
    const prev = $("documents-prev");
    const next = $("documents-next");
    if (state.searchState === "loading") {
      title.textContent = "搜尋中";
      subtitle.textContent = "";
      resultList.append(make("div", "empty-state", "搜尋中…"));
      appendTableMessage(tableBody, "搜尋中…");
      range.textContent = "1";
    } else if (state.searchState === "error") {
      title.textContent = "查詢錯誤";
      subtitle.textContent = "";
      resultList.append(make("div", "empty-state", state.searchMessage));
      appendTableMessage(tableBody, state.searchMessage);
      range.textContent = "1";
    } else if (!data) {
      title.textContent = "尚未搜尋";
      subtitle.textContent = "";
      resultList.append(make("div", "empty-state", "尚未搜尋"));
      appendTableMessage(tableBody, "尚未搜尋");
      range.textContent = "1";
    } else if ((!data.results || !data.results.length) && (!data.temporaryResults || !data.temporaryResults.length)) {
      const emptyText = data.total ? "目前頁面沒有結果" : "沒有符合文件";
      title.textContent = emptyText;
      subtitle.textContent = "";
      resultList.append(emptySearchState(emptyText));
      appendTableMessage(tableBody, emptyText);
      range.textContent = String(data.page || 1);
    } else {
      const results = [...(data.temporaryResults || []), ...(data.results || [])];
      if (state.sortMode === "filename") {
        results.sort((left, right) => {
          const leftName = (left.filename || left.path.split(/[\\/]/).pop() || left.path).normalize("NFKC");
          const rightName = (right.filename || right.path.split(/[\\/]/).pop() || right.path).normalize("NFKC");
          return leftName.localeCompare(rightName, "zh-Hant", { numeric: true, sensitivity: "base" });
        });
      } else if (state.sortMode === "modified") {
        results.sort((left, right) => {
          const leftTime = Date.parse(left.modifiedAt || "");
          const rightTime = Date.parse(right.modifiedAt || "");
          if (Number.isNaN(leftTime)) return Number.isNaN(rightTime) ? 0 : 1;
          if (Number.isNaN(rightTime)) return -1;
          return rightTime - leftTime;
        });
      }
      const shownTotal = data.total + (data.temporaryResults || []).length;
      title.textContent = shownTotal + (data.totalRelation === "gte" ? " 份以上文件" : " 份文件");
      subtitle.textContent = (data.temporaryResults || []).length
        ? "（含 " + data.temporaryResults.length + " 份本次拖曳文件；拖曳文件只以檔名搜尋）"
        : data.truncatedToFirst500 ? "（只開放前 500 筆）" : "（已篩選）";
      range.textContent = String(data.page || 1);
      for (const item of results) {
        resultList.append(makeDocumentRow(item));
        tableBody.append(makeTableRow(item));
      }
    }
    prev.disabled = !data || data.page <= 1 || state.searchState === "loading";
    next.disabled = !data || data.page >= data.pageCount || state.searchState === "loading";
    const cancelButton = $("search-cancel-button");
    const searchActive = state.searchState === "loading" || state.counting;
    if (cancelButton) {
      cancelButton.hidden = !searchActive || !state.searchCancelVisible;
      cancelButton.disabled = !searchActive;
    }
    const sortSelect = $("document-sort");
    if (sortSelect) sortSelect.value = state.sortMode;
    const listMode = state.viewMode !== "table";
    resultList.hidden = !listMode;
    tableWrap.hidden = listMode;
    $("view-list").setAttribute("aria-pressed", String(listMode));
    $("view-table").setAttribute("aria-pressed", String(!listMode));
    const selectPage = $("select-page");
    const selectAll = $("select-all");
    selectPage.disabled = !data || !data.results || !data.results.length;
    selectAll.disabled = !data || !data.total;
    const bulk = $("bulk-bar");
    if (selectedCount() > 0) {
      bulk.hidden = false;
      $("selection-label").textContent = "已選取 " + selectedCount() + " 份文件";
    } else bulk.hidden = true;
    $("review-context").disabled = selectedCount() === 0;
    const statusMessage = searchActive && state.searchElapsedSeconds > 0
      ? state.searchMessage + "（已等待 " + state.searchElapsedSeconds + " 秒）"
      : state.searchMessage;
    setStatus("search-status", statusMessage, state.searchKind);
    renderSidebar();
    renderContextDrawer();
  }
  function clearIndexedSelection(message) {
    state.selected.clear();
    invalidatePreview(message || "索引選取已清除；請重新產生精確預覽。", true);
  }
  function toggleSelection(item, checked) {
    if (checked) {
      if (state.selected.has(item.reference)) return;
      if (selectedCount() >= MAX) {
        showToast("索引文件與臨時文件合計最多 20 份；未加入第 21 份。");
        renderDocuments();
        return;
      }
      state.selected.set(item.reference, { query: state.submittedQuery, reference: item.reference, item });
    } else state.selected.delete(item.reference);
    invalidatePreview("選取已變更；請重新產生精確預覽。", true);
  }
  function toggleImported(item, checked) {
    if (checked && selectedCount() >= MAX) {
      showToast("索引文件與臨時文件合計最多 20 份；未加入第 21 份。");
      renderTemporary();
      return;
    }
    item.selected = checked;
    invalidatePreview("選取已變更；請重新產生精確預覽。", true);
    renderTemporary();
    if (state.route === "documents") renderDocuments();
  }
  async function selectAllAccessible() {
    if (!state.data || !state.submittedQuery) return;
    const seq = state.searchSeq;
    const pageCount = state.data.pageCount;
    const pageSize = state.data.pageSize;
    let added = 0;
    for (let page = 1; page <= pageCount && seq === state.searchSeq; page++) {
      let data;
      try {
        data = page === state.data.page ? state.data : await api("/api/search", { method: "POST", body: { ...searchPayload(page), query: state.submittedQuery } });
      } catch (error) {
        showToast(error.message || "無法取得全部目前可瀏覽結果。");
        return;
      }
      for (const item of data.results || []) {
        if (state.selected.has(item.reference)) continue;
        if (selectedCount() >= MAX) {
          showToast("目前可瀏覽結果超過上下文上限；已保留前 20 份，未破壞既有集合。");
          invalidatePreview("選取已變更；請重新產生精確預覽。", true);
          renderDocuments();
          return;
        }
        state.selected.set(item.reference, { query: data.query, reference: item.reference, item });
        added++;
      }
    }
    if (seq !== state.searchSeq) return;
    invalidatePreview("選取已變更；請重新產生精確預覽。", true);
    renderDocuments();
    showToast(added ? "已選取目前可瀏覽結果中的可用項目。" : "目前可瀏覽結果已在選取集合中。");
  }
  function searchPayload(page) {
    return {
      query: state.submittedQuery || state.queryDraft.trim(), mode: state.mode, page, pageSize: 20,
      field: state.searchField, root: state.rootFilter || undefined,
      types: state.typeFilter ? [state.typeFilter] : undefined,
      statuses: state.statusFilter ? [state.statusFilter] : undefined,
    };
  }
  async function search(page) {
    const submitted = page === 1 ? state.queryDraft.trim() : state.submittedQuery;
    if (!submitted) {
      state.searchState = "error";
      state.searchMessage = "查詢不可為空白。";
      state.searchKind = "error";
      renderDocuments();
      return;
    }
    const previous = {
      data: state.data,
      submittedQuery: state.submittedQuery,
      queryDraft: state.data ? state.submittedQuery : state.queryDraft,
    };
    if (state.searchController) state.searchController.abort();
    clearSearchCancellation();
    const controller = new AbortController();
    const seq = ++state.searchSeq;
    state.searchController = controller;
    state.submittedQuery = submitted;
    state.queryDraft = submitted;
    syncQueryInputs();
    state.searchState = "loading";
    state.searchMessage = "搜尋中…";
    state.searchKind = "";
    state.counting = false;
    const searchStartedAt = performance.now();
    state.searchElapsedSeconds = 0;
    state.searchCancelTimer = setInterval(() => {
      if (seq !== state.searchSeq || state.searchController !== controller || controller.signal.aborted
        || (state.searchState !== "loading" && !state.counting)) return;
      const elapsed = Math.floor((performance.now() - searchStartedAt) / 1_000);
      if (elapsed < 1 || elapsed === state.searchElapsedSeconds) return;
      state.searchElapsedSeconds = elapsed;
      state.searchCancelVisible = true;
      renderDocuments();
    }, 200);
    renderDocuments();
    try {
      let data = await api("/api/search", searchRequestOptions(controller, searchPayload(page)));
      while (data.pendingUpgrade) {
        if (seq !== state.searchSeq) return;
        if (controller.signal.aborted) {
          restoreCancelledSearch(seq, controller, previous);
          return;
        }
        state.searchMessage = data.message || "正在建立 unigram／trigram 搜尋 postings…";
        state.searchKind = "warn";
        renderDocuments();
        await new Promise(resolve => setTimeout(resolve, 500));
        if (controller.signal.aborted) {
          restoreCancelledSearch(seq, controller, previous);
          return;
        }
        const status = await api("/api/index-status", { signal: controller.signal });
        if (["failed", "stopped"].includes(status.indexing?.state)) throw new Error(status.indexing.message);
        data = await api("/api/search", searchRequestOptions(controller, searchPayload(page)));
      }
      if (seq !== state.searchSeq) return;
      state.data = data;
      state.searchState = "success";
      state.searchMessage = data.total ? "搜尋完成。" : "搜尋完成；沒有符合結果。";
      state.searchKind = data.total ? "ok" : "warn";
      if (data.totalMode) state.totalMode = data.totalMode;
      state.counting = data.totalRelation === "gte" && state.totalMode === "exact";
      renderDocuments();
      if (state.counting) {
        // Exact mode: show the page first, then fill in the exact total.
        try {
          const count = await api("/api/search/count", searchRequestOptions(controller, searchPayload(page)));
          if (seq !== state.searchSeq) return;
          data.total = count.total;
          data.totalRelation = count.totalRelation;
        } catch (error) {
          if (isCancelledSearch(error, controller)) throw error;
          if (seq !== state.searchSeq) return;
          state.searchMessage = "總數計算失敗：" + (error.message || "未知錯誤");
          state.searchKind = "warn";
        }
        state.counting = false;
        renderDocuments();
      }
      if (seq !== state.searchSeq) return;
      clearSearchCancellation();
      state.searchController = null;
    } catch (error) {
      if (isCancelledSearch(error, controller)) {
        restoreCancelledSearch(seq, controller, previous);
        return;
      }
      if (seq !== state.searchSeq) return;
      clearSearchCancellation();
      state.searchController = null;
      state.data = null;
      state.searchState = "error";
      state.searchMessage = error.message || "查詢失敗。";
      state.searchKind = "error";
      renderDocuments();
    }
  }
  async function documentAction(item, action) {
    try {
      const data = await api("/api/document-action", { method: "POST", body: { reference: item.reference, action } });
      const changed = data && data.changed ? "索引可能已過期，請重新搜尋。" : "";
      showToast((action === "open" ? "已送出開啟檔案請求。" : "已送出顯示位置請求。") + (changed ? " " + changed : ""));
    } catch (error) { showToast(error.message || "文件操作失敗。"); }
  }
  function renderTemporary() {
    const list = $("file-list");
    list.replaceChildren();
    $("temporary-count").textContent = String(state.imported.size) + " / " + MAX + " 份";
    const searchableOnly = [...state.imported.values()].filter(item => item.status !== "indexed").length;
    $("drop-help").textContent = "目前有 " + String(state.imported.size) + " 份臨時文件；" + searchableOnly + " 份只能搜尋檔名。";
    $("drop-help").title = state.supportedExtensions.length ? "支援內容解析：" + state.supportedExtensions.join("、") + "；其他格式仍會保留並可搜尋檔名。" : "";
    if (state.imported.size) {
      for (const item of state.imported.values()) {
        const row = make("article", "file-row");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = Boolean(item.selected);
        check.disabled = item.pending || item.status !== "indexed";
        check.setAttribute("aria-label", "選取 " + item.filename);
        check.addEventListener("change", () => toggleImported(item, check.checked));
        const body = make("div", "", "");
        body.append(make("div", "file-name", item.filename));
        body.append(make("div", "file-meta", (item.extension || "未知格式") + " · " + String(item.sizeBytes || 0) + " bytes"));
        body.append(resultCopyActions(item));
        const statusText = item.pending ? "pending：本機解析中…" : item.status + (item.errorMessage ? "：" + item.errorMessage : "");
        const statusClass = item.pending ? "warn" : item.status === "indexed" ? "indexed" : item.status === "error" || item.status === "encrypted" ? "error" : "warn";
        const status = make("div", "file-status " + statusClass, statusText);
        const remove = button("移除", "small", () => void removeImported(item));
        row.append(check, body, make("div", "file-row-actions", ""));
        row.lastChild.append(status, remove);
        list.append(row);
      }
    }
    renderSidebar();
    renderContextDrawer();
    $("review-context").disabled = selectedCount() === 0;
  }
  async function removeImported(item) {
    if (item.pending) return;
    try {
      if (!String(item.id).startsWith("pending-")) await api("/api/files/" + encodeURIComponent(item.id), { method: "DELETE" });
      state.imported.delete(item.id);
      invalidatePreview("臨時文件已移除；請重新產生精確預覽。", true);
      renderTemporary();
      if (state.route === "documents" && state.submittedQuery) void search(1);
      showToast("臨時文件已從本次工作階段移除。");
    } catch (error) { setStatus("file-status-message", error.message || "臨時文件移除失敗。", "error"); }
  }
  async function upload(files) {
    for (const file of Array.from(files || [])) {
      if (state.imported.size >= MAX) {
        showToast("session 最多保留 20 份臨時文件。");
        break;
      }
      const pending = { id: "pending-" + Date.now() + "-" + Math.random().toString(16).slice(2), filename: file.name, extension: "", sizeBytes: file.size, status: "pending", pending: true, selected: false };
      state.imported.set(pending.id, pending);
      renderTemporary();
      setStatus("file-status-message", "本機解析 " + file.name + "…", "");
      try {
        const data = await api("/api/files", { method: "POST", headers: { "X-File-Name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file });
        state.imported.delete(pending.id);
        data.selected = data.status === "indexed" && selectedCount() < MAX;
        data.pending = false;
        state.imported.set(data.id, data);
        invalidatePreview("臨時文件已更新；請重新產生精確預覽。", true);
        setStatus("file-status-message", file.name + " 已收到 server 狀態：" + data.status + "。", data.status === "indexed" ? "ok" : "warn");
      } catch (error) {
        pending.pending = false;
        pending.status = "error";
        pending.errorMessage = error.message || "上傳或解析失敗。";
        setStatus("file-status-message", file.name + "：" + pending.errorMessage, "error");
      }
      renderTemporary();
    }
  }
  function invalidatePreview(message, rerender) {
    state.previewSeq++;
    state.preview = null;
    const text = $("preview-text");
    if (text) text.textContent = "尚未產生預覽。";
    const meta = $("preview-meta");
    if (meta) meta.textContent = "尚未產生 server 預覽。";
    const progress = $("preview-progress");
    if (progress) progress.value = 0;
    const copy = $("copy-preview");
    if (copy) copy.disabled = true;
    setStatus("preview-status", message || "待產生精確預覽。", "");
    if (rerender) {
      renderSidebar();
      renderContextDrawer();
      if (state.route === "documents") renderDocuments();
      if (state.route === "temporary") renderTemporary();
    }
  }
  function contextFingerprint() {
    const selections = Array.from(state.selected.values()).map(item => [item.query, item.reference]);
    const files = Array.from(state.imported.values()).filter(item => item.selected && item.status === "indexed").map(item => item.id);
    return JSON.stringify([state.mode, selections, files]);
  }
  function previewPayload() {
    return {
      provider: "auto",
      model: "auto",
      question: "",
      mode: state.mode,
      selections: Array.from(state.selected.values()).map(item => ({ query: item.query, reference: item.reference })),
      fileIds: Array.from(state.imported.values()).filter(item => item.selected && item.status === "indexed").map(item => item.id),
    };
  }
  function updatePreviewControls() {
    const current = Boolean(state.preview && state.preview.fingerprint === contextFingerprint());
    $("copy-preview").disabled = !current;
  }
  async function makePreview() {
    if (selectedCount() === 0) {
      setStatus("preview-status", "請先選取文件。", "warn");
      return;
    }
    const seq = ++state.previewSeq;
    const fingerprint = contextFingerprint();
    setStatus("preview-status", "正在重新驗證來源並建立精確預覽…", "");
    $("copy-preview").disabled = true;
    try {
      const data = await api("/api/preview", { method: "POST", body: previewPayload() });
      if (seq !== state.previewSeq || fingerprint !== contextFingerprint()) return;
      state.preview = { ...data, fingerprint };
      $("preview-text").textContent = data.context;
      $("preview-meta").textContent = String(data.documentCount) + " 份文件 · " + String(data.bytes) + " bytes" + (data.truncated ? " · 內容已截短" : "");
      $("preview-progress").value = Math.min(Number(data.bytes || 0), 262144);
      $("copy-preview").disabled = false;
      setStatus("preview-status", "預覽完成。複製內容與上方可見文字逐字一致。", "ok");
    } catch (error) {
      if (seq !== state.previewSeq) return;
      state.preview = null;
      setStatus("preview-status", error.message || "精確預覽失敗。", "error");
    }
  }
  function showDialog(dialog, trigger, focusTarget) {
    state.dialogTrigger = trigger || document.activeElement;
    dialog.showModal();
    setTimeout(() => { if (focusTarget && !dialog.open) return; (focusTarget || dialog).focus(); }, 0);
  }
  function restoreDialogFocus() {
    const trigger = state.dialogTrigger;
    state.dialogTrigger = null;
    if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
  }
  function openPreview() {
    if (selectedCount() === 0) return;
    const dialog = $("preview-dialog");
    showDialog(dialog, document.activeElement, $("copy-preview"));
    void makePreview();
  }
  async function copyPreview() {
    if (!state.preview || state.preview.fingerprint !== contextFingerprint()) return;
    try {
      await navigator.clipboard.writeText(state.preview.context);
      showToast("已複製目前 server 精確預覽。");
    } catch { setStatus("preview-status", "瀏覽器拒絕剪貼簿權限；請手動複製可見預覽。", "error"); }
  }
  function renderContextDrawer() {
    const count = selectedCount();
    $("nav-context-count").textContent = String(count);
    $("context-count").textContent = "已選 " + count + " / " + MAX;
    $("context-open-preview").disabled = count === 0;
    const indexed = $("context-indexed-list");
    const temporary = $("context-temporary-list");
    indexed.replaceChildren();
    temporary.replaceChildren();
    if (!state.selected.size) indexed.append(make("div", "empty-state", "尚未選取索引文件。"));
    for (const selected of state.selected.values()) {
      const row = make("div", "context-item");
      const body = make("div", "", "");
      body.append(make("div", "context-item-name", selected.item.path));
      body.append(make("div", "context-item-meta", (selected.item.extension || "") + " · " + (selected.item.location || "未提供位置")));
      body.append(resultCopyActions(selected.item));
      const actions = make("div", "context-item-actions");
      actions.append(button("開啟", "small", () => void documentAction(selected.item, "open")));
      actions.append(button("移除", "small", () => { state.selected.delete(selected.reference); invalidatePreview("選取已變更；請重新產生精確預覽。", true); }));
      row.append(body, actions);
      indexed.append(row);
    }
    const selectedTemps = Array.from(state.imported.values()).filter(item => item.selected);
    if (!selectedTemps.length) temporary.append(make("div", "empty-state", "尚未選取臨時文件。"));
    for (const item of selectedTemps) {
      const row = make("div", "context-item");
      const body = make("div", "", "");
      body.append(make("div", "context-item-name", item.filename));
      body.append(make("div", "context-item-meta", (item.extension || "") + " · " + item.status));
      body.append(resultCopyActions(item));
      row.append(body, button("移除", "small", () => { item.selected = false; invalidatePreview("選取已變更；請重新產生精確預覽。", true); }));
      temporary.append(row);
    }
  }
  function openContext(trigger) {
    const drawer = $("context-drawer");
    state.focusAfterDrawer = trigger || document.activeElement;
    drawer.hidden = false;
    drawer.removeAttribute("inert");
    drawer.setAttribute("aria-hidden", "false");
    $("app-shell").setAttribute("inert", "");
    $("scrim").hidden = false;
    renderContextDrawer();
    $("context-close").focus();
  }
  function closeContext() {
    const drawer = $("context-drawer");
    drawer.hidden = true;
    drawer.setAttribute("inert", "");
    drawer.setAttribute("aria-hidden", "true");
    $("scrim").hidden = true;
    $("app-shell").removeAttribute("inert");
    const trigger = state.focusAfterDrawer;
    state.focusAfterDrawer = null;
    if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
  }
  function rootCheckbox(path, selected, kind) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "table-check";
    input.checked = selected;
    input.setAttribute("aria-label", (kind === "trash" ? "選取垃圾桶項目 " : "選取索引根目錄 ") + path);
    input.disabled = isIndexing();
    input.addEventListener("change", () => {
      const set = kind === "trash" ? state.selectedTrash : state.selectedRoots;
      if (input.checked) set.add(path); else set.delete(path);
      kind === "trash" ? renderTrash() : renderRoots();
    });
    return input;
  }
  function rootListTotal(root, totalKey, listKey) {
    const total = root[totalKey];
    if (typeof total === "number" && Number.isFinite(total)) return total;
    return Array.isArray(root[listKey]) ? root[listKey].length : 0;
  }
  function truncatedListLabel(total, shown) {
    return "共 " + total + " 筆，只列前 " + shown + " 筆";
  }
  function rootIntegrity(root) {
    if (root.lastSyncComplete === false) return { text: "未完整同步", kind: "bad" };
    const errorTotal = rootListTotal(root, "errorsTotal", "errors");
    if (errorTotal) {
      const shown = Array.isArray(root.errors) ? root.errors.length : 0;
      const truncated = root.errorsTruncated === true || shown < errorTotal;
      return { text: truncated ? "錯誤 " + errorTotal + " 項（" + truncatedListLabel(errorTotal, shown) + "）" : "錯誤 " + errorTotal + " 項", kind: "bad" };
    }
    if (root.lastSyncComplete === null) return { text: "尚未完成", kind: "warn" };
    return { text: "完整", kind: "good" };
  }
  function exclusionPolicyForRoot(rootPath) {
    const policies = state.exclusions && Array.isArray(state.exclusions.roots) ? state.exclusions.roots : [];
    return policies.find(policy => policy && (policy.root === rootPath || String(policy.root || "").toLocaleLowerCase() === String(rootPath || "").toLocaleLowerCase())) || null;
  }
  function exclusionRuleCount(rule) {
    return rule && rule.lastSkipped !== undefined ? String(rule.lastSkipped) : "未提供";
  }
  function appendExclusionPolicyDetails(parent, policy, id) {
    const details = document.createElement("details");
    details.className = "root-exclusion-details";
    if (id) details.id = id;
    const summary = make("summary", "", policy && policy.summary ? policy.summary : "預設排除：未提供");
    details.append(summary);
    const body = make("div", "exclusion-policy-body", "");
    const rules = policy && Array.isArray(policy.rules) ? policy.rules : [];
    if (!rules.length) body.append(make("p", "is-muted", "預設排除規則：無。"));
    for (const rule of rules) {
      const item = make("section", "exclusion-rule", "");
      item.append(make("strong", "", String(rule.name || "未提供") + "（" + String(rule.pattern || "未提供") + "）"));
      item.append(make("p", "", "理由：" + String(rule.reason || "未提供")));
      item.append(make("p", "", "警告：" + String(rule.warning || "未提供") + "；最後一次略過：" + exclusionRuleCount(rule)));
      body.append(item);
    }
    const ignoreHeading = make("strong", "", ".localdocsearchignore");
    body.append(ignoreHeading);
    const ignoreFiles = policy && Array.isArray(policy.ignoreFiles) ? policy.ignoreFiles : [];
    if (!ignoreFiles.length) body.append(make("p", "is-muted", "未提供有效作用域。"));
    for (const file of ignoreFiles) {
      const patterns = Array.isArray(file.patterns) && file.patterns.length ? file.patterns.join("、") : file.exists ? "存在但沒有規則" : "不存在";
      body.append(make("p", "", String(file.path || "未提供") + "：" + (file.errorCode ? "規則無法讀取（" + file.errorCode + "）" : patterns)));
    }
    const skippedByRule = policy && policy.skippedByRule;
    body.append(make("p", "exclusion-rule-counts", skippedByRule
      ? "逐規則最近略過：" + (Object.entries(skippedByRule).map(([id, count]) => id + "=" + String(count)).join("、") || "無") + "。"
      : "逐規則最近略過：未提供。"));
    const cleanup = policy && policy.exclusionCleanup;
    body.append(make("p", "exclusion-cleanup", cleanup
      ? "既有索引排除清理：已移除 " + String(cleanup.removed) + "；待清理 " + String(cleanup.pending) + "。"
      : "既有索引排除清理：未提供。"));
    details.append(body);
    parent.append(details);
  }
  function renderExclusionPolicySettings() {
    const container = $("settings-exclusion-policy-list");
    if (!container) return;
    container.replaceChildren();
    const policies = state.exclusions && Array.isArray(state.exclusions.roots) ? state.exclusions.roots : [];
    if (!policies.length) {
      container.append(make("p", "is-muted", "尚無已登錄根目錄或目前無法提供政策。"));
      return;
    }
    for (const policy of policies) {
      const section = make("section", "settings-exclusion-root", "");
      section.append(make("h3", "", String(policy.root || "未提供")));
      appendExclusionPolicyDetails(section, policy);
      container.append(section);
    }
  }
  function renderRootExclusionPreview() {
    const preview = $("root-exclusion-preview");
    if (!preview) return;
    preview.replaceChildren();
    const policy = state.exclusionPreview;
    const isVolumeRoot = policy && Array.isArray(policy.rules) && policy.rules.some(rule => rule.source === "volume-default");
    preview.hidden = !state.addRootDraft || !policy || !isVolumeRoot;
    if (!preview.hidden) {
      preview.append(make("strong", "", "會預設略過哪些位置"));
      appendExclusionPolicyDetails(preview, policy);
    }
  }
  function renderRoots() {
    renderScopeSummaries();
    const data = state.indexStatus;
    const body = $("roots-body");
    body.replaceChildren();
    $("root-select-all").checked = Boolean(data && data.roots && data.roots.length && data.roots.every(root => state.selectedRoots.has(root.path)));
    $("root-select-all").indeterminate = state.selectedRoots.size > 0 && !$("root-select-all").checked;
    const disabled = isIndexing();
    $("root-select-all").disabled = disabled || !data || !data.roots || !data.roots.length;
    $("root-delete-selected").disabled = disabled || state.selectedRoots.size === 0;
    $("roots-refresh").disabled = disabled;
    $("roots-refresh-folder").disabled = disabled;
    $("roots-stop").hidden = !disabled;
    $("roots-stop").disabled = !disabled;
    $("top-refresh").disabled = disabled;
    $("top-stop").hidden = !disabled;
    $("top-stop").disabled = !disabled;
    $("root-choose").disabled = disabled;
    $("root-choose-inline").disabled = disabled;
    $("root-confirm").disabled = disabled || !state.addRootDraft || !state.exclusionPreviewReady;
    $("root-draft").value = state.addRootDraft;
    if (!data || data.state === "missing" || !data.roots || !data.roots.length) {
      body.append(make("tr", "root-empty-row", ""));
      body.lastChild.append(make("td", "", "尚無已登錄根目錄。"));
      body.lastChild.firstChild.colSpan = 7;
    } else {
      for (const root of data.roots) {
        const row = document.createElement("tr");
        row.dataset.rootRow = root.path;
        row.tabIndex = 0;
        const check = document.createElement("td"); check.append(rootCheckbox(root.path, state.selectedRoots.has(root.path), "roots"));
        const pathCell = document.createElement("td");
        const pathButton = make("button", "root-focus-button", root.path);
        pathButton.type = "button"; pathButton.title = root.path; pathButton.addEventListener("click", () => { state.focusRoot = root.path; pathButton.focus(); });
        pathCell.className = "root-path"; pathCell.append(pathButton);
        const count = make("td", "", String(root.documentCount));
        const integrity = rootIntegrity(root);
        const synced = make("td", "root-state", root.lastSyncComplete === null ? "尚未同步" : "已同步");
        const status = make("td", "root-state " + integrity.kind, integrity.text);
        const errorTotal = rootListTotal(root, "errorsTotal", "errors");
        const noticeTotal = rootListTotal(root, "noticesTotal", "notices");
        if (errorTotal && Array.isArray(root.errors) && root.errors.length) {
          const truncated = root.errorsTruncated === true || root.errors.length < errorTotal;
          status.title = root.errors.join("；") + (truncated ? "（" + truncatedListLabel(errorTotal, root.errors.length) + "）" : "");
        } else if (noticeTotal && Array.isArray(root.notices) && root.notices.length) {
          const truncated = root.noticesTruncated === true || root.notices.length < noticeTotal;
          status.title = root.notices.join("；") + (truncated ? "（" + truncatedListLabel(noticeTotal, root.notices.length) + "）" : "");
        } else status.title = integrity.text;
        const exclusionCell = make("td", "root-exclusions", "");
        const policy = exclusionPolicyForRoot(root.path);
        if (policy) appendExclusionPolicyDetails(exclusionCell, policy);
        else exclusionCell.textContent = "預設排除：未提供";
        const actions = make("td", "root-actions", "");
        const refresh = button("重新檢查此根目錄", "root-refresh-action", () => void runIndex(root.path, "subtree"));
        const move = button("移至垃圾桶", "danger", () => { state.selectedRoots.clear(); state.selectedRoots.add(root.path); requestDelete("roots"); });
        refresh.disabled = disabled;
        move.disabled = disabled;
        actions.append(refresh, move);
        row.append(check, pathCell, count, synced, status, exclusionCell, actions);
        body.append(row);
      }
    }
    const addPanel = $("root-add-panel");
    addPanel.classList.toggle("has-draft", Boolean(state.addRootDraft));
    const draftMessage = $("root-draft-message");
    draftMessage.textContent = state.addRootDraft ? "已選取；尚未開始索引。" : "尚未選取資料夾。";
    renderRootExclusionPreview();
    renderExclusionPolicySettings();
    renderSidebar();
  }
  function renderTrash() {
    const data = state.indexStatus;
    const body = $("trash-body");
    body.replaceChildren();
    const trash = data && Array.isArray(data.trash) ? data.trash : [];
    const disabled = isIndexing();
    $("trash-select-all").checked = Boolean(trash.length && trash.every(item => state.selectedTrash.has(item.path)));
    $("trash-select-all").indeterminate = state.selectedTrash.size > 0 && !$("trash-select-all").checked;
    $("trash-select-all").disabled = disabled || !trash.length;
    $("trash-restore-selected").disabled = disabled || state.selectedTrash.size === 0;
    $("trash-purge-selected").disabled = disabled || state.selectedTrash.size === 0;
    if (!trash.length) {
      const row = make("tr", "trash-empty-row", "");
      const cell = make("td", "", "垃圾桶是空的。"); cell.colSpan = 3; row.append(cell); body.append(row);
    } else {
      for (const item of trash) {
        const row = document.createElement("tr");
        const check = document.createElement("td"); check.append(rootCheckbox(item.path, state.selectedTrash.has(item.path), "trash"));
        const pathCell = make("td", "trash-path", ""); pathCell.title = item.path;
        pathCell.append(make("h2", "", item.path), make("p", "", String(item.documentCount) + " 份文件 · " + formatLocalDateTime(item.deletedAt)));
        const actions = make("td", "trash-actions", "");
        const restore = button("還原並重新索引", "primary", () => void restoreTrash([item.path]));
        restore.disabled = disabled;
        const purge = button("永久刪除", "danger", () => { state.selectedTrash.clear(); state.selectedTrash.add(item.path); requestDelete("trash"); });
        purge.disabled = disabled;
        actions.append(restore, purge);
        row.append(check, pathCell, actions); body.append(row);
      }
    }
    renderSidebar();
  }
  function numberText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? String(Number(number.toFixed(2))) : "—";
  }
  function autoupdatePhaseText(phase) {
    return ({ idle: "閒置", updating: "局部更新", reconciling: "完整校正", starting: "啟動中", stopping: "停止中" })[phase] || String(phase || "—");
  }
  function autoupdateTimeText(value) {
    return value ? formatLocalDateTime(value) : "—";
  }
  function renderWorkbenchOpenBanner() {
    const banner = $("workbench-open-banner");
    if (!banner) return;
    const mode = validWorkbenchOpenMode(state.workbenchOpenMode) ? state.workbenchOpenMode : "ask";
    const modeStatus = $("workbench-open-mode-status");
    const selector = $("settings-workbench-open-mode");
    const controlBusy = state.workbenchOpenSaving || state.workbenchOpenActionBusy;
    if (modeStatus) modeStatus.textContent = controlBusy
      ? "處理中…" : "目前策略：" + workbenchOpenModeLabel(mode);
    if (selector) {
      selector.disabled = controlBusy;
      selector.setAttribute("aria-busy", String(controlBusy));
      selector.value = state.workbenchOpenSaving ? state.workbenchOpenPendingMode : mode;
    }
    const stale = state.workbenchOpenStatusStale;
    const staleContext = stale && state.indexStatus && state.indexStatus.state === "available"
      && Array.isArray(state.indexStatus.roots) && state.indexStatus.roots.length > 0;
    const eligible = !stale && workbenchOpenEligible();
    const failed = state.workbenchOpenActionFailed;
    const visible = state.workbenchOpenActionBusy
      || failed && !workbenchOpenIsRunning()
      || (!state.workbenchOpenDismissed && mode === "ask" && (staleContext || eligible));
    banner.hidden = !visible;
    if (!visible) return;
    const title = $("workbench-open-title");
    const message = $("workbench-open-message");
    const warning = $("workbench-open-warning");
    const status = $("workbench-open-status");
    if (title) title.textContent = state.workbenchOpenActionBusy
      ? "正在處理背景更新"
      : failed ? "背景更新開啟失敗"
        : stale ? "背景更新狀態暫時無法確認" : "背景更新目前沒有執行";
    if (message) message.textContent = state.workbenchOpenActionBusy
      ? "正在處理；請不要重複送出操作。"
      : failed
        ? "上一個操作未完成；索引與檔案不會因失敗而被標記為已處理。"
        : stale
          ? "目前無法確認背景更新是否正在執行；請重新整理工作台後再操作。"
          : "背景更新目前沒有執行（上次成功同步：" + workbenchOpenLastSuccessfulSync()
            + "）。關閉期間新增或修改的檔案可能還沒進入索引。";
    if (warning) {
      warning.hidden = stale || !workbenchOpenHasVolumeRoot();
      warning.textContent = "偵測到 C:" + String.fromCharCode(92) + " 根目錄；補捉可能重新檢查大量檔案、耗用磁碟與 CPU，時間可能較長。";
    }
    if (status) {
      status.textContent = state.workbenchOpenActionBusy
        ? "處理中…"
        : state.workbenchOpenActionMessage || (stale ? "狀態過期；四個動作目前停用。" : "請選擇處理方式。");
      status.className = "status" + (failed || stale ? " error" : "");
    }
    const busy = state.workbenchOpenActionBusy;
    const actionsDisabled = busy || stale || !eligible;
    const start = $("workbench-open-start");
    const index = $("workbench-open-index");
    const later = $("workbench-open-later");
    const disable = $("workbench-open-disable");
    if (start) start.disabled = actionsDisabled;
    if (index) index.disabled = actionsDisabled;
    if (later) later.disabled = actionsDisabled;
    if (disable) disable.disabled = actionsDisabled;
  }
  function renderStartupCatchupBanner() {
    const banner = $("startup-catchup-banner");
    if (!banner) return;
    const live = startupCatchupLive();
    const mode = validStartupCatchupMode(state.startupCatchupMode) ? state.startupCatchupMode : "auto";
    const controlBusy = state.startupCatchupSaving || state.startupCatchupActionBusy;
    const modeStatus = $("startup-catchup-mode-status");
    if (modeStatus) modeStatus.textContent = controlBusy
      ? "處理中…" : "目前策略：" + startupCatchupModeLabel(mode);
    const selector = $("settings-startup-catchup-mode");
    if (selector) {
      selector.disabled = controlBusy;
      selector.setAttribute("aria-busy", String(controlBusy));
      selector.value = state.startupCatchupSaving ? state.startupCatchupPendingMode : mode;
    }
    const pending = !state.startupCatchupDeferred && Boolean(live && mode === "ask" && live.state === "pending");
    const failed = state.startupCatchupActionFailed;
    const visible = pending || state.startupCatchupActionBusy || failed;
    banner.hidden = !visible;
    if (!visible) return;
    const title = $("startup-catchup-title");
    const message = $("startup-catchup-message");
    const warning = $("startup-catchup-warning");
    const status = $("startup-catchup-status");
    if (title) title.textContent = state.startupCatchupActionBusy ? "正在處理開機補捉" : failed ? "開機補捉尚未完成" : "開機補捉提醒";
    if (message) message.textContent = state.startupCatchupActionBusy
      ? "正在處理離線期間的變更；請不要重複送出操作。"
      : failed
        ? "上一個操作失敗；工作佇列仍保留，尚未標記為完成。"
        : "背景自動更新離線期間可能有變更尚未檢查。請選擇是否現在補捉。";
    if (warning) {
      warning.hidden = !startupCatchupHasVolumeRoot(live);
      warning.textContent = "偵測到 C:" + String.fromCharCode(92) + " 根目錄；補捉可能重新檢查大量檔案、耗用磁碟與 CPU，時間可能較長。";
    }
    if (status) {
      status.textContent = state.startupCatchupActionBusy
        ? "處理中…"
        : state.startupCatchupActionMessage || "等待你的選擇。";
      status.className = "status" + (state.startupCatchupActionFailed ? " error" : "");
    }
    const start = $("startup-catchup-start");
    const later = $("startup-catchup-later");
    const skip = $("startup-catchup-skip");
    const disable = $("startup-catchup-disable");
    const busy = state.startupCatchupActionBusy;
    if (start) start.disabled = busy || !pending || mode === "off";
    if (later) later.disabled = busy;
    if (skip) skip.disabled = busy || !live || live.state !== "pending";
    if (disable) disable.disabled = busy || !pending || mode === "off";
  }
  function renderAutoupdateSummary() {
    const summary = $("settings-autoupdate-summary");
    const status = $("settings-autoupdate-status");
    if (!summary) return;
    summary.replaceChildren();
    summary.hidden = true;
    if (status) { status.textContent = ""; status.hidden = true; }
    const autoupdate = state.indexStatus && state.indexStatus.autoupdate;
    if (!autoupdate) { renderWorkbenchOpenBanner(); renderStartupCatchupBanner(); return; }
    if (!autoupdate.live) {
      if (status) {
        status.hidden = false;
        status.textContent = autoupdate.message || "背景自動更新未執行。";
      }
      renderWorkbenchOpenBanner();
      renderStartupCatchupBanner();
      return;
    }
    const live = autoupdate.live;
    summary.hidden = false;
    const row = (label, value) => {
      const item = make("div", "autoupdate-summary-row", "");
      item.append(make("span", "", label), make("span", "", value));
      summary.append(item);
    };
    row("狀態", autoupdatePhaseText(live.phase) + " · " + (live.ready ? "已就緒" : "準備中"));
    row("待處理", String(live.pendingCount ?? "—") + "；佇列 " + String(live.queuePendingCount ?? "—")
      + (live.queueDegraded ? "（已降級）" : ""));
    row("累計", "事件 " + String(live.eventCount ?? "—") + "；局部更新 " + String(live.localUpdateCount ?? "—")
      + "；已排除事件 " + String(live.excludedEventCount ?? "—"));
    const lastLocal = live.lastLocalUpdate ? autoupdateTimeText(live.lastLocalUpdate.at) : "—";
    const lastReconcile = live.lastReconcile
      ? autoupdateTimeText(live.lastReconcile.at) + "（" + (live.lastReconcile.complete ? "完整" : "未完整") + "）" : "—";
    row("同步時間", "局部 " + lastLocal + "；完整 " + lastReconcile + "；下次 " + autoupdateTimeText(live.nextReconcileAt));
    const errors = Array.isArray(live.recentErrors) ? live.recentErrors.slice(0, 3) : [];
    row("最近錯誤", errors.length ? errors.join("；") : "無");
    const settings = live.settings || {};
    row("目前參數", "變更等待 " + numberText(Number(settings.debounceMs) / 1000) + " 秒；完整校正 "
      + numberText(Number(settings.reconcileMs) / 3_600_000) + " 小時");
    const catchup = live.startupCatchup;
    if (catchup) row("開機補捉", startupCatchupModeLabel(catchup.mode) + " · " + startupCatchupStateLabel(catchup.state)
      + (Array.isArray(catchup.roots) && catchup.roots.length ? " · 根目錄 " + catchup.roots.length : ""));
    renderWorkbenchOpenBanner();
    renderStartupCatchupBanner();
  }
  function syncAutoupdateControls() {
    const indexStatus = state.indexStatus || {};
    const startup = indexStatus.autoupdateStartup || {};
    state.autoupdateStartupSupported = startup.supported === true;
    if (!state.autoupdateStartupSaving) state.autoupdateStartupEnabled = startup.enabled === true;
    const live = indexStatus.autoupdate && indexStatus.autoupdate.live;
    const liveSettings = live && live.settings;
    const liveInstanceId = live && typeof live.instanceId === "string" ? live.instanceId : "";
    if (liveInstanceId) {
      if (state.startupCatchupDeferredInstanceId && state.startupCatchupDeferredInstanceId !== liveInstanceId) {
        state.startupCatchupDeferred = false;
        state.startupCatchupActionFailed = false;
        state.startupCatchupActionMessage = "";
      }
      state.startupCatchupDeferredInstanceId = liveInstanceId;
    }
    const savedSettings = liveSettings || indexStatus.autoupdateSettings || {};
    if (Number.isSafeInteger(savedSettings.debounceMs)) state.autoupdateDebounceMs = savedSettings.debounceMs;
    if (Number.isSafeInteger(savedSettings.reconcileMs)) state.autoupdateReconcileMs = savedSettings.reconcileMs;
    const responseMode = live && live.startupCatchup && live.startupCatchup.mode
      || liveSettings && liveSettings.startupCatchupMode
      || indexStatus.startupCatchupMode;
    if (!state.startupCatchupSaving && validStartupCatchupMode(responseMode)) state.startupCatchupMode = responseMode;
    if (!state.workbenchOpenSaving && validWorkbenchOpenMode(indexStatus.workbenchOpenMode)) state.workbenchOpenMode = indexStatus.workbenchOpenMode;
    if (!state.autoupdateSaving) state.autoupdateEnabled = Boolean(indexStatus.autoupdate && indexStatus.autoupdate.enabled);
    syncSettingSwitch("settings-autoupdate", state.autoupdateEnabled, { busy: state.autoupdateSaving });
    syncSettingSwitch("settings-autoupdate-startup", state.autoupdateStartupEnabled, {
      busy: state.autoupdateStartupSaving,
      disabled: !state.autoupdateStartupSupported,
    });
    syncSettingSwitch("settings-delete-confirmation", state.deleteConfirmation, { busy: state.deleteConfirmationSaving });
    syncSettingSwitch("settings-total-exact", state.totalMode === "exact", { busy: state.totalModeSaving });
    const startupHelp = $("settings-autoupdate-startup-help");
    if (startupHelp) startupHelp.textContent = state.autoupdateStartupSupported ? "" : "僅 Windows 支援";
    const debounce = $("settings-autoupdate-debounce");
    if (debounce && document.activeElement !== debounce) debounce.value = numberText(state.autoupdateDebounceMs / 1000);
    const reconcile = $("settings-autoupdate-reconcile");
    if (reconcile && document.activeElement !== reconcile) reconcile.value = numberText(state.autoupdateReconcileMs / 3_600_000);
    const label = $("settings-autoupdate-label");
    if (label) label.textContent = "背景自動更新（檔案變更增量更新；每 " + numberText(state.autoupdateReconcileMs / 3_600_000) + " 小時完整校正）";
    const selector = $("settings-startup-catchup-mode");
    if (selector) {
      selector.disabled = state.startupCatchupSaving;
      selector.setAttribute("aria-busy", String(state.startupCatchupSaving));
      selector.value = state.startupCatchupSaving ? state.startupCatchupPendingMode : state.startupCatchupMode;
    }
    const workbenchSelector = $("settings-workbench-open-mode");
    if (workbenchSelector) {
      workbenchSelector.disabled = state.workbenchOpenSaving || state.workbenchOpenActionBusy;
      workbenchSelector.setAttribute("aria-busy", String(state.workbenchOpenSaving || state.workbenchOpenActionBusy));
      workbenchSelector.value = state.workbenchOpenSaving ? state.workbenchOpenPendingMode : state.workbenchOpenMode;
    }
    renderAutoupdateSummary();
  }
  async function refreshStatus() {
    if (state.statusRefreshBusy) return;
    state.statusRefreshBusy = true;
    const revision = state.statusRevision;
    const previous = state.indexStatus;
    try {
      const [indexStatus, exclusions] = await Promise.all([api("/api/index-status"), api("/api/exclusions")]);
      state.indexStatus = preserveSettingResponses(indexStatus, revision);
      state.workbenchOpenStatusStale = state.indexStatus.autoupdate?.available === false;
      state.exclusions = exclusions;
      state.deleteConfirmation = state.indexStatus.deleteConfirmation !== false;
      syncSettingSwitch("settings-delete-confirmation", state.deleteConfirmation, { busy: state.deleteConfirmationSaving });
      state.totalMode = state.indexStatus.totalMode === "exact" ? "exact" : "fast";
      syncSettingSwitch("settings-total-exact", state.totalMode === "exact", { busy: state.totalModeSaving });
      syncAutoupdateControls();
      renderSidebar();
      renderScopeSummaries();
      renderRoots();
      renderTrash();
      renderAutoupdateSummary();
      if (state.route === "documents") renderDocuments();
      if (state.route === "temporary") renderTemporary();
      if (!state.indexNotice && state.indexStatus.indexing && state.indexStatus.indexing.state === "failed") setNotice(state.indexStatus.indexing.message, "error");
      else if (!state.indexNotice) setStatus("index-status-message", "", "");
      void evaluateWorkbenchOpenMode();
    } catch (error) {
      if (revision !== state.statusRevision) return;
      state.indexStatus = previous || { state: "unavailable", roots: [], trash: [], indexing: { state: "idle", message: "索引狀態暫時無法讀取。" } };
      if (!previous || !isIndexing()) setNotice(error.message || "索引狀態暫時無法讀取；請稍後重試。", "warn");
      renderSidebar();
      renderScopeSummaries();
      renderRoots();
      renderTrash();
      state.workbenchOpenStatusStale = true;
      renderAutoupdateSummary();
    } finally {
      state.statusRefreshBusy = false;
    }
  }
  async function evaluateWorkbenchOpenMode() {
    if (state.workbenchOpenEvaluationDone || state.workbenchOpenActionBusy || state.workbenchOpenSaving) return;
    const status = state.indexStatus;
    if (!status || status.state !== "available" || !Array.isArray(status.roots) || !status.roots.length || isIndexing()) return;
    if (status.autoupdate && status.autoupdate.available === false) {
      state.workbenchOpenStatusStale = true;
      renderWorkbenchOpenBanner();
      return;
    }
    state.workbenchOpenStatusStale = false;
    if (workbenchOpenIsRunning()) {
      state.workbenchOpenEvaluationDone = true;
      renderWorkbenchOpenBanner();
      return;
    }
    const mode = validWorkbenchOpenMode(state.workbenchOpenMode) ? state.workbenchOpenMode : "ask";
    state.workbenchOpenEvaluationDone = true;
    if (mode === "auto") {
      await performWorkbenchOpenAction("start", true);
    } else {
      renderWorkbenchOpenBanner();
    }
  }
  async function runIndex(root, scope) {
    const subtree = scope === "subtree";
    if (state.indexOperationBusy || isIndexing()) {
      setNotice(subtree ? "索引進行中，請完成後再重新檢查。" : root ? "索引進行中，請完成後再加入。" : "索引進行中，請稍候。", "warn");
      return false;
    }
    state.indexOperationBusy = true;
    setNotice(subtree ? "正在重新檢查選定資料夾…" : root ? "已確認資料夾；正在建立索引…" : "正在更新已登錄根目錄…", "");
    renderRoots(); renderTrash(); renderSidebar();
    try {
      const body = root ? (subtree ? { root, scope: "subtree" } : { root }) : {};
      const data = await api("/api/index", { method: "POST", body });
      state.indexStatus = { ...(state.indexStatus || {}), indexing: data.indexing };
      renderRoots(); renderTrash(); renderSidebar();
      while (state.indexStatus && state.indexStatus.indexing && ["running", "stopping"].includes(state.indexStatus.indexing.state)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await refreshStatus();
      }
      await refreshStatus();
      const success = state.indexStatus && state.indexStatus.indexing && state.indexStatus.indexing.state === "complete";
      if (success && root && !subtree) {
        state.addRootDraft = "";
        state.exclusionPreview = null;
        state.exclusionPreviewReady = false;
      }
      setNotice(state.indexStatus && state.indexStatus.indexing ? state.indexStatus.indexing.message : (success ? "索引已更新。" : "索引完成。"), success ? "ok" : "error");
      return Boolean(success);
    } catch (error) {
      setNotice(error.message || "索引無法開始。", "error");
      await refreshStatus();
      return false;
    } finally {
      state.indexOperationBusy = false;
      renderRoots(); renderTrash(); renderSidebar();
    }
  }
  async function stopIndex() {
    if (!isIndexing()) return;
    setNotice("正在停止索引同步…", "warn");
    try {
      const data = await api("/api/index/stop", { method: "POST", body: {} });
      state.indexStatus = { ...(state.indexStatus || {}), indexing: data.indexing };
      await refreshStatus();
      setNotice("索引同步已停止；現在可以移除根目錄。", "ok");
    } catch (error) {
      setNotice(error.message || "無法停止索引同步。", "error");
    }
  }
  async function restoreTrash(paths) {
    if (!paths.length || isIndexing()) return;
    for (const root of paths) {
      const success = await runIndex(root);
      if (!success) break;
    }
    state.selectedTrash.clear();
    renderTrash();
  }
  async function loadExclusionPreview(root) {
    state.exclusionPreview = null;
    state.exclusionPreviewReady = false;
    renderRoots();
    try {
      const data = await api("/api/exclusions?root=" + encodeURIComponent(root));
      state.exclusionPreview = data && data.requested ? data.requested : null;
      state.exclusionPreviewReady = Boolean(state.exclusionPreview);
      if (!state.exclusionPreviewReady) setNotice("無法取得目前排除預覽；為避免沉默加入，請稍後重選資料夾。", "error");
    } catch (error) {
      setNotice(error.message || "無法取得排除預覽；為避免沉默加入，請稍後重選資料夾。", "error");
    } finally {
      renderRoots();
    }
  }
  async function chooseFolder() {
    if (isIndexing()) { setNotice("索引進行中，請完成後再加入。", "warn"); return; }
    if (state.folderPickerBusy) return;
    state.folderPickerBusy = true;
    try {
      const data = await api("/api/select-folder", { method: "POST" });
      const root = data && typeof data.root === "string" ? data.root.trim() : "";
      if (!root) { setNotice("已取消選擇資料夾；尚未開始索引。", "warn"); return; }
      state.addRootDraft = root;
      await loadExclusionPreview(root);
      if (state.exclusionPreviewReady) setNotice("已選擇資料夾；請先查看預設排除，再按「確認並建立索引」。", "ok");
    } catch (error) { setNotice(error.message || "資料夾選擇失敗。", "error"); }
    finally { state.folderPickerBusy = false; }
  }
  async function chooseRefreshFolder() {
    if (isIndexing()) { setNotice("索引進行中，請完成後再重新檢查。", "warn"); return; }
    if (state.folderPickerBusy) return;
    state.folderPickerBusy = true;
    try {
      const data = await api("/api/select-folder", { method: "POST" });
      const root = data && typeof data.root === "string" ? data.root.trim() : "";
      if (!root) { setNotice("已取消重新檢查；尚未開始索引。", "warn"); return; }
      await runIndex(root, "subtree");
    } catch (error) { setNotice(error.message || "資料夾選擇失敗。", "error"); }
    finally { state.folderPickerBusy = false; }
  }
  function requestAddRoot() {
    const root = state.addRootDraft.trim();
    if (!root) { setNotice("請先按「加入資料夾」選擇資料夾。", "warn"); return; }
    void runIndex(root);
  }
  function requestDelete(kind) {
    const paths = Array.from(kind === "trash" ? state.selectedTrash : state.selectedRoots);
    if (!paths.length) return;
    if (isIndexing()) { setNotice(kind === "trash" ? "索引進行中，請完成後再清理垃圾桶。" : "索引進行中，請完成後再刪除根目錄。", "warn"); return; }
    if (kind === "roots" && !state.deleteConfirmation) { void executeDelete(kind, paths, false); return; }
    openDeleteDialog(kind, paths);
  }
  function openDeleteDialog(kind, paths) {
    state.pendingDelete = { kind, paths };
    const dialog = $("delete-dialog");
    const permanent = kind === "trash";
    $("delete-title").textContent = permanent ? "永久刪除垃圾桶項目？" : "將索引根目錄移至垃圾桶？";
    $("delete-message").textContent = "選取數量：" + paths.length + "。";
    const shown = paths.slice(0, 3).join(String.fromCharCode(10));
    $("delete-detail").textContent = shown + (paths.length > 3 ? String.fromCharCode(10) + "… 共 " + paths.length + " 條路徑" : "");
    $("delete-warning").textContent = permanent ? "此操作無法還原。來源資料夾與檔案不會被刪除。" : "只會移除索引；來源資料夾與檔案不會被刪除。垃圾桶仍可還原並重新索引。";
    $("delete-confirm").textContent = permanent ? "永久刪除（無法還原）" : "移至垃圾桶";
    $("delete-dont-remind").checked = false;
    $("delete-dont-remind-row").hidden = permanent;
    showDialog(dialog, document.activeElement, $("delete-confirm"));
  }
  async function executeDelete(kind, paths, dontRemind) {
    try {
      const endpoint = kind === "trash" ? "/api/trash" : "/api/index-roots/trash";
      await api(endpoint, { method: kind === "trash" ? "DELETE" : "POST", body: { roots: paths } });
      if (kind === "trash") state.selectedTrash.clear(); else state.selectedRoots.clear();
      await refreshStatus();
      setNotice(kind === "trash" ? "垃圾桶項目已永久刪除。" : "索引根目錄已移至垃圾桶。", "ok");
      showToast(kind === "trash" ? "垃圾桶項目已永久刪除；來源資料未刪除。" : "索引根目錄已移至垃圾桶；來源資料未刪除。");
      if (kind === "roots" && dontRemind) await saveDeleteConfirmation(false);
      return true;
    } catch (error) {
      setNotice(error.message || "刪除操作失敗。", "error");
      return false;
    } finally { renderRoots(); renderTrash(); }
  }
  async function saveDeleteConfirmation(enabled) {
    const previous = state.deleteConfirmation;
    state.deleteConfirmationSaving = true;
    state.statusRevision += 1;
    syncSettingSwitch("settings-delete-confirmation", previous, { busy: true });
    try {
      const data = await api("/api/settings", { method: "POST", body: { deleteConfirmation: enabled } });
      state.deleteConfirmation = data.deleteConfirmation !== false;
      state.indexStatus = { ...(state.indexStatus || {}), deleteConfirmation: state.deleteConfirmation };
      setStatus("settings-status", state.deleteConfirmation ? "已開啟刪除確認提醒。" : "已關閉刪除確認提醒。", "ok");
      return true;
    } catch (error) {
      state.deleteConfirmation = previous;
      setStatus("settings-status", error.message || "設定保存失敗。", "error");
      return false;
    } finally {
      state.deleteConfirmationSaving = false;
      syncAutoupdateControls();
    }
  }
  async function saveTotalMode(exact) {
    const previous = state.totalMode;
    state.totalModeSaving = true;
    state.statusRevision += 1;
    syncSettingSwitch("settings-total-exact", previous === "exact", { busy: true });
    try {
      const data = await api("/api/settings", { method: "POST", body: { totalMode: exact ? "exact" : "fast" } });
      state.totalMode = data.totalMode === "exact" ? "exact" : "fast";
      state.indexStatus = { ...(state.indexStatus || {}), totalMode: state.totalMode };
      setStatus("settings-status", state.totalMode === "exact" ? "總筆數改為精確計算；常見詞會在結果顯示後補上總數。" : "總筆數改為快速；超過 500 筆時顯示「500 筆以上」。", "ok");
      return true;
    } catch (error) {
      state.totalMode = previous;
      setStatus("settings-status", error.message || "設定保存失敗。", "error");
      return false;
    } finally {
      state.totalModeSaving = false;
      syncAutoupdateControls();
    }
  }
  async function saveStartupCatchupMode(mode) {
    if (!validStartupCatchupMode(mode)) {
      setStatus("settings-status", "開機補捉策略無效。", "error");
      syncAutoupdateControls();
      return false;
    }
    const previous = state.startupCatchupMode;
    state.startupCatchupPendingMode = mode;
    state.startupCatchupSaving = true;
    state.startupCatchupActionFailed = false;
    state.startupCatchupActionMessage = "";
    state.startupCatchupDeferred = false;
    state.statusRevision += 1;
    renderStartupCatchupBanner();
    try {
      const data = await api("/api/settings", { method: "POST", body: { startupCatchupMode: mode } });
      if (!validStartupCatchupMode(data.startupCatchupMode)) throw new Error("設定回應缺少開機補捉策略。");
      if (data.autoupdate && !applyAutoupdateResponse(data)) throw new Error("設定回應缺少背景自動更新狀態。");
      state.startupCatchupMode = data.startupCatchupMode;
      state.indexStatus = { ...(state.indexStatus || {}), startupCatchupMode: state.startupCatchupMode };
      setStatus("settings-status", "開機補捉策略已保存為「" + startupCatchupModeLabel(state.startupCatchupMode) + "」。", "ok");
      return true;
    } catch (error) {
      state.startupCatchupMode = previous;
      state.startupCatchupActionFailed = true;
      state.startupCatchupActionMessage = error.message || "開機補捉策略保存失敗。";
      setStatus("settings-status", state.startupCatchupActionMessage, "error");
      return false;
    } finally {
      state.startupCatchupSaving = false;
      syncAutoupdateControls();
    }
  }
  async function saveWorkbenchOpenMode(mode) {
    if (!validWorkbenchOpenMode(mode)) {
      setStatus("settings-status", "工作台開啟提醒策略無效。", "error");
      syncAutoupdateControls();
      return false;
    }
    const previous = state.workbenchOpenMode;
    const previousDismissed = state.workbenchOpenDismissed;
    state.workbenchOpenPendingMode = mode;
    state.workbenchOpenSaving = true;
    state.workbenchOpenActionFailed = false;
    state.workbenchOpenActionMessage = "";
    state.statusRevision += 1;
    syncAutoupdateControls();
    try {
      const data = await api("/api/settings", { method: "POST", body: { workbenchOpenMode: mode } });
      if (!validWorkbenchOpenMode(data.workbenchOpenMode)) throw new Error("設定回應缺少工作台開啟提醒策略。");
      if (!applyAutoupdateResponse(data)) throw new Error("設定回應缺少背景自動更新狀態。");
      state.workbenchOpenMode = data.workbenchOpenMode;
      state.indexStatus = { ...(state.indexStatus || {}), workbenchOpenMode: state.workbenchOpenMode };
      state.workbenchOpenDismissed = state.workbenchOpenMode !== "ask";
      setStatus("settings-status", "工作台開啟提醒策略已保存為「" + workbenchOpenModeLabel(state.workbenchOpenMode) + "」。", "ok");
      return true;
    } catch (error) {
      state.workbenchOpenMode = previous;
      state.workbenchOpenDismissed = previousDismissed;
      state.workbenchOpenActionFailed = true;
      state.workbenchOpenActionMessage = error.message || "工作台開啟提醒策略保存失敗。";
      setStatus("settings-status", state.workbenchOpenActionMessage, "error");
      return false;
    } finally {
      state.workbenchOpenSaving = false;
      syncAutoupdateControls();
    }
  }
  async function performWorkbenchOpenAction(action, automatic = false) {
    if (state.workbenchOpenActionBusy || state.workbenchOpenSaving) return false;
    if (automatic && state.workbenchOpenMode !== "auto") return false;
    if (!workbenchOpenEligible()) return false;
    state.workbenchOpenActionBusy = true;
    state.workbenchOpenActionFailed = false;
    state.workbenchOpenActionMessage = "";
    state.statusRevision += 1;
    renderWorkbenchOpenBanner();
    try {
      if (action === "start") {
        const data = await api("/api/autoupdate/workbench-open", { method: "POST", body: { automatic } });
        if (!applyAutoupdateResponse(data)) throw new Error("開啟背景更新回應缺少目前狀態。");
        state.workbenchOpenDismissed = true;
        setStatus("settings-status", automatic ? "已依工作台開啟策略啟動背景更新並補捉遺漏。" : "已開啟背景更新並補捉遺漏。", "ok");
        showToast(automatic ? "背景更新已自動啟動，正在補捉關閉期間的變更。" : "背景更新已啟動，正在補捉關閉期間的變更。");
        return true;
      }
      const success = await runIndex();
      if (!success) throw new Error("完整校正尚未完成；請稍後重試。");
      state.workbenchOpenDismissed = true;
      setStatus("settings-status", "已只做一次完整校正；背景更新仍未啟動。", "ok");
      showToast("完整校正已完成；背景更新仍未啟動。");
      return true;
    } catch (error) {
      state.workbenchOpenActionFailed = true;
      state.workbenchOpenActionMessage = error.message || "工作台開啟處理失敗。";
      setStatus("settings-status", state.workbenchOpenActionMessage, "error");
      return false;
    } finally {
      state.workbenchOpenActionBusy = false;
      renderWorkbenchOpenBanner();
    }
  }
  function deferWorkbenchOpen() {
    if (state.workbenchOpenActionBusy || !workbenchOpenEligible()) return;
    state.workbenchOpenDismissed = true;
    state.workbenchOpenActionFailed = false;
    state.workbenchOpenActionMessage = "";
    renderWorkbenchOpenBanner();
    showToast("已暫緩背景更新提醒；下次開啟工作台仍會提醒。");
  }
  async function disableWorkbenchOpen() {
    if (state.workbenchOpenActionBusy || state.workbenchOpenSaving) return false;
    return saveWorkbenchOpenMode("off");
  }
  async function performStartupCatchupAction(action) {
    if (state.startupCatchupActionBusy) return false;
    state.startupCatchupActionBusy = true;
    state.startupCatchupActionFailed = false;
    state.startupCatchupActionMessage = "";
    state.statusRevision += 1;
    renderStartupCatchupBanner();
    try {
      const data = await api("/api/autoupdate/catchup", { method: "POST", body: { action } });
      if (!applyAutoupdateResponse(data) || !startupCatchupLive()) throw new Error("補捉回應缺少目前狀態。");
      state.startupCatchupDeferred = false;
      setStatus("settings-status", action === "start" ? "已開始開機補捉。" : "已略過本次開機補捉。", "ok");
      return true;
    } catch (error) {
      state.startupCatchupActionFailed = true;
      state.startupCatchupActionMessage = error.message || "開機補捉操作失敗。";
      setStatus("settings-status", state.startupCatchupActionMessage, "error");
      return false;
    } finally {
      state.startupCatchupActionBusy = false;
      renderStartupCatchupBanner();
    }
  }
  function deferStartupCatchup() {
    if (state.startupCatchupActionBusy) return;
    const live = state.indexStatus && state.indexStatus.autoupdate && state.indexStatus.autoupdate.live;
    state.startupCatchupDeferredInstanceId = live && typeof live.instanceId === "string" ? live.instanceId : "";
    state.startupCatchupDeferred = true;
    state.startupCatchupActionFailed = false;
    state.startupCatchupActionMessage = "";
    renderStartupCatchupBanner();
    showToast("已暫緩開機補捉；目前工作佇列未變更。");
  }
  async function disableStartupCatchup() {
    if (state.startupCatchupActionBusy || state.startupCatchupSaving) return false;
    if (!await saveStartupCatchupMode("off")) return false;
    return performStartupCatchupAction("skip");
  }
  async function saveAutoupdate(enabled) {
    const previous = state.autoupdateEnabled;
    state.autoupdateSaving = true;
    state.statusRevision += 1;
    syncSettingSwitch("settings-autoupdate", previous, { busy: true });
    try {
      const data = await api("/api/settings", { method: "POST", body: { autoupdateEnabled: enabled } });
      if (!applyAutoupdateResponse(data)) throw new Error("設定回應缺少背景自動更新狀態。");
      setStatus("settings-status", data.message || (state.autoupdateEnabled
        ? "背景自動更新已開啟；檔案變更會增量更新。"
        : "背景自動更新已關閉。"), "ok");
      return true;
    } catch (error) {
      state.autoupdateEnabled = previous;
      setStatus("settings-status", error.message || "背景自動更新設定失敗。", "error");
      return false;
    } finally {
      state.autoupdateSaving = false;
      syncAutoupdateControls();
    }
  }
  async function saveAutoupdateStartup(enabled) {
    const supported = state.autoupdateStartupSupported;
    if (!supported) return false;
    const previous = state.autoupdateStartupEnabled;
    state.autoupdateStartupSaving = true;
    state.statusRevision += 1;
    syncSettingSwitch("settings-autoupdate-startup", previous, { busy: true });
    try {
      const data = await api("/api/settings", { method: "POST", body: { autoupdateStartup: enabled } });
      if (!applyAutoupdateStartupResponse(data)) throw new Error("設定回應缺少登入啟動狀態。");
      setStatus("settings-status", state.autoupdateStartupEnabled
        ? "已設定登入 Windows 時自動啟動背景自動更新。"
        : "已取消登入 Windows 時自動啟動背景自動更新。", "ok");
      return true;
    } catch (error) {
      state.autoupdateStartupEnabled = previous;
      setStatus("settings-status", error.message || "登入啟動設定失敗。", "error");
      return false;
    } finally {
      state.autoupdateStartupSaving = false;
      syncAutoupdateControls();
    }
  }
  async function saveAutoupdateParameters() {
    const debounce = $("settings-autoupdate-debounce");
    const reconcile = $("settings-autoupdate-reconcile");
    const debounceMs = Math.round(Number(debounce && debounce.value) * 1000);
    const reconcileMs = Math.round(Number(reconcile && reconcile.value) * 3_600_000);
    if (!Number.isFinite(debounceMs) || !Number.isFinite(reconcileMs)) {
      setStatus("settings-status", "請輸入有效的背景自動更新參數。", "error");
      syncAutoupdateControls();
      return false;
    }
    const fields = [debounce, reconcile].filter(Boolean);
    state.statusRevision += 1;
    for (const field of fields) field.disabled = true;
    try {
      const data = await api("/api/settings", { method: "POST", body: {
        autoupdateDebounceMs: debounceMs,
        autoupdateReconcileMs: reconcileMs,
      } });
      await refreshStatus();
      setStatus("settings-status", data.message || "背景自動更新參數已保存。", "ok");
      return true;
    } catch (error) {
      await refreshStatus();
      setStatus("settings-status", error.message || "背景自動更新參數保存失敗。", "error");
      return false;
    } finally {
      syncAutoupdateControls();
      for (const field of fields) field.disabled = false;
    }
  }
  function openSettings(trigger) {
    const firstSwitch = $("settings-delete-confirmation");
    syncAutoupdateControls();
    showDialog($("settings-dialog"), trigger || document.activeElement, firstSwitch || $("settings-dialog"));
    void refreshStatus();
  }
  function makePageHeader(title, description) {
    const header = make("header", "page-header");
    const copy = make("div", "", ""); copy.append(make("h1", "", title), make("p", "", description));
    const actions = make("div", "page-header-actions", ""); header.append(copy, actions); header.actions = actions; return header;
  }
  function buildApp() {
    const app = $("app");
    const shell = make("div", "app-shell"); shell.id = "app-shell";
    const topbar = make("header", "topbar");
    const brand = make("div", "brand"); brand.append(make("span", "brand-mark", "S"), make("span", "", "seekah"));
    const searchLabel = make("label", "global-search"); searchLabel.htmlFor = "global-query"; searchLabel.append(make("span", "", "⌕"));
    const globalQuery = document.createElement("input"); globalQuery.id = "global-query"; globalQuery.type = "search"; globalQuery.maxLength = 1000; globalQuery.autocomplete = "off"; globalQuery.placeholder = "搜尋所有本機文件"; globalQuery.setAttribute("aria-label", "全域搜尋所有本機文件"); searchLabel.append(globalQuery);
    const topActions = make("div", "top-actions");
    const refresh = button("完整校正", "top-button", () => void runIndex()); refresh.id = "top-refresh"; refresh.title = "列舉所有根目錄並比較 metadata；只重新解析新增或變更的文件。";
    const stop = button("停止同步", "top-button", () => void stopIndex()); stop.id = "top-stop"; stop.hidden = true;
    const trace = button("Trace", "top-button", () => { location.href = "/traces#" + encodeURIComponent(token()); }); trace.id = "trace-toggle"; trace.title = "開啟獨立 Trace 診斷頁，查看持久化搜尋與 answer log。";
    const settings = button("設定", "top-button", () => openSettings(settings)); settings.id = "settings-toggle";
    const status = make("span", "local-status", "本機模式"); status.id = "top-status";
    topActions.append(refresh, stop, trace, settings, status); topbar.append(brand, searchLabel, topActions); shell.append(topbar);

    const sidebar = make("aside", "sidebar"); sidebar.setAttribute("aria-label", "主要導覽");
    const documentsGroup = make("div", "nav-group", "文件"); sidebar.append(documentsGroup);
    const nav = make("nav", "nav-list");
    nav.setAttribute("aria-label", "文件導覽");
    const allDocs = navButton(() => navigate("documents")); allDocs.dataset.route = "documents"; allDocs.append(make("span", "nav-icon", "▤"), make("span", "", "所有文件"), make("span", "nav-count", "")); allDocs.lastChild.id = "nav-doc-count";
    const temp = navButton(() => navigate("temporary")); temp.dataset.route = "temporary"; temp.append(make("span", "nav-icon", "＋"), make("span", "", "臨時文件"), make("span", "nav-count", "0")); temp.lastChild.id = "nav-temp-count";
    nav.append(allDocs, temp); sidebar.append(nav);
    sidebar.append(make("div", "nav-group", "常用範圍")); const rootList = make("div", "root-nav-list", ""); rootList.id = "sidebar-roots"; sidebar.append(rootList);
    sidebar.append(make("div", "nav-group", "索引管理"));
    const manage = make("nav", "nav-list");
    manage.setAttribute("aria-label", "索引管理導覽");
    const roots = navButton(() => navigate("roots")); roots.dataset.route = "roots"; roots.append(make("span", "nav-icon", "◫"), make("span", "", "根目錄"), make("span", "nav-count", "")); roots.lastChild.id = "nav-root-count";
    const trash = navButton(() => navigate("trash")); trash.dataset.route = "trash"; trash.append(make("span", "nav-icon", "♲"), make("span", "", "垃圾桶"), make("span", "nav-count", "")); trash.lastChild.id = "nav-trash-count";
    manage.append(roots, trash); sidebar.append(manage);
    sidebar.append(make("div", "nav-group", "工作區"));
    const workspace = make("nav", "nav-list");
    workspace.setAttribute("aria-label", "工作區導覽");
    const context = navButton(() => openContext(context)); context.append(make("span", "nav-icon", "▣"), make("span", "", "已選上下文"), make("span", "nav-count", "0")); context.lastChild.id = "nav-context-count";
    const settingsSide = navButton(() => openSettings(settingsSide)); settingsSide.append(make("span", "nav-icon", "⚙"), make("span", "", "設定"));
    workspace.append(context, settingsSide); sidebar.append(workspace);
    allDocs.id = "nav-documents"; temp.id = "nav-temporary"; roots.id = "nav-roots"; trash.id = "nav-trash"; context.id = "nav-context"; settingsSide.id = "nav-settings";
    const footer = make("div", "sidebar-footer"); const footerStatus = make("strong", "", "讀取中…"); footerStatus.id = "sidebar-status"; footer.append(footerStatus, make("br"), make("span", "", "搜尋與臨時解析留在這台電腦。")); sidebar.append(footer); shell.append(sidebar);

    const main = make("main", "main"); main.id = "main"; main.tabIndex = -1;
    const workbenchOpenBanner = make("section", "startup-catchup-banner workbench-open-banner", "");
    workbenchOpenBanner.id = "workbench-open-banner";
    workbenchOpenBanner.hidden = true;
    workbenchOpenBanner.setAttribute("role", "region");
    workbenchOpenBanner.setAttribute("aria-labelledby", "workbench-open-title");
    const workbenchOpenTitle = make("h2", "", "背景更新目前沒有執行"); workbenchOpenTitle.id = "workbench-open-title";
    const workbenchOpenMessage = make("p", "", "關閉期間新增或修改的檔案可能還沒進入索引。"); workbenchOpenMessage.id = "workbench-open-message";
    const workbenchOpenWarning = make("p", "startup-catchup-warning", ""); workbenchOpenWarning.id = "workbench-open-warning"; workbenchOpenWarning.hidden = true;
    const workbenchOpenStatus = make("div", "status startup-catchup-status", ""); workbenchOpenStatus.id = "workbench-open-status"; workbenchOpenStatus.setAttribute("role", "status"); workbenchOpenStatus.setAttribute("aria-live", "polite");
    const workbenchOpenActions = make("div", "startup-catchup-actions", "");
    const workbenchOpenStart = button("開啟背景更新並補上遺漏（推薦）", "primary", () => void performWorkbenchOpenAction("start"));
    const workbenchOpenIndex = button("只做一次完整校正", "", () => void performWorkbenchOpenAction("index"));
    const workbenchOpenLater = button("稍後再說", "", deferWorkbenchOpen);
    const workbenchOpenDisable = button("不再提醒", "danger", () => void disableWorkbenchOpen());
    workbenchOpenStart.id = "workbench-open-start";
    workbenchOpenIndex.id = "workbench-open-index";
    workbenchOpenLater.id = "workbench-open-later";
    workbenchOpenDisable.id = "workbench-open-disable";
    workbenchOpenActions.append(workbenchOpenStart, workbenchOpenIndex, workbenchOpenLater, workbenchOpenDisable);
    workbenchOpenBanner.append(workbenchOpenTitle, workbenchOpenMessage, workbenchOpenWarning, workbenchOpenStatus, workbenchOpenActions);
    main.append(workbenchOpenBanner);
    const startupCatchupBanner = make("section", "startup-catchup-banner", "");
    startupCatchupBanner.id = "startup-catchup-banner";
    startupCatchupBanner.hidden = true;
    startupCatchupBanner.setAttribute("role", "region");
    startupCatchupBanner.setAttribute("aria-labelledby", "startup-catchup-title");
    const startupCatchupTitle = make("h2", "", "開機補捉提醒"); startupCatchupTitle.id = "startup-catchup-title";
    const startupCatchupMessage = make("p", "", "背景自動更新離線期間可能有變更尚未檢查。"); startupCatchupMessage.id = "startup-catchup-message";
    const startupCatchupWarning = make("p", "startup-catchup-warning", ""); startupCatchupWarning.id = "startup-catchup-warning"; startupCatchupWarning.hidden = true;
    const startupCatchupStatus = make("div", "status startup-catchup-status", ""); startupCatchupStatus.id = "startup-catchup-status"; startupCatchupStatus.setAttribute("role", "status"); startupCatchupStatus.setAttribute("aria-live", "polite");
    const startupCatchupActions = make("div", "startup-catchup-actions", "");
    const startupCatchupStart = button("立即補捉", "primary", () => void performStartupCatchupAction("start"));
    const startupCatchupLater = button("稍後提醒", "", deferStartupCatchup);
    const startupCatchupSkip = button("略過本次", "", () => void performStartupCatchupAction("skip"));
    const startupCatchupDisable = button("關閉開機補捉", "danger", () => void disableStartupCatchup());
    startupCatchupStart.id = "startup-catchup-start";
    startupCatchupLater.id = "startup-catchup-later";
    startupCatchupSkip.id = "startup-catchup-skip";
    startupCatchupDisable.id = "startup-catchup-disable";
    startupCatchupActions.append(startupCatchupStart, startupCatchupLater, startupCatchupSkip, startupCatchupDisable);
    startupCatchupBanner.append(startupCatchupTitle, startupCatchupMessage, startupCatchupWarning, startupCatchupStatus, startupCatchupActions);
    main.append(startupCatchupBanner);
    const docPage = make("section", "page", ""); docPage.dataset.page = "documents"; docPage.setAttribute("aria-labelledby", "documents-heading"); docPage.id = "documents-page";
    const docHeader = makePageHeader("文件", "搜尋、篩選並選取要加入上下文的來源。"); docHeader.querySelector("h1").id = "documents-heading";
    const selectLabel = make("span", "button-label", "選取："); const selectPage = button("本頁", "", () => { if (state.data) for (const item of state.data.results) toggleSelection(item, true); }); selectPage.id = "select-page";
    const selectAll = button("全部", "", () => void selectAllAccessible()); selectAll.id = "select-all"; selectAll.title = "選取全部目前可瀏覽結果";
    const viewList = button("☷", "", () => { state.viewMode = "list"; renderDocuments(); }); viewList.id = "view-list"; viewList.setAttribute("aria-label", "清單檢視");
    const viewTable = button("▤", "", () => { state.viewMode = "table"; renderDocuments(); }); viewTable.id = "view-table"; viewTable.setAttribute("aria-label", "表格檢視");
    const views = make("div", "segmented"); views.setAttribute("role", "group"); views.setAttribute("aria-label", "文件顯示模式"); views.append(viewList, viewTable);
    const sortSelect = document.createElement("select"); sortSelect.id = "document-sort"; sortSelect.className = "btn";
    sortSelect.setAttribute("aria-label", "排序規則");
    sortSelect.append(new Option("目前結果：相關性", "relevance"),
      new Option("目前結果：檔名 A → Z", "filename"), new Option("目前結果：最近修改優先", "modified"));
    sortSelect.addEventListener("change", () => { state.sortMode = sortSelect.value; renderDocuments(); });
    docHeader.actions.append(selectLabel, selectPage, selectAll, views, sortSelect); docPage.append(docHeader);
    const scopeBar = make("form", "scope-bar"); scopeBar.id = "document-search-form";
    const queryWrap = make("label", "document-query"); queryWrap.htmlFor = "document-query"; const queryField = document.createElement("select"); queryField.id = "query-field"; queryField.setAttribute("aria-label", "搜尋欄位"); queryField.append(new Option("檔名與內容", "all"), new Option("只搜尋檔名", "filename"), new Option("只搜尋內容", "content")); const pageQuery = document.createElement("input"); pageQuery.id = "document-query"; pageQuery.type = "search"; pageQuery.maxLength = 1000; pageQuery.autocomplete = "off"; pageQuery.placeholder = "搜尋"; queryWrap.append(queryField, pageQuery);
    const modeSwitch = make("div", "mode-switch"); modeSwitch.setAttribute("role", "group"); modeSwitch.setAttribute("aria-label", "搜尋模式"); const phrase = button("完整片語 ×", "filter-choice", () => setMode("all-terms")); phrase.id = "mode-phrase"; phrase.dataset.mode = "phrase"; const allTerms = button("全部詞彙 ×", "filter-choice", () => setMode("phrase")); allTerms.id = "mode-all-terms"; allTerms.dataset.mode = "all-terms"; modeSwitch.append(phrase, allTerms);
    const searchButton = button("搜尋", "primary search-submit", () => void search(1)); searchButton.id = "document-search-button";
    const cancelButton = button("取消搜尋", "danger search-cancel", cancelSearch); cancelButton.id = "search-cancel-button"; cancelButton.hidden = true;
    const summaries = make("div", "scope-summaries"); summaries.append(scopeSummary("根目錄", "scope-root"), scopeSummary("格式", "scope-format"), scopeSummary("解析狀態", "scope-parse"));
    const resetFilters = button("重設篩選", "filter-reset", () => {
      state.searchField = "all"; state.rootFilter = ""; state.typeFilter = ""; state.statusFilter = ""; state.sortMode = "relevance";
      queryField.value = "all"; sortSelect.value = "relevance"; renderScopeSummaries(); if (state.submittedQuery || state.queryDraft.trim()) void search(1);
    }); resetFilters.id = "reset-filters";
    scopeBar.append(queryWrap, summaries, modeSwitch, resetFilters, searchButton, cancelButton); docPage.append(scopeBar);
    const searchStatus = make("div", "status", "尚未搜尋。"); searchStatus.id = "search-status"; searchStatus.setAttribute("role", "status"); searchStatus.setAttribute("aria-live", "polite"); docPage.append(searchStatus);
    const resultToolbar = make("div", "results-toolbar"); const resultCopy = make("div", "", ""); resultCopy.append(make("strong", "", "尚未搜尋"), make("span", "", "")); resultCopy.lastChild.id = "results-subtitle"; resultCopy.firstChild.id = "results-title"; const pagination = make("div", "pagination"); const paginationLabel = make("span", "pagination-label", "1"); paginationLabel.id = "pagination-label"; const prev = button("‹", "small", () => void search((state.data?.page || 1) - 1)); prev.id = "documents-prev"; prev.setAttribute("aria-label", "上一頁"); const next = button("›", "small", () => void search((state.data?.page || 1) + 1)); next.id = "documents-next"; next.setAttribute("aria-label", "下一頁"); pagination.append(prev, paginationLabel, next); resultToolbar.append(resultCopy, pagination); docPage.append(resultToolbar);
    const resultList = make("div", "result-list", ""); resultList.id = "document-list"; docPage.append(resultList);
    const tableWrap = make("div", "table-wrap", ""); tableWrap.id = "document-table-wrap"; const table = document.createElement("table"); table.className = "documents-table"; const thead = document.createElement("thead"); const headRow = document.createElement("tr"); for (const label of ["選取", "標題", "根目錄", "格式", "命中位置", "狀態"]) headRow.append(make("th", "", label)); thead.append(headRow); const tbody = document.createElement("tbody"); tbody.id = "document-table-body"; table.append(thead, tbody); tableWrap.append(table); docPage.append(tableWrap);
    const bulk = make("div", "bulk-bar", ""); bulk.id = "bulk-bar"; const selectionLabel = make("strong", "", ""); selectionLabel.id = "selection-label"; const review = button("加入上下文", "primary", openPreview); review.id = "review-context"; const clear = button("清除選取", "", () => { state.selected.clear(); for (const item of state.imported.values()) item.selected = false; invalidatePreview("選取已清除；請重新產生精確預覽。", true); }); bulk.append(selectionLabel, review, clear); docPage.append(bulk); main.append(docPage);

    const temporaryPage = make("section", "page", ""); temporaryPage.dataset.page = "temporary"; temporaryPage.id = "temporary-page"; const tempHeader = makePageHeader("臨時文件", "本次工作階段解析，不加入永久索引。"); const tempCount = make("strong", "sr-only", "0 / 20 份"); tempCount.id = "temporary-count"; tempHeader.actions.append(tempCount, button("選取文件", "primary", () => $("file-input").click())); temporaryPage.append(tempHeader); const drop = make("div", "drop-zone", ""); drop.id = "drop-zone"; drop.tabIndex = 0; drop.setAttribute("role", "button"); drop.setAttribute("aria-label", "拖曳或選取文件"); drop.append(make("strong", "", "拖曳文件到這裡"), make("small", "", "目前有 0 份臨時文件可加入上下文。")); drop.querySelector("small").id = "drop-help"; temporaryPage.append(drop); const fileInput = document.createElement("input"); fileInput.id = "file-input"; fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true; temporaryPage.append(fileInput); const fileStatus = make("div", "status", ""); fileStatus.id = "file-status-message"; fileStatus.setAttribute("role", "status"); fileStatus.setAttribute("aria-live", "polite"); temporaryPage.append(fileStatus); const fileList = make("div", "file-list", ""); fileList.id = "file-list"; temporaryPage.append(fileList); main.append(temporaryPage);

    const rootsPage = make("section", "page", ""); rootsPage.dataset.page = "roots"; rootsPage.id = "roots-page"; const rootsHeader = makePageHeader("索引根目錄", "「完整校正」會列舉所有檔案比較 metadata，但只重新解析新增或變更的文件；日常更新可在設定開啟背景自動更新。"); const rootRefresh = button("完整校正", "", () => void runIndex()); rootRefresh.id = "roots-refresh"; const rootStop = button("停止同步", "danger", () => void stopIndex()); rootStop.id = "roots-stop"; rootStop.hidden = true; const rootChoose = button("加入資料夾", "primary", () => void chooseFolder()); rootChoose.id = "root-choose"; rootsHeader.actions.append(rootRefresh, rootStop, rootChoose); rootsPage.append(rootsHeader); const indexStatusMessage = make("div", "status", "讀取中…"); indexStatusMessage.id = "index-status-message"; indexStatusMessage.setAttribute("role", "status"); indexStatusMessage.setAttribute("aria-live", "polite"); rootsPage.append(indexStatusMessage); const rootsPanel = make("section", "root-list-panel", ""); rootsPage.append(rootsPanel); const rootsToolbar = make("div", "root-toolbar", ""); const rootSelectAll = document.createElement("input"); rootSelectAll.type = "checkbox"; rootSelectAll.id = "root-select-all"; rootSelectAll.setAttribute("aria-label", "選取全部根目錄"); rootSelectAll.addEventListener("change", () => { state.selectedRoots.clear(); if (rootSelectAll.checked && state.indexStatus && state.indexStatus.roots) for (const item of state.indexStatus.roots) state.selectedRoots.add(item.path); renderRoots(); }); const rootDeleteSelected = button("移除所選", "danger", () => requestDelete("roots")); rootDeleteSelected.id = "root-delete-selected"; rootsToolbar.append(rootSelectAll, make("span", "", "選取全部"), rootDeleteSelected); rootsPanel.append(rootsToolbar); const rootsTable = document.createElement("table"); rootsTable.className = "roots-table"; const rootsHead = document.createElement("thead"); const rootsHeadRow = document.createElement("tr"); for (const label of ["", "根目錄", "文件", "同步", "完整性", "操作"]) rootsHeadRow.append(make("th", "", label)); rootsHead.append(rootsHeadRow); const rootsBody = document.createElement("tbody"); rootsBody.id = "roots-body"; rootsTable.append(rootsHead, rootsBody); rootsPanel.append(rootsTable);
    const rootRefreshFolder = button("重新檢查資料夾", "", () => void chooseRefreshFolder()); rootRefreshFolder.id = "roots-refresh-folder"; rootsHeader.actions.insertBefore(rootRefreshFolder, rootChoose);
    rootsHeadRow.lastChild.textContent = "";
    rootsHeadRow.insertBefore(make("th", "", "預設排除"), rootsHeadRow.lastChild);
    const addPanel = make("section", "panel root-add", ""); addPanel.id = "root-add-panel"; const addHead = make("div", "panel-head", ""); addHead.append(make("div", "", "")); addHead.firstChild.append(make("h2", "", "加入資料夾"), make("p", "", "選擇資料夾後，按「確認並建立索引」才會開始。只索引選取的資料夾，不要選整顆系統磁碟。")); addPanel.append(addHead); const rootInstructions = make("p", "root-instructions", "取消選擇或尚未確認不會送出索引；選取路徑為唯讀。"); addPanel.append(rootInstructions); const addBody = make("div", "root-add-body", ""); const addField = make("div", "root-add-field", ""); const addLabel = make("label", "", "已選資料夾"); addLabel.htmlFor = "root-draft"; const rootDraft = document.createElement("input"); rootDraft.id = "root-draft"; rootDraft.readOnly = true; rootDraft.placeholder = "尚未選擇資料夾"; rootDraft.setAttribute("aria-readonly", "true"); addField.append(addLabel, rootDraft); const draftMessage = make("div", "status", "尚未選取資料夾。"); draftMessage.id = "root-draft-message"; addField.append(draftMessage); const chooseButton = button("重新選擇", "", () => void chooseFolder()); chooseButton.id = "root-choose-inline"; chooseButton.addEventListener("click", () => void chooseFolder()); const confirmButton = button("確認並建立索引", "primary", requestAddRoot); confirmButton.id = "root-confirm"; addBody.append(addField, chooseButton, confirmButton); addPanel.append(addBody); rootsPage.append(addPanel); main.append(rootsPage);
    addHead.querySelector("p").textContent = "選擇資料夾後，確認前會顯示預設排除位置；只索引選取的資料夾。";
    rootInstructions.textContent = "取消選擇或尚未確認不會送出索引；選取路徑為唯讀。整顆本機磁碟也會先顯示會預設略過哪些位置。";
    const rootExclusionPreview = make("section", "root-exclusion-preview", "");
    rootExclusionPreview.id = "root-exclusion-preview";
    rootExclusionPreview.hidden = true;
    addPanel.insertBefore(rootExclusionPreview, addBody);

    const trashPage = make("section", "page", ""); trashPage.dataset.page = "trash"; trashPage.id = "trash-page"; const trashHeader = makePageHeader("垃圾桶", "這裡只保存被移除的索引記錄；來源資料仍在原位置。"); const purgeSelected = button("永久刪除所選", "danger", () => requestDelete("trash")); purgeSelected.id = "trash-purge-selected"; trashHeader.actions.append(purgeSelected); trashPage.append(trashHeader); const trashStatus = make("div", "status", ""); trashStatus.id = "trash-status-message"; trashStatus.setAttribute("role", "status"); trashStatus.setAttribute("aria-live", "polite"); trashPage.append(trashStatus); const trashPanel = make("section", "trash-list-panel", ""); const trashToolbar = make("div", "trash-toolbar", ""); const trashSelectAll = document.createElement("input"); trashSelectAll.type = "checkbox"; trashSelectAll.className = "table-check"; trashSelectAll.id = "trash-select-all"; trashSelectAll.setAttribute("aria-label", "全選垃圾桶項目"); trashSelectAll.addEventListener("change", () => { state.selectedTrash.clear(); if (trashSelectAll.checked && state.indexStatus?.trash) for (const item of state.indexStatus.trash) state.selectedTrash.add(item.path); renderTrash(); }); const trashSelectLabel = make("label", "", ""); trashSelectLabel.htmlFor = "trash-select-all"; trashSelectLabel.append(trashSelectAll, make("span", "", "全選垃圾桶項目")); const trashToolbarActions = make("div", "button-row", ""); const restoreSelected = button("還原選取並重新索引", "primary", () => void restoreTrash(Array.from(state.selectedTrash))); restoreSelected.id = "trash-restore-selected"; trashToolbarActions.append(restoreSelected); trashToolbar.append(trashSelectLabel, trashToolbarActions); trashPanel.append(trashToolbar); const trashTable = document.createElement("table"); trashTable.className = "trash-table"; const trashHead = document.createElement("thead"); const trashHeadRow = document.createElement("tr"); for (const label of ["", "根目錄", "操作"]) trashHeadRow.append(make("th", "", label)); trashHead.append(trashHeadRow); const trashBody = document.createElement("tbody"); trashBody.id = "trash-body"; trashTable.append(trashHead, trashBody); trashPanel.append(trashTable); trashPage.append(trashPanel); main.append(trashPage);
    shell.append(main); app.append(shell);

    const scrim = make("button", "scrim", ""); scrim.id = "scrim"; scrim.type = "button"; scrim.setAttribute("aria-label", "關閉上下文抽屜"); scrim.hidden = true; scrim.addEventListener("click", closeContext); app.append(scrim);
    const drawer = make("div", "context-drawer", ""); drawer.id = "context-drawer"; drawer.hidden = true; drawer.setAttribute("aria-hidden", "true"); drawer.setAttribute("inert", ""); drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-labelledby", "context-title"); const drawerHead = make("div", "context-drawer-head", ""); const drawerTitle = make("div", "", ""); drawerTitle.append(make("h2", "", "已選上下文"), make("p", "", "")); drawerTitle.firstChild.id = "context-title"; drawerTitle.lastChild.id = "context-count"; const drawerClose = iconButton("×", "關閉上下文抽屜", closeContext); drawerClose.id = "context-close"; drawerHead.append(drawerTitle, drawerClose); const drawerBody = make("div", "context-drawer-body", ""); const indexedSection = make("section", "context-section", ""); indexedSection.append(make("h3", "", "已索引文件")); const indexedList = make("div", "", ""); indexedList.id = "context-indexed-list"; indexedSection.append(indexedList); const temporarySection = make("section", "context-section", ""); temporarySection.append(make("h3", "", "本次臨時文件")); const temporaryList = make("div", "", ""); temporaryList.id = "context-temporary-list"; temporarySection.append(temporaryList); drawerBody.append(indexedSection, temporarySection); const drawerFooter = make("div", "context-drawer-footer", ""); const drawerPreview = button("檢查精確上下文", "primary", openPreview); drawerPreview.id = "context-open-preview"; drawerFooter.append(drawerPreview); drawer.append(drawerHead, drawerBody, drawerFooter); app.append(drawer);

    const previewDialog = document.createElement("dialog"); previewDialog.id = "preview-dialog"; previewDialog.className = "preview-dialog"; previewDialog.setAttribute("aria-labelledby", "preview-title"); const previewHeadDialog = make("div", "dialog-head", ""); const previewHeading = make("div", "", ""); previewHeading.append(make("h2", "", "檢查精確上下文"), make("p", "", "重新驗證來源後顯示 server context；不包含完整文件。")); previewHeading.firstChild.id = "preview-title"; const previewClose = iconButton("×", "關閉精確上下文預覽", () => previewDialog.close()); previewHeadDialog.append(previewHeading, previewClose); const previewBodyDialog = make("div", "dialog-body", ""); const previewMeta = make("div", "preview-meta", "尚未產生 server 預覽。"); previewMeta.id = "preview-meta"; const previewText = make("pre", "preview-text", "尚未產生預覽。"); previewText.id = "preview-text"; const progress = document.createElement("progress"); progress.className = "preview-progress"; progress.id = "preview-progress"; progress.max = 262144; progress.value = 0; progress.setAttribute("aria-label", "精確上下文 bytes，最多 256 KiB"); const previewStatus = make("div", "preview-status", "待產生精確預覽。"); previewStatus.id = "preview-status"; previewStatus.setAttribute("role", "status"); previewStatus.setAttribute("aria-live", "polite"); previewBodyDialog.append(previewMeta, previewText, progress, previewStatus); const previewActions = make("div", "dialog-actions", ""); const copy = button("複製預覽", "primary", () => void copyPreview()); copy.id = "copy-preview"; copy.disabled = true; const previewCancel = button("關閉", "", () => previewDialog.close()); previewActions.append(previewCancel, copy); previewDialog.append(previewHeadDialog, previewBodyDialog, previewActions); app.append(previewDialog);

    const settingsDialog = document.createElement("dialog"); settingsDialog.id = "settings-dialog"; settingsDialog.className = "settings-dialog"; settingsDialog.setAttribute("aria-labelledby", "settings-title");
    const settingsHead = make("div", "dialog-head", ""); const settingsHeading = make("div", "", ""); settingsHeading.append(make("h2", "", "設定")); settingsHeading.firstChild.id = "settings-title"; const settingsClose = iconButton("×", "關閉設定", () => settingsDialog.close()); settingsHead.append(settingsHeading, settingsClose);
    const settingsBody = make("div", "dialog-body", ""); settingsBody.append(make("p", "", "管理工作台與索引更新。"));
    const settingLabel = settingSwitch("settings-delete-confirmation", "settings-delete-confirmation-label", "刪除索引目錄前顯示確認", enabled => saveDeleteConfirmation(enabled));
    const autoupdateSection = make("section", "settings-section", "");
    const autoupdateLabel = settingSwitch("settings-autoupdate", "settings-autoupdate-label", "背景自動更新", enabled => saveAutoupdate(enabled));
    const startupLabel = settingSwitch("settings-autoupdate-startup", "settings-autoupdate-startup-label", "登入 Windows 時自動啟動背景自動更新", enabled => saveAutoupdateStartup(enabled));
    const startupHelp = make("p", "settings-help", "僅 Windows 支援"); startupHelp.id = "settings-autoupdate-startup-help";
    const workbenchOpenModeSection = make("section", "startup-catchup-mode-section", "");
    const workbenchOpenModeRow = make("div", "startup-catchup-mode-row", "");
    const workbenchOpenModeLabelNode = make("label", "", "");
    workbenchOpenModeLabelNode.htmlFor = "settings-workbench-open-mode";
    workbenchOpenModeLabelNode.append(make("strong", "", "工作台開啟提醒策略"), make("span", "startup-catchup-mode-help", "開啟工作台時，若背景更新沒在執行要怎麼處理。"));
    const workbenchOpenModeSelect = document.createElement("select");
    workbenchOpenModeSelect.id = "settings-workbench-open-mode";
    workbenchOpenModeSelect.setAttribute("aria-label", "工作台開啟提醒策略");
    workbenchOpenModeSelect.setAttribute("aria-describedby", "workbench-open-mode-status");
    workbenchOpenModeSelect.append(new Option("開啟時提醒", "ask"), new Option("開啟時自動補捉", "auto"), new Option("不主動處理", "off"));
    workbenchOpenModeSelect.addEventListener("change", () => void saveWorkbenchOpenMode(workbenchOpenModeSelect.value));
    workbenchOpenModeRow.append(workbenchOpenModeLabelNode, workbenchOpenModeSelect);
    const workbenchOpenModeStatus = make("p", "startup-catchup-mode-status", "目前策略：開啟時提醒");
    workbenchOpenModeStatus.id = "workbench-open-mode-status";
    workbenchOpenModeStatus.setAttribute("role", "status");
    workbenchOpenModeStatus.setAttribute("aria-live", "polite");
    workbenchOpenModeSection.append(workbenchOpenModeRow, workbenchOpenModeStatus);
    const startupCatchupModeSection = make("section", "startup-catchup-mode-section", "");
    const startupCatchupModeRow = make("div", "startup-catchup-mode-row", "");
    const startupCatchupModeLabel = make("label", "", "");
    startupCatchupModeLabel.htmlFor = "settings-startup-catchup-mode";
    startupCatchupModeLabel.append(make("strong", "", "開機補捉策略"), make("span", "startup-catchup-mode-help", "背景更新重新啟動後如何處理離線期間的變更。"));
    const startupCatchupModeSelect = document.createElement("select");
    startupCatchupModeSelect.id = "settings-startup-catchup-mode";
    startupCatchupModeSelect.setAttribute("aria-label", "開機補捉策略");
    startupCatchupModeSelect.setAttribute("aria-describedby", "startup-catchup-mode-status");
    startupCatchupModeSelect.append(new Option("詢問後補捉", "ask"), new Option("自動補捉", "auto"), new Option("不補捉", "off"));
    startupCatchupModeSelect.addEventListener("change", () => void saveStartupCatchupMode(startupCatchupModeSelect.value));
    startupCatchupModeRow.append(startupCatchupModeLabel, startupCatchupModeSelect);
    const startupCatchupModeStatus = make("p", "startup-catchup-mode-status", "目前策略：自動補捉");
    startupCatchupModeStatus.id = "startup-catchup-mode-status";
    startupCatchupModeStatus.setAttribute("role", "status");
    startupCatchupModeStatus.setAttribute("aria-live", "polite");
    startupCatchupModeSection.append(startupCatchupModeRow, startupCatchupModeStatus);
    const autoupdateSettings = make("div", "autoupdate-settings", "");
    const autoupdateSettingsHead = make("div", "autoupdate-settings-head", ""); autoupdateSettingsHead.append(make("strong", "", "背景自動更新狀態")); const autoupdateRefresh = button("重新整理", "", () => void refreshStatus()); autoupdateRefresh.id = "settings-autoupdate-refresh"; autoupdateSettingsHead.append(autoupdateRefresh); autoupdateSettings.append(autoupdateSettingsHead);
    const autoupdateStatus = make("div", "status autoupdate-status", "尚未讀取背景自動更新狀態。"); autoupdateStatus.id = "settings-autoupdate-status"; autoupdateStatus.setAttribute("role", "status"); autoupdateStatus.setAttribute("aria-live", "polite"); autoupdateSettings.append(autoupdateStatus);
    const autoupdateSummary = make("div", "autoupdate-summary", ""); autoupdateSummary.id = "settings-autoupdate-summary"; autoupdateSummary.hidden = true; autoupdateSettings.append(autoupdateSummary);
    const debounceRow = make("div", "settings-number-row", ""); const debounceLabel = make("label", "", ""); debounceLabel.htmlFor = "settings-autoupdate-debounce"; debounceLabel.append(make("strong", "", "變更等待"), make("small", "", "秒（0.2～60）")); const debounceField = document.createElement("input"); debounceField.type = "number"; debounceField.id = "settings-autoupdate-debounce"; debounceField.min = "0.2"; debounceField.max = "60"; debounceField.step = "0.1"; debounceField.addEventListener("change", () => void saveAutoupdateParameters()); debounceRow.append(debounceLabel, debounceField); autoupdateSettings.append(debounceRow);
    const reconcileRow = make("div", "settings-number-row", ""); const reconcileLabel = make("label", "", ""); reconcileLabel.htmlFor = "settings-autoupdate-reconcile"; reconcileLabel.append(make("strong", "", "完整校正間隔"), make("small", "", "小時（0.25～24）")); const reconcileField = document.createElement("input"); reconcileField.type = "number"; reconcileField.id = "settings-autoupdate-reconcile"; reconcileField.min = "0.25"; reconcileField.max = "24"; reconcileField.step = "0.25"; reconcileField.addEventListener("change", () => void saveAutoupdateParameters()); reconcileRow.append(reconcileLabel, reconcileField); autoupdateSettings.append(reconcileRow);
    autoupdateSection.append(autoupdateLabel, startupLabel, startupHelp, workbenchOpenModeSection, startupCatchupModeSection, autoupdateSettings);
    const totalLabelEl = settingSwitch("settings-total-exact", "settings-total-exact-label", "精確計算總筆數（預設快速：超過 500 筆顯示「500 筆以上」；精確模式在常見詞上會晚幾秒補上總數）", enabled => saveTotalMode(enabled));
    const exclusionPolicySection = make("section", "settings-section", "");
    exclusionPolicySection.id = "settings-exclusion-policy";
    exclusionPolicySection.append(make("h2", "", "哪些位置預設不索引"), make("p", "settings-help", "Seekah 會依目前根目錄與平台規則略過系統資料、內部資料與使用者排除規則；規則、逐規則略過計數與清理進度只讀顯示。"));
    const exclusionPolicyList = make("div", "settings-exclusion-policy-list", "");
    exclusionPolicyList.id = "settings-exclusion-policy-list";
    exclusionPolicySection.append(exclusionPolicyList);
    settingsBody.append(exclusionPolicySection);
    settingsBody.append(settingLabel, autoupdateSection, totalLabelEl); const settingsStatus = make("div", "status", ""); settingsStatus.id = "settings-status"; settingsStatus.setAttribute("role", "status"); settingsStatus.setAttribute("aria-live", "polite"); settingsBody.append(settingsStatus); const settingsActions = make("div", "dialog-actions", ""); settingsActions.append(button("完成", "primary", () => settingsDialog.close())); settingsDialog.append(settingsHead, settingsBody, settingsActions); app.append(settingsDialog);

    const deleteDialog = document.createElement("dialog"); deleteDialog.id = "delete-dialog"; deleteDialog.className = "delete-dialog"; deleteDialog.setAttribute("aria-labelledby", "delete-title"); const deleteHead = make("div", "dialog-head", ""); const deleteHeading = make("div", "", ""); deleteHeading.append(make("h2", "", "確認操作"), make("p", "", "")); deleteHeading.firstChild.id = "delete-title"; deleteHeading.lastChild.id = "delete-message"; const deleteClose = iconButton("×", "取消刪除操作", () => deleteDialog.close()); deleteHead.append(deleteHeading, deleteClose); const deleteBody = make("div", "dialog-body", ""); const deleteDetail = make("div", "delete-detail", ""); deleteDetail.id = "delete-detail"; const deleteWarning = make("div", "delete-warning", ""); deleteWarning.id = "delete-warning"; deleteBody.append(deleteDetail, deleteWarning); const deleteActions = make("div", "dialog-actions", ""); const dontRemindLabel = make("label", "setting-check", ""); dontRemindLabel.id = "delete-dont-remind-row"; const dontRemind = document.createElement("input"); dontRemind.type = "checkbox"; dontRemind.id = "delete-dont-remind"; dontRemindLabel.append(dontRemind, make("span", "", "下次不再提醒（可在設定重新開啟）")); const deleteCancel = button("取消", "", () => deleteDialog.close()); const deleteConfirm = button("確認", "danger-fill", () => { const pending = state.pendingDelete; if (!pending) return; const dont = $("delete-dont-remind").checked; state.pendingDelete = null; deleteDialog.close(); void executeDelete(pending.kind, pending.paths, dont); }); deleteConfirm.id = "delete-confirm"; deleteActions.append(dontRemindLabel, deleteCancel, deleteConfirm); deleteDialog.append(deleteHead, deleteBody, deleteActions); app.append(deleteDialog);
    const toast = make("div", "toast", ""); toast.id = "toast"; toast.hidden = true; toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite"); app.append(toast);

    state.viewMode = "list";
    switchPageVisibility();
    renderDocuments(); renderTemporary(); renderRoots(); renderTrash(); renderContextDrawer();
    for (const dialog of [previewDialog, settingsDialog, deleteDialog]) dialog.addEventListener("close", restoreDialogFocus);
    globalQuery.addEventListener("input", () => { state.queryDraft = globalQuery.value; pageQuery.value = state.queryDraft; });
    pageQuery.addEventListener("input", () => { state.queryDraft = pageQuery.value; globalQuery.value = state.queryDraft; });
    globalQuery.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); routeFromTopSearch(); void search(1); } });
    pageQuery.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void search(1); } });
    scopeBar.addEventListener("submit", event => { event.preventDefault(); void search(1); });
    queryField.addEventListener("change", () => { state.searchField = queryField.value; if (state.submittedQuery) void search(1); });
    sortSelect.value = state.sortMode;
    fileInput.addEventListener("change", () => { void upload(fileInput.files); fileInput.value = ""; });
    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); } });
    drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("is-dragging"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-dragging"));
    drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("is-dragging"); void upload(event.dataTransfer.files); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("context-drawer").hidden) closeContext(); });
    $("view-list").setAttribute("aria-pressed", "true"); $("view-table").setAttribute("aria-pressed", "false");
    $("mode-phrase").setAttribute("aria-pressed", "true"); $("mode-all-terms").setAttribute("aria-pressed", "false");
    $("trash-status-message").textContent = "垃圾桶只保存索引 metadata；來源資料不會被刪除。";
  }
  function scopeSummary(label, id) {
    const wrapper = make("label", "scope-summary", "");
    wrapper.append(make("strong", "", label));
    const value = document.createElement("select"); value.id = id; value.setAttribute("aria-label", label);
    value.addEventListener("change", () => {
      if (id === "scope-root") state.rootFilter = value.value;
      if (id === "scope-format") state.typeFilter = value.value;
      if (id === "scope-parse") state.statusFilter = value.value;
      if (state.submittedQuery) void search(1);
    });
    wrapper.append(value); return wrapper;
  }
  function setMode(mode) {
    if (state.mode === mode) return;
    if (state.searchController) state.searchController.abort();
    clearSearchCancellation();
    state.searchController = null;
    state.mode = mode;
    state.data = null;
    state.submittedQuery = "";
    state.queryDraft = "";
    state.searchState = "idle";
    state.searchSeq++;
    clearIndexedSelection("搜尋模式已切換；已清除索引選取與舊結果，保留臨時文件。");
    $("mode-phrase").setAttribute("aria-pressed", String(mode === "phrase"));
    $("mode-all-terms").setAttribute("aria-pressed", String(mode === "all-terms"));
    syncQueryInputs();
    renderDocuments();
  }
  async function loadState() {
    try {
      const data = await api("/api/state");
      state.supportedExtensions = Array.isArray(data.supportedExtensions) ? data.supportedExtensions : [];
      renderScopeSummaries(); renderTemporary();
    } catch (error) { setStatus("search-status", error.message || "工作台狀態讀取失敗。", "error"); }
  }
  async function initialize() {
    await loadState();
    await refreshStatus();
  }
  buildApp();
  setInterval(() => { if (isIndexing()) void refreshStatus(); }, 750);
  void initialize();
})();
</script>
</body>
</html>`;
}
