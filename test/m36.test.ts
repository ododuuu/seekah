import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { classifyReprocess, TEXT_PARSE_VERSION } from "../src/model.js";
import { assertProfileIsAnonymous, reserveNewProfile } from "../src/profile.js";
import { formatProgressLine } from "../src/progress.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import {
  completeTuiCommand, decodeTuiKey, displayWidth, initialTuiState, parseTuiInput, reduceTuiState,
  renderTuiScreen, runTui, TuiInputDecoder, type TuiEvent,
} from "../src/tui.js";
import { productVersion } from "../src/version.js";

const cli = path.resolve("dist/src/cli.js");

async function fixture(run: (root: string, store: IndexStore, temp: string) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m36-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  const store = new IndexStore(path.join(temp, "index.db"));
  try { await run(root, store, temp); }
  finally { store.close(); await rm(temp, { recursive: true, force: true }); }
}

test("0.36 reprocess reasons stay on parse version 1 and do not treat VSD as text upgrade", () => {
  assert.equal(TEXT_PARSE_VERSION, 1);
  assert.equal(classifyReprocess({ rebuild: true, previous: null, extension: ".txt", sizeBytes: 1, modifiedAtMs: 1 }), "rebuild");
  assert.equal(classifyReprocess({ previous: null, extension: ".txt", sizeBytes: 1, modifiedAtMs: 1 }), "added");
  assert.equal(classifyReprocess({
    previous: { status: "indexed", parse_version: 1, size_bytes: 1, modified_at_ms: 1 },
    extension: ".txt", sizeBytes: 2, modifiedAtMs: 1,
  }), "source-changed");
  assert.equal(classifyReprocess({
    previous: { status: "error", parse_version: 1, size_bytes: 1, modified_at_ms: 1 },
    extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
  }), "error-retry");
  assert.equal(classifyReprocess({
    previous: { status: "indexed", parse_version: null, size_bytes: 1, modified_at_ms: 1 },
    extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
  }), "text-upgrade");
  assert.equal(classifyReprocess({
    previous: { status: "too_large", parse_version: null, size_bytes: 1, modified_at_ms: 1 },
    extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
  }), "unchanged");
  assert.equal(classifyReprocess({
    previous: { status: "unsupported", parse_version: null, size_bytes: 1, modified_at_ms: 1 },
    extension: ".vsd", sizeBytes: 1, modifiedAtMs: 1,
  }), "unsupported-retry");
  assert.equal(classifyReprocess({
    previous: { status: "indexed", parse_version: 1, size_bytes: 1, modified_at_ms: 1 },
    extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
  }), "unchanged");
});

test("0.36 progress names check phase, keeps heartbeat data and hides paths unless verbose", () => {
  const line = formatProgressLine({
    stage: "read", message: "檢查文件", current: 2, total: 10, checked: 2, skipped: 1, committed: 1,
    parserCalls: 1, failed: 0, phase: "讀取／解析", phaseStartedMs: 0, path: "/secret/a.txt",
    slow: { extension: ".txt", bytes: 10, phase: "讀取／解析", elapsedMs: 6000, reason: "新增" },
  }, { elapsedMs: 7000, nowMs: 1500, verbose: false });
  assert.match(line, /檢查進度/);
  assert.match(line, /已檢查 2、略過 1、已提交 1、parser 1、失敗 0/);
  assert.match(line, /慢檔 \.txt/);
  assert.doesNotMatch(line, /secret/);
  assert.match(formatProgressLine({ stage: "cancelled", message: "操作已取消" }, { elapsedMs: 1 }), /操作已取消/);
  assert.doesNotMatch(formatProgressLine({ stage: "cancelled", message: "操作已取消" }, { elapsedMs: 1 }), /100\.00%/);
});

test("0.36 terminal width treats CJK as two columns and completion does not hijack prose", () => {
  assert.equal(displayWidth("中文A"), 5);
  assert.equal(displayWidth("a"), 1);
  assert.deepEqual(completeTuiCommand("/he"), ["/help "]);
  assert.deepEqual(completeTuiCommand("中文"), []);
  assert.equal(parseTuiInput("./help").kind, "command");
  assert.equal(parseTuiInput("help").kind, "search");
  assert.equal(parseTuiInput("./notes").kind, "search");
  assert.equal(parseTuiInput("/madeup").kind, "unknown");
  assert.equal(parseTuiInput("/search ./help").kind, "command");
});

