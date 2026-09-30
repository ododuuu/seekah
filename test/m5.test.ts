import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { documentStatuses, type DocumentRecord } from "../src/model.js";
import { parseDocument } from "../src/parser.js";
import { scan } from "../src/scanner.js";
import { makeSnippet, normalize, parseTypes, search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/src/cli.js");
function record(root: string, filename: string, content = "共通內容", heading: string | null = null): DocumentRecord {
  return { path: path.join(root, filename), filename, extension: path.extname(filename), sizeBytes: 10,
    modifiedAtMs: 1000, status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading, content, locationKind: "line", locationValue: "第 1 行" }] };
}

test("M5 filters before limit, deduplicates documents and preserves all filename-only statuses", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-search-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    store.upsert(record(temp, "共通內容.txt"));
    store.upsert(record(temp, "report.pdf"));
    store.upsert(record(temp, "other.docx"));
    assert.deepEqual(search(store, "共通內容", 1, parseTypes(".PDF,pdf")).map(r => r.extension), [".pdf"]);
    assert.equal(search(store, "共通內容", 20, parseTypes("pdf,docx")).length, 2);
    for (const status of documentStatuses) store.upsert({ ...record(temp, `${status}.xlsx`, "無關的段落"), status });
    for (const status of documentStatuses) {
      const hit = search(store, `${status}.xlsx`)[0]!;
      assert.equal(hit.status, status);
      assert.equal(hit.filenameOnly, true);
      assert.equal(hit.location, null);
      assert.equal(hit.snippet, `${status}.xlsx`);
    }
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("M5 ranking uses match class, time, fixed path order and earliest matching block", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-rank-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    store.upsert(record(temp, "needle.txt", "unrelated"));
    store.upsert(record(temp, "prefix-needle.txt", "unrelated"));
    const title = record(temp, "title.md", "不相關內容", "needle.txt 标題");
    store.upsert({ ...title, blocks: [
      { ...title.blocks[0]!, ordinal: 9, heading: "needle.txt 後段", locationValue: "第 9 行" },
      title.blocks[0]!,
    ] });
    for (const name of ["ä.txt", "Z.txt", "A.txt"]) store.upsert(record(temp, name, "needle.txt"));
    store.upsert({ ...record(temp, "new.txt", "needle.txt"), modifiedAtMs: 2000 });
    const hits = search(store, "needle.txt");
    assert.deepEqual(hits.map(r => path.basename(r.path)), ["needle.txt", "prefix-needle.txt", "title.md", "new.txt", "A.txt", "Z.txt", "ä.txt"]);
    assert.deepEqual(hits.map(r => r.rank), [4, 3, 2, 1, 1, 1, 1]);
    assert.equal(hits[2]!.snippet, "needle.txt 标題");
    assert.equal(hits[2]!.location, "第 1 行");
    assert.equal(search(store, "needle.txt", 2).length, 2);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("M5 snippets map Unicode normalization back to original and cap long matches", () => {
  for (const [source, query, expected] of [
    ["㍿".repeat(80) + "目標🧪文字" + "後".repeat(80), "目標🧪文字", "目標🧪文字"],
    ["前".repeat(80) + "e\u0301" + "後".repeat(80), "é", "e\u0301"],
    ["前".repeat(80) + "ＡＢＣ" + "後".repeat(80), "abc", "ＡＢＣ"],
    ["前".repeat(80) + "İstanbul" + "後".repeat(80), "i\u0307stanbul", "İstanbul"],
    ["前".repeat(80) + "ΟΣ" + "後".repeat(80), "ος", "ΟΣ"],
    ["前".repeat(80) + "ｶﾞ" + "後".repeat(80), "ガ", "ｶﾞ"],
    ["前".repeat(80) + "\u1100\u1161" + "後".repeat(80), "가", "\u1100\u1161"],
  ]) {
    const snippet = makeSnippet(source!, normalize(query!));
    assert.ok(snippet.text.includes(expected!), `${query}: ${snippet.text}`);
    assert.ok(Array.from(snippet.text).length <= 160);
    assert.equal(/[\uD800-\uDFFF]/u.test(snippet.text), false);
    assert.equal(snippet.truncated, false);
  }
  const long = makeSnippet("前" + "🧪".repeat(200) + "後", "🧪".repeat(200));
  assert.ok(Array.from(long.text).length <= 160);
  assert.equal(long.truncated, true);
  assert.equal(/[\uD800-\uDFFF]/u.test(long.text), false);
  for (const length of [159, 160]) {
    const exact = makeSnippet("前" + "字".repeat(length) + "後", "字".repeat(length));
    assert.ok(exact.text.includes("字".repeat(length)));
    assert.equal(exact.truncated, false);
    assert.ok(Array.from(exact.text).length <= 160);
  }
});

test("M5 query semantics do not turn whitespace or punctuation into operators", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-query-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    store.upsert(record(temp, "literal.txt", "a\nb * AND ?"));
    assert.equal(search(store, "a b").length, 0);
    assert.equal(search(store, "a\nb").length, 1);
    assert.equal(search(store, "* AND ?").length, 1);
    assert.equal(search(store, "a AND b").length, 0);
    assert.deepEqual(parseTypes(" .PDF , DocX,pdf "), [".pdf", ".docx"]);
    assert.deepEqual(parseTypes("JPG,.zip,jpg"), [".jpg", ".zip"]);
    for (const value of ["", "pdf,", ",pdf", "pdf,,txt", "..pdf", "bad/path", "bad\\path"]) assert.throws(() => parseTypes(value));
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("M5 skip counts exclude subtrees once and keep hidden files despite gitignore", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-scan-"));
  try {
    await mkdir(path.join(temp, "node_modules"));
    await mkdir(path.join(temp, "archive"));
    await writeFile(path.join(temp, "node_modules", "hidden.txt"), "skip");
    await writeFile(path.join(temp, "archive", "nested.txt"), "skip");
    await writeFile(path.join(temp, ".localdocsearchignore"), "archive/\nnode_modules/\n*.skip.txt\n");
    await writeFile(path.join(temp, ".gitignore"), ".hidden.txt\n");
    await writeFile(path.join(temp, ".hidden.txt"), "keep");
    await writeFile(path.join(temp, "bad.skip.txt"), "skip");
    await writeFile(path.join(temp, "~$temp.txt"), "skip");
    await writeFile(path.join(temp, "image.png"), "unsupported");
    await symlink(temp, path.join(temp, "cycle"), process.platform === "win32" ? "junction" : "dir");
    const result = await scan(temp);
    assert.deepEqual(result.paths.map(p => path.basename(p)), [".gitignore", ".hidden.txt", ".localdocsearchignore", "image.png"]);
    assert.deepEqual(result.skipped, {
      builtin: 2,
      user: 2,
      unsupported: 0,
      link: 1,
      byRule: {
        [`user-rule:${temp}:archive/`]: 1,
        [`user-rule:${temp}:*.skip.txt`]: 1,
        link: 1,
        "builtin:node-modules": 1,
        "builtin:office-temp": 1,
      },
    });
    assert.equal(result.ignoreFile, path.join(temp, ".localdocsearchignore"));
    assert.equal(result.errors.length, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("M5 sync proves zero parsing, retries errors and persists summary across reopen", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-summary-"));
  const root = path.join(temp, "文件");
  const db = path.join(temp, "index.db");
  let store = new IndexStore(db);
  try {
    await mkdir(root);
    await writeFile(path.join(root, "ok.txt"), "正文不應出現在診斷");
    const first = await sync(root, store);
    assert.equal(first.added, 1);
    let calls = 0;
    const parser: typeof parseDocument = async file => { calls++; return parseDocument(file); };
    const again = await sync(root, store, { parse: parser });
    assert.equal(calls, 0);
    assert.equal(again.parserCalls, 0);
    assert.equal(again.unchanged, 1);
    await writeFile(path.join(root, "broken.pdf"), "secret-document-body");
    const failed = await sync(root, store);
    assert.equal(failed.statuses.error, 1);
    assert.equal(failed.complete, true);
    assert.equal(failed.diagnostics[0]?.stage, "parse");
    assert.ok(!JSON.stringify(failed).includes("secret-document-body"));
    const retried = await sync(root, store, { parse: parser });
    assert.equal(calls, 1);
    assert.equal(retried.reprocessed, 1);
    assert.equal(retried.unchanged, 1);
    store.close();
    store = new IndexStore(db);
    assert.equal(store.getLastSyncReport().summary?.parserCalls, 1);
    assert.equal(store.getLastSyncReport().diagnostics[0]?.code, "PDF_CORRUPT");
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("M5 incomplete scan retains documents; M8 preserves independent root freshness", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-incomplete-"));
  const root = path.join(temp, "a");
  const nextRoot = path.join(temp, "b");
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    await mkdir(root); await mkdir(nextRoot);
    await writeFile(path.join(root, "old.txt"), "existing");
    await sync(root, store);
    const successful = store.getLastSyncReport().successfulAt;
    const incomplete: typeof scan = async input => ({ ...await scan(input), paths: [], errors: ["無法讀取目錄"],
      protectedScopes: [input],
      diagnostics: [{ stage: "scan", path: input, code: "SCAN_READ_FAILED", message: "無法讀取目錄" }] });
    const report = await sync(root, store, { scan: incomplete });
    assert.equal(report.complete, false);
    assert.equal(report.readErrors, 1);
    assert.equal(search(store, "existing").length, 1);
    assert.equal(store.getLastSyncReport().successfulAt, successful);
    await sync(nextRoot, store, { scan: incomplete });
    assert.equal(store.getLastSyncReport().successfulAt, null);
    assert.equal(search(store, "existing").length, 1);
    assert.equal(store.getLastSyncReport(root).successfulAt, successful);
    assert.equal(store.getLastSyncReport(nextRoot).successfulAt, null);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("0.36.1 removes deleted sibling files while retaining a failed subtree", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-scope-delete-"));
  const root = path.join(temp, "root");
  const failed = path.join(root, "failed");
  const healthy = path.join(root, "healthy");
  const retained = path.join(failed, "retained.txt");
  const deleted = path.join(healthy, "deleted.txt");
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    await mkdir(failed, { recursive: true });
    await mkdir(healthy, { recursive: true });
    await writeFile(retained, "保留內容");
    await writeFile(deleted, "刪除內容");
    await sync(root, store);
    await rm(deleted);
    const partial: typeof scan = async input => {
      const result = await scan(input);
      return {
        ...result,
        paths: result.paths.filter(filePath => !filePath.startsWith(`${failed}${path.sep}`)),
        errors: [`${failed}: 無法讀取目錄`],
        protectedScopes: [failed],
        diagnostics: [{ stage: "scan", path: failed, code: "SCAN_READ_FAILED", message: "無法讀取目錄" }],
      };
    };
    const report = await sync(root, store, { scan: partial });
    assert.equal(report.complete, false);
    assert.equal(report.removed, 1);
    assert.equal(report.protectedByScanFailure, 1);
    assert.deepEqual(report.protectedScopes, [failed]);
    assert.equal(search(store, "保留內容").length, 1);
    assert.equal(search(store, "刪除內容").length, 0);
    assert.equal(store.getLastSyncReport(root).summary?.protectedByScanFailure, 1);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("M5 scanner reports an unreadable directory without aborting siblings", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-permission-"));
  const denied = path.join(temp, "denied");
  try {
    await mkdir(denied);
    await writeFile(path.join(temp, "ok.txt"), "keep");
    await chmod(denied, 0);
    const result = await scan(temp);
    assert.equal(result.paths.length, 1);
    assert.equal(result.diagnostics[0]?.code, "SCAN_READ_FAILED");
  } finally { await chmod(denied, 0o700); await rm(temp, { recursive: true, force: true }); }
});

test("M5 CLI searches a moved-away source, validates types and prints persisted diagnostics", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-cli-"));
  const root = path.join(temp, "中文 文件");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "data") };
  try {
    await mkdir(root);
    await writeFile(path.join(root, "needle.txt"), "unrelated body");
    await writeFile(path.join(root, "report.md"), "# needle title\n內容");
    await writeFile(path.join(root, ".localdocsearchignore"), "archive/\n");
    const index = await exec(process.execPath, [cli, "index", root, "--verbose"], { env });
    assert.match(index.stdout, /規則：archive\//);
    await rename(root, root + " moved");
    const result = await exec(process.execPath, [cli, "search", "needle", "--type", ".MD", "--limit", "1", "--verbose"], { env });
    assert.match(result.stdout, /report.md/);
    assert.doesNotMatch(result.stdout, /needle.txt/);
    assert.match(result.stdout, /命中：標題/);
    assert.match(result.stdout, /片段：needle title/);
    assert.match(result.stdout, /等級 2/);
    const filename = await exec(process.execPath, [cli, "search", "needle.txt"], { env });
    assert.match(filename.stdout, /僅檔名命中/);
    assert.doesNotMatch(filename.stdout, /unrelated body|位置：/);
    const status = await exec(process.execPath, [cli, "status"], { env });
    assert.match(status.stdout, /歷史紀錄/);
    assert.match(status.stdout, /解析器呼叫 2/);
    for (const options of [["--type"], ["--type", "pdf,"], ["--type", "bad/path"], ["--type", "pdf", "--type", "txt"], ["--limit", "9007199254740992"]]) {
      await assert.rejects(exec(process.execPath, [cli, "search", "needle", ...options], { env }), error => (error as { code: number }).code === 2);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("0.36.1 file read failures preserve that file without blocking sibling deletion", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-read-"));
  const root = path.join(temp, "docs");
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    await mkdir(root);
    await writeFile(path.join(root, "gone.txt"), "retain-until-confirmed");
    await sync(root, store);
    await rm(path.join(root, "gone.txt"));
    await writeFile(path.join(root, "bad.txt"), "body");
    await writeFile(path.join(root, "good.txt"), "readable");
    const report = await sync(root, store, { parse: async file => {
      if (file.endsWith("bad.txt")) return { ...await parseDocument(file), status: "error", blocks: [], errorCode: "EACCES", errorMessage: "sensitive-parser-error" };
      return parseDocument(file);
    } });
    assert.equal(report.complete, false);
    assert.equal(report.readErrors, 1);
    assert.equal(report.diagnostics[0]?.stage, "read");
    assert.equal(report.removed, 1);
    assert.equal(search(store, "retain-until-confirmed").length, 0);
    assert.equal(search(store, "readable").length, 1);
    assert.ok(!JSON.stringify(report).includes("sensitive-parser-error"));
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("M5 CLI distinguishes missing index, empty index, no matches and incomplete history", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m5-empty-"));
  const root = path.join(temp, "docs");
  const data = path.join(temp, "data");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: data };
  try {
    await mkdir(root);
    await assert.rejects(exec(process.execPath, [cli, "search", "x"], { env }), error => {
      assert.match((error as { stderr: string }).stderr, /索引尚未建立/);
      return (error as { code: number }).code === 3;
    });
    await exec(process.execPath, [cli, "index", root], { env });
    const empty = await exec(process.execPath, [cli, "search", "x"], { env });
    assert.match(empty.stdout, /索引內沒有支援的文件/);
    await writeFile(path.join(root, "a.txt"), "needle");
    await exec(process.execPath, [cli, "index", root], { env });
    const missing = await exec(process.execPath, [cli, "search", "absent"], { env });
    assert.match(missing.stdout, /沒有符合的結果/);
    assert.match(missing.stdout, /可執行 seekah explain <路徑> 檢查為何搜不到/u);
    assert.match(missing.stdout, /相容別名：docsearch explain <路徑>/u);
    assert.doesNotMatch(missing.stdout, /\/explain/u);
    const store = new IndexStore(path.join(data, "LocalDocSearch/index.db"));
    try { store.recordSync(root, false, ["failure"], []); } finally { store.close(); }
    const partial = await exec(process.execPath, [cli, "search", "needle"], { env });
    assert.match(partial.stdout, /最近同步不完整/);
    assert.match(partial.stdout, /a.txt/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