test("0.36 index reuses upgraded text, retries unsupported once, and keeps document id", () => fixture(async (root, store) => {
  const txt = path.join(root, "筆記.txt");
  const csv = path.join(root, "表.csv");
  await writeFile(txt, "沿用索引");
  await writeFile(csv, "名稱,值\n甲,乙");
  store.registerRoot(root);
  const info = await stat(csv);
  store.upsert({ path: csv, filename: "表.csv", extension: ".csv", sizeBytes: info.size, modifiedAtMs: info.mtimeMs,
    status: "unsupported", errorCode: "UNSUPPORTED_EXTENSION", errorMessage: null, blocks: [] }, root);
  const first = await sync(root, store);
  const id = store.getDocument(txt)!.id;
  assert.equal(first.reasonsAttempted["unsupported-retry"], 1);
  assert.equal(first.reasonsAttempted["text-upgrade"], 0);
  assert.equal(first.parserCalls, 2);
  // 0.39.0 stores text in chunks; the payload↔block mapping no longer exists (SPEC §52.1).
  assert.equal(store.chunkStoreReady(), true);
  assert.equal(store.mappingIndexReady(), false);
  let parsed = 0;
  const second = await sync(root, store, { parse: async file => { parsed++; return (await import("../src/parser.js")).parseDocument(file); } });
  assert.equal(parsed, 0);
  assert.equal(second.parserCalls, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(second.reasonsCommitted.unchanged, 0);
  assert.equal(store.getDocument(txt)!.id, id);
  assert.equal(store.getDocument(txt)!.parse_version, 1);
}));

test("0.36 metadata-only files do not call the parser when only size changes", () => fixture(async (root, store) => {
  const bin = path.join(root, "畫面.mov");
  await writeFile(bin, "abcd");
  await sync(root, store);
  await writeFile(bin, "abcdef");
  let parsed = 0;
  const report = await sync(root, store, { parse: async file => { parsed++; return (await import("../src/parser.js")).parseDocument(file); } });
  assert.equal(parsed, 0);
  assert.equal(report.parserCalls, 0);
  assert.equal(report.reasonsAttempted["source-changed"], 1);
  assert.equal(store.getDocument(bin)?.size_bytes, 6);
}));

test("0.36 read-only legacy schema without parse_version stays readable", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m36-old-"));
  const database = path.join(temp, "index.db");
  const file = path.join(temp, "old.txt");
  try {
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
        extension TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
        indexed_at_ms INTEGER NOT NULL, status TEXT NOT NULL, error_code TEXT, error_message TEXT);
      INSERT INTO documents (path, filename, extension, size_bytes, modified_at_ms, indexed_at_ms, status)
      VALUES ('${file.replaceAll("'", "''")}', 'old.txt', '.txt', 1, 1, 1, 'indexed');`);
    db.close();
    const store = new IndexStore(database, { readOnly: true });
    assert.equal(store.getDocument(file)?.parse_version ?? null, null);
    assert.equal(store.textUpgradePending().byExtension.find(item => item.extension === ".txt")?.count, 1);
    const status = store.formatStatus();
    assert.equal(status.textUpgradePending, 1);
    assert.equal(status.mappingIndexReady, false);
    store.close();
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("0.36 profile is anonymous, refuses overwrite, and is excluded from the index", () => fixture(async (root, store, temp) => {
  await writeFile(path.join(root, "a.txt"), "profile-body-secret");
  const profile = path.join(root, "report.json");
  reserveNewProfile(profile);
  assert.throws(() => reserveNewProfile(profile), /覆寫/);
  const missingProfile = path.join(temp, "$env:USERPROFILE", "Desktop", "missing.json");
  assert.throws(() => reserveNewProfile(missingProfile), error => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /profile 輸出目錄不存在或無法存取/);
    assert.match(message, /ENOENT/);
    assert.match(message, /CMD：--profile "%USERPROFILE%\\Desktop\\lds-profile\.json"/);
    assert.match(message, /PowerShell：--profile "\$env:USERPROFILE\\Desktop\\lds-profile\.json"/);
    assert.match(message, /可能混用了 CMD 與 PowerShell/);
    return true;
  });
  if (process.getuid?.() !== 0) {
    const denied = path.join(temp, "denied");
    await mkdir(denied);
    await chmod(denied, 0);
    try {
      assert.throws(() => reserveNewProfile(path.join(denied, "report.json")), /EACCES|EPERM/);
    } finally {
      await chmod(denied, 0o700);
    }
  }
  const report = await sync(root, store, { excludePaths: [profile, `${profile}.tmp`] });
  assert.equal(store.getDocument(profile), undefined);
  const built = (await import("../src/profile.js")).buildIndexProfile({
    status: "complete", found: report.found, checked: report.checked, updated: report.updated,
    unchanged: report.unchanged, removed: report.removed, parserCalls: report.parserCalls,
    failedDocuments: report.failedDocuments, reasonsAttempted: report.reasonsAttempted,
    reasonsCommitted: report.reasonsCommitted, formats: report.formats, sourceBytes: report.sourceBytes,
    blocks: 1, payloads: 1, mappings: 1, phasesMs: report.phasesMs, reservoir: report.sample,
    peakRssBytes: report.peakRssBytes, slowest: report.slowest,
  });
  assertProfileIsAnonymous(built);
  assert.equal(JSON.stringify(built).includes("profile-body-secret"), false);
  assert.equal(JSON.stringify(built).includes(root), false);
  const cliProfile = path.join(temp, "out.json");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "data") };
  const rejectedData = path.join(temp, "not-started-data");
  const rejected = spawnSync(process.execPath, [cli, "index", root, "--profile", missingProfile], {
    encoding: "utf8",
    env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: rejectedData },
  });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /尚未開始寫入索引/);
  assert.equal(existsSync(path.join(rejectedData, "LocalDocSearch", "index.db")), false);
  const run = spawnSync(process.execPath, [cli, "index", root, "--profile", cliProfile], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const saved = JSON.parse(await readFile(cliProfile, "utf8")) as { status: string; productVersion: string };
  assert.equal(saved.status, "complete");
  assert.equal(saved.productVersion, productVersion);
  assert.equal(JSON.stringify(saved).includes(root), false);
  const again = spawnSync(process.execPath, [cli, "index", root, "--profile", cliProfile], { encoding: "utf8", env });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /覆寫/);
}));

test("0.36 CLI reuses one data directory and TUI quits without copying on /quit during confirm", () => fixture(async (root, store, temp) => {
  await writeFile(path.join(root, "共用.txt"), "同一個庫");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "shared") };
  const first = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /將建立新索引|既有索引/);
  assert.match(first.stdout, /索引位置：/);
  assert.match(first.stdout, /增量/);
  const second = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /既有索引/);
  assert.match(second.stdout, /未變更略過=1/);
  assert.match(second.stdout, /解析器呼叫 0 次/);
  const status = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /儲存格式升級/);
  assert.match(status.stdout, /文字解析升級待處理/);
  await sync(root, store);
  const answers = ["同一個庫", "/select 1", "/context", "/quit"];
  const output: string[] = [];
  const copied: string[] = [];
  const code = await runTui(store, {
    ansi: true, write: value => output.push(value), ask: async () => answers.shift() ?? null, stopReason: () => "eof",
    size: () => ({ columns: 100, rows: 32 }),
  }, 5, async value => { copied.push(value); });
  assert.equal(code, 0);
  assert.equal(copied.length, 0);
  assert.match(output.join("\n"), /seekah|Seekah/);
  const smallOut: string[] = [];
  assert.equal(await runTui(store, {
    ansi: false, write: value => smallOut.push(value), ask: async () => "/quit", size: () => ({ columns: 40, rows: 12 }),
  }), 0);
  assert.match(smallOut.join("\n"), /\/help/);
  const sigint = await runTui(store, {
    ansi: true, write() {}, ask: async () => null, stopReason: () => "sigint", size: () => ({ columns: 80, rows: 24 }),
  });
  assert.equal(sigint, 130);
}));

test("0.36 TUI key events navigate, select, preview, page and restore focus", () => fixture(async (root, store) => {
  await writeFile(path.join(root, "甲.txt"), "鍵盤導覽甲");
  await writeFile(path.join(root, "乙.txt"), "鍵盤導覽乙");
  await sync(root, store);
  const events: TuiEvent[] = [
    { type: "resize" },
    { type: "text", text: "鍵盤" },
    { type: "enter" },
    { type: "page-down" },
    { type: "page-up" },
    { type: "space" },
    { type: "enter" },
    { type: "escape" },
    { type: "tab" },
    { type: "tab" },
    { type: "tab" },
    { type: "text", text: "q" },
  ];
  const output: string[] = [];
  const code = await runTui(store, {
    ansi: false,
    write: value => output.push(value),
    ask: async () => null,
    nextEvent: async () => events.shift() ?? { type: "eof" },
    size: () => ({ columns: 100, rows: 24 }),
  }, 5);
  assert.equal(code, 0);
  const rendered = output.join("\n");
  assert.match(rendered, /›/);
  assert.match(rendered, /\[[ x]\]/);
  assert.match(rendered, /文件預覽/);
  assert.match(rendered, /已選文件/);
  assert.match(rendered, /已移至第 2 頁|已是最後一頁/);
}));

test("0.36.1 TUI reducer keeps cursor, selection focus and text input semantics separate", () => {
  const bounds = { resultCount: 3, selectedCount: 2, pageCount: 4, viewPageCount: 3, hasSession: true };
  let state = initialTuiState();
  state = reduceTuiState(state, { type: "text", text: "q" }, bounds);
  state = reduceTuiState(state, { type: "space" }, bounds);
  assert.equal(state.input, "q ");
  state = reduceTuiState(state, { type: "tab" }, bounds);
  assert.equal(state.focus, "results");
  state = reduceTuiState(state, { type: "down" }, bounds);
  assert.equal(state.cursor, 1);
  state = reduceTuiState(state, { type: "page-down" }, bounds);
  assert.equal(state.page, 2);
  state = reduceTuiState(state, { type: "tab" }, bounds);
  assert.equal(state.focus, "selected");
  state = reduceTuiState(state, { type: "down" }, bounds);
  assert.equal(state.selectedCursor, 1);
  state = reduceTuiState(state, { type: "shift-tab" }, bounds);
  assert.equal(state.focus, "results");
});

test("0.36.2 TUI workflow records only completed session actions, caps at 12, and does not persist", () => fixture(async (root, store) => {
  await writeFile(path.join(root, "workflow.txt"), "工作流測試");
  await sync(root, store);
  const answers = ["   ", "查詢一", "查詢二", "查詢三", "查詢四", "查詢五", "查詢六", "查詢七", "/quit"];
  const output: string[] = [];
  assert.equal(await runTui(store, {
    ansi: false,
    write: value => output.push(value),
    ask: async () => answers.shift() ?? null,
    size: () => ({ columns: 120, rows: 100 }),
  }), 0);
  assert.doesNotMatch(output[1]!, /◆ 搜尋/u);
  const finalScreen = output.at(-1)!;
  assert.doesNotMatch(finalScreen, /查詢一/u);
  assert.match(finalScreen, /查詢二/u);
  assert.match(finalScreen, /查詢七/u);
  assert.equal((finalScreen.match(/真實索引結果/gu) ?? []).length, 6);

  const restarted: string[] = [];
  assert.equal(await runTui(store, {
    ansi: false,
    write: value => restarted.push(value),
    ask: async () => "/quit",
    size: () => ({ columns: 120, rows: 40 }),
  }), 0);
  assert.doesNotMatch(restarted.join("\n"), /查詢七/u);
}));

test("0.36.2 TUI key decoder and Claude workflow layouts handle CJK, sanitization and terminal sizes", () => {
  assert.deepEqual(decodeTuiKey("\u001b[A"), { type: "up" });
  assert.deepEqual(decodeTuiKey("\u001b[6~"), { type: "page-down" });
  assert.deepEqual(decodeTuiKey("\u001b[Z"), { type: "shift-tab" });
  assert.deepEqual(decodeTuiKey("中文"), { type: "text", text: "中文" });
  const decoder = new TuiInputDecoder();
  assert.deepEqual(decoder.push("\u001b["), []);
  assert.deepEqual(decoder.push("A中文"), [{ type: "up" }, { type: "text", text: "中文" }]);
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.flush(), [{ type: "escape" }]);

  const common = {
    state: { ...initialTuiState(), view: "results" as const, focus: "results" as const },
    color: false,
    roots: ["D:\\工作資料"],
    documents: 12,
    conditions: ["複製回本機", "安裝"],
    mode: "all-terms" as const,
    selected: [{
      query: "複製回本機 安裝",
      reference: "1-aaaaaaaaaaaaaaaa",
      path: "D:\\工作資料\\安裝指引\\部署筆記.txt",
      mode: "all-terms" as const,
      snippet: "部署前複製回本機。",
      location: "第 2 行",
    }],
    viewLines: [],
    message: "↑↓ 移動、Space 選取、Enter 預覽。",
    confirming: false,
    workflow: [
      { kind: "prompt", text: "最舊提示\u001b[31m", detail: "全部關鍵字" },
      { kind: "search", text: "找到 2 份文件", detail: "全部關鍵字 · 真實索引結果" },
      { kind: "selection", text: "已選取 部署筆記.txt", detail: "目前已選 1 份" },
      { kind: "context", text: "已準備 1 份文件", detail: "2 個 passages · 846 bytes" },
    ] as const,
    page: {
      page: 1, pageSize: 2, total: 2, pageCount: 1, start: 1, end: 2,
      results: [
        {
          reference: "1-aaaaaaaaaaaaaaaa",
          path: "D:\\工作資料\\安裝指引\\部署筆記.txt",
          extension: ".txt",
          modifiedAtMs: 0,
          heading: null,
          location: "第 2 行",
          snippet: "部署前複製回本機，核對版本後再安裝。",
          rank: 1,
          reason: "內容",
          filenameOnly: false,
          status: "indexed" as const,
          snippetTruncated: false,
        },
        {
          reference: "2-bbbbbbbbbbbbbbbb",
          path: "D:\\工作資料\\超長中文資料夾\\第二層目錄\\第三層目錄\\惡意\u0007檔名\u202e.md",
          extension: ".md",
          modifiedAtMs: 0,
          heading: null,
          location: "第 18 行",
          snippet: "這是很長的中文片段，用來驗證終端 cell width 與控制字元\u009b不會穿透。",
          rank: 2,
          reason: "內容",
          filenameOnly: false,
          status: "indexed" as const,
          snippetTruncated: false,
        },
      ],
    },
  };

  const screen80 = renderTuiScreen({ ...common, columns: 80, rows: 24 });
  assert.equal(screen80.split("\n").length, 24);
  assert.match(screen80, new RegExp(`seekah ${productVersion.replaceAll(".", "\\.")}`));
  assert.match(screen80, /找到 2 份文件/u);
  assert.match(screen80, /已準備 1 份文件/u);
  assert.match(screen80, /› 部署筆記\.txt/u);
  assert.match(screen80, /\[x\]/u);
  assert.match(screen80, /› 搜尋 ›/u);
  assert.doesNotMatch(screen80, /最舊提示/u);
  assert.doesNotMatch(screen80, /\u001b/u);
  assert.doesNotMatch(screen80, /\u202e/u);
  for (const line of screen80.split("\n")) assert.ok(displayWidth(line) <= 80, line);

  const screen120 = renderTuiScreen({ ...common, columns: 120, rows: 40 });
  assert.equal(screen120.split("\n").length, 40);
  const promptAt = screen120.indexOf("最舊提示");
  const searchAt = screen120.indexOf("找到 2 份文件");
  const selectionAt = screen120.indexOf("已選取 部署筆記.txt");
  const contextAt = screen120.indexOf("已準備 1 份文件");
  assert.ok(promptAt >= 0 && promptAt < searchAt && searchAt < selectionAt && selectionAt < contextAt);
  for (const line of screen120.split("\n")) assert.ok(displayWidth(line) <= 120, line);

  const color24 = renderTuiScreen({ ...common, columns: 120, rows: 40, color: true, colorDepth: 24 });
  assert.match(color24, /\u001b\[1;38;2;138;180;248;/u);
  for (const line of color24.split("\n")) assert.ok(displayWidth(line) <= 120, line);
  const color16 = renderTuiScreen({ ...common, columns: 80, rows: 24, color: true, colorDepth: 8 });
  assert.match(color16, /\u001b\[(?:1;)?94;/u);
  for (const line of color16.split("\n")) assert.ok(displayWidth(line) <= 80, line);

  const contextScreen = renderTuiScreen({
    ...common,
    columns: 80,
    rows: 24,
    confirming: true,
    message: "完整預覽：1 份，846 bytes；輸入完整 yes 才複製。",
    viewLines: ["# 已選文件上下文", "", "部署前複製回本機。"],
    state: {
      ...common.state,
      view: "context",
      focus: "input",
      input: "",
      previousView: "results",
      previousFocus: "results",
    },
  });
  assert.match(contextScreen, /選取內容預覽/u);
  assert.match(contextScreen, /完整預覽：1 份，846 bytes/u);
  assert.match(contextScreen, /只有輸入完整 yes 才會複製/u);
  assert.match(contextScreen, /› 確認 ›/u);
  for (const line of contextScreen.split("\n")) assert.ok(displayWidth(line) <= 80, line);

  const narrow = renderTuiScreen({ ...common, columns: 70, rows: 24 });
  assert.match(narrow.split("\n")[0]!, /12 份文件/u);
  assert.doesNotMatch(narrow.split("\n")[0]!, /D:\\工作資料/u);
  const minimum = renderTuiScreen({ ...common, columns: 60, rows: 24 });
  assert.doesNotMatch(minimum.split("\n")[0]!, /12 份文件|D:\\工作資料/u);
  assert.match(minimum.split("\n")[0]!, /已選 1/u);

  const tiny = renderTuiScreen({ ...common, columns: 40, rows: 12 });
  assert.match(tiny, /請放大至至少 60×16/u);
  assert.match(tiny, /\/quit 離開/u);
  for (const line of tiny.split("\n")) assert.ok(displayWidth(line) <= 40, line);
});

test("0.36.1 real PTY handles navigation, Ctrl+C, EOF and SIGTERM with terminal cleanup", { skip: process.platform === "win32" ? "Windows PTY harness 需在本機手動複驗" : false }, async () => {
  const python = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" });
  if (python.status !== 0) return;
  const harness = path.resolve("scripts/pty-tui-check.py");
  const envDir = path.join(os.tmpdir(), `lds-pty-${Date.now()}`);
  const docs = path.join(envDir, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "a.txt"), "pty");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(envDir, "data") };
  const indexed = spawnSync(process.execPath, [cli, "index", docs], { encoding: "utf8", env });
  assert.equal(indexed.status, 0, indexed.stderr);
  const interrupt = spawnSync("python3", [harness, process.execPath, cli, "int"], { encoding: "utf8", env, timeout: 8000 });
  assert.equal(interrupt.status, 0, `${interrupt.stderr}\n${interrupt.stdout}`);
  assert.match(interrupt.stderr, /EXIT:130/);
  assert.match(interrupt.stdout, /說明|\/help/);
  assert.match(interrupt.stdout, /\u001b\[\?1049l/);
  const eof = spawnSync("python3", [harness, process.execPath, cli, "eof"], { encoding: "utf8", env, timeout: 8000 });
  assert.equal(eof.status, 0, `${eof.stderr}\n${eof.stdout}`);
  assert.match(eof.stderr, /EXIT:0/);
  assert.match(eof.stdout, /\u001b\[\?1049l/);
  const navigation = spawnSync("python3", [harness, process.execPath, cli, "nav"], { encoding: "utf8", env, timeout: 8000 });
  assert.equal(navigation.status, 0, `${navigation.stderr}\n${navigation.stdout}`);
  assert.match(navigation.stderr, /EXIT:0/);
  assert.match(navigation.stdout, /搜尋結果/);
  assert.match(navigation.stdout, /文件預覽/);
  assert.match(navigation.stdout, /\[x\]/);
  assert.match(navigation.stdout, /\u001b\[\?1049l/);
  const terminated = spawnSync("python3", [harness, process.execPath, cli, "term"], { encoding: "utf8", env, timeout: 8000 });
  assert.equal(terminated.status, 0, `${terminated.stderr}\n${terminated.stdout}`);
  assert.match(terminated.stderr, /EXIT:143/);
  assert.match(terminated.stdout, /\u001b\[\?1049l/);
});
