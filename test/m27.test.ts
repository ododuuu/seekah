import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseDocument, MAX_FILE_BYTES } from "../src/parser.js";
import { decodeSharedText, TextDecodeError } from "../src/parsers/text-decode.js";
import { createProgressReporter, formatPercent, OperationCancelledError, throwIfAborted } from "../src/progress.js";
import { search } from "../src/search.js";
import { collectIndexStorage, formatMib, IndexStore } from "../src/store.js";
import { TEXT_PARSE_VERSION } from "../src/model.js";
import { scan } from "../src/scanner.js";
import { isWindowsVolumeSystemPath, isWindowsVolumeSystemRoot } from "../src/builtin-paths.js";
import { sync } from "../src/sync.js";

async function fixture(run: (root: string, store: IndexStore, temp: string) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m27-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  const store = new IndexStore(path.join(temp, "index.db"));
  try { await run(root, store, temp); }
  finally { store.close(); await rm(temp, { recursive: true, force: true }); }
}

const cli = path.resolve("dist/src/cli.js");
const big5Chinese = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]); // 中文
const cp950Euro = Buffer.from([0xa3, 0xe1]); // €
const cp950Go = Buffer.from([0xf9, 0xd6]); // 碁

test("M27 shared decode prefers BOM and UTF-8, then Big5, without rereading bytes", () => {
  const utf8Tried: string[] = [];
  assert.equal(decodeSharedText(Buffer.from("hello 中文"), "text", { onAttempt: enc => utf8Tried.push(enc) }).encoding, "utf-8");
  assert.deepEqual(utf8Tried, ["utf-8"]);

  const big5Tried: string[] = [];
  const big5 = decodeSharedText(big5Chinese, "text", { onAttempt: enc => big5Tried.push(enc) });
  assert.equal(big5.text, "中文");
  assert.equal(big5.encoding, "big5");
  assert.deepEqual(big5Tried, ["utf-8", "big5"]);

  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("寬字元", "utf16le")]);
  assert.equal(decodeSharedText(bom, "text").text.replace(/^\uFEFF/, ""), "寬字元");

  const invalid: string[] = [];
  assert.throws(() => decodeSharedText(Buffer.from([0x80, 0x81, 0xff]), "text", { onAttempt: enc => invalid.push(enc) }), error => {
    assert.ok(error instanceof TextDecodeError);
    assert.equal(error.code, "TEXT_DECODE_ERROR");
    return true;
  });
  assert.deepEqual(invalid, ["utf-8", "big5"]);
});

test("M27 XML explicit encoding failure does not fall back to Big5", () => {
  const tried: string[] = [];
  const xml = Buffer.concat([
    Buffer.from("<?xml version=\"1.0\" encoding=\"utf-8\"?><root>"),
    big5Chinese,
    Buffer.from("</root>"),
  ]);
  assert.throws(() => decodeSharedText(xml, "xml", { onAttempt: enc => tried.push(enc) }), error => {
    assert.ok(error instanceof TextDecodeError);
    assert.equal(error.code, "XML_DECODE_ERROR");
    return true;
  });
  assert.equal(tried.includes("big5"), false);

  const declaredBig5 = Buffer.concat([
    Buffer.from("<?xml version=\"1.0\" encoding=\"windows-950\"?><root>"),
    big5Chinese,
    Buffer.from("</root>"),
  ]);
  const decoded = decodeSharedText(declaredBig5, "xml");
  assert.equal(decoded.encoding, "big5");
  assert.match(decoded.text, /中文/);

  const unknown = Buffer.from("<?xml version=\"1.0\" encoding=\"x-localdocsearch-nope\"?><root>x</root>");
  assert.throws(() => decodeSharedText(unknown, "xml"), error => error instanceof TextDecodeError && error.code === "XML_ENCODING_UNSUPPORTED");
});

test("M27 CP950 common extensions decode via Big5", () => {
  assert.equal(decodeSharedText(cp950Euro, "text").text, "€");
  assert.equal(decodeSharedText(cp950Go, "text").text, "碁");
});

test("M27 source formats keep comments strings syntax and line endings", () => fixture(async (root, store) => {
  await writeFile(path.join(root, "App.JAVA"), "class App {\r\n  // 註解 needle\r\n\rString a = \"字串\";\n  int x = 1;\r}");
  await writeFile(path.join(root, "query.SQL"), "SELECT 1; -- 註解\n\nSELECT '字串';");
  await writeFile(path.join(root, "lib.JS"), "function f() {\n  const a = \"字串\"; // needle\n}");
  await writeFile(path.join(root, "empty.txt"), "");
  await writeFile(path.join(root, "long.java"), `${"a".repeat(20_000)}needle`);
  await writeFile(path.join(root, "Skip.CLASS"), "this-should-not-be-indexed-body");
  const report = await sync(root, store);
  assert.equal(report.parserCalls, 5);
  assert.equal(store.getDocument(path.join(root, "Skip.CLASS"))?.status, "unsupported");
  assert.equal(search(store, "this-should-not-be-indexed-body").length, 0);
  assert.equal(search(store, "Skip.CLASS")[0]?.filenameOnly, true);
  assert.equal(search(store, "註解 needle")[0]?.location, "第 2 行");
  assert.ok(search(store, "字串").some(item => item.path.endsWith("App.JAVA")));
  assert.equal(search(store, "SELECT '字串'")[0]?.location, "第 3 行");
  assert.match(search(store, "needle")[0]!.snippet, /needle/);
  const empty = await parseDocument(path.join(root, "empty.txt"));
  assert.equal(empty.status, "no_text");
  const long = search(store, "needle").find(item => item.path.endsWith("long.java"));
  assert.ok(long);
  assert.equal(store.getDocument(path.join(root, "App.JAVA"))?.parse_version, TEXT_PARSE_VERSION);
}));

test("M27 100 MiB boundary and Big5 java search", () => fixture(async (root, store) => {
  const tooLarge = path.join(root, "huge.java");
  const handle = await open(tooLarge, "w");
  await handle.truncate(MAX_FILE_BYTES + 1);
  await handle.close();
  await writeFile(path.join(root, "big5.java"), Buffer.concat([Buffer.from("class C { // "), big5Chinese, Buffer.from(" }")]));
  const huge = await parseDocument(tooLarge);
  assert.equal(huge.status, "too_large");
  const report = await sync(root, store);
  assert.equal(report.statuses.too_large, 1);
  assert.equal(search(store, "中文")[0]?.path, path.join(root, "big5.java"));
  const again = await sync(root, store);
  assert.equal(again.parserCalls, 0);
  assert.equal(again.unchanged, 2);
}));

test("M27 old unsupported source and indexed text upgrade in the same document transaction", () => fixture(async (root, store) => {
  const java = path.join(root, "Legacy.java");
  const txt = path.join(root, "old.txt");
  const png = path.join(root, "pic.png");
  await writeFile(java, "class Legacy { String x = \"upgrade-java\"; }");
  await writeFile(txt, "舊正文 upgrade-txt");
  await writeFile(png, "binary");
  const javaInfo = await stat(java);
  const txtInfo = await stat(txt);
  const pngInfo = await stat(png);
  store.registerRoot(root);
  store.upsert({ path: java, filename: "Legacy.java", extension: ".java", sizeBytes: javaInfo.size,
    modifiedAtMs: javaInfo.mtimeMs, status: "unsupported", errorCode: null, errorMessage: null, blocks: [] }, root);
  store.upsert({ path: txt, filename: "old.txt", extension: ".txt", sizeBytes: txtInfo.size,
    modifiedAtMs: txtInfo.mtimeMs, status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: null, content: "亂碼", locationKind: "line", locationValue: "第 1 行" }] }, root);
  store.upsert({ path: png, filename: "pic.png", extension: ".png", sizeBytes: pngInfo.size,
    modifiedAtMs: pngInfo.mtimeMs, status: "unsupported", errorCode: null, errorMessage: null, blocks: [] }, root);
  const db = new DatabaseSync(store.databasePath);
  db.prepare("UPDATE documents SET parse_version = NULL WHERE path = ?").run(txt);
  db.close();
  const txtId = store.getDocument(txt)!.id;
  const report = await sync(root, store);
  assert.equal(report.parserCalls, 2);
  assert.equal(report.unchanged, 1);
  assert.equal(search(store, "upgrade-java").length, 1);
  assert.equal(search(store, "upgrade-txt").length, 1);
  assert.equal(search(store, "亂碼").length, 0);
  assert.equal(store.getDocument(txt)?.id, txtId);
  assert.equal(store.getDocument(txt)?.parse_version, TEXT_PARSE_VERSION);
  assert.equal(store.getDocument(java)?.parse_version, TEXT_PARSE_VERSION);
  const again = await sync(root, store);
  assert.equal(again.parserCalls, 0);
}));

test("M27 interrupted text upgrade resumes remaining files only", () => fixture(async (root, store) => {
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(path.join(root, name), `${name} body`);
  await sync(root, store);
  const db = new DatabaseSync(store.databasePath);
  db.exec("UPDATE documents SET parse_version = NULL");
  db.close();
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(sync(root, store, {
    signal: ac.signal,
    parse: async file => {
      calls++;
      if (calls === 2) { ac.abort(); throwIfAborted(ac.signal); }
      return parseDocument(file);
    },
  }), OperationCancelledError);
  const versions = ["a.txt", "b.txt", "c.txt"].map(name => store.getDocument(path.join(root, name))?.parse_version ?? 0);
  assert.equal(versions.filter(version => version === TEXT_PARSE_VERSION).length, 1);
  assert.equal(versions.filter(version => version < TEXT_PARSE_VERSION).length, 2);
  const resumed = await sync(root, store);
  assert.equal(resumed.parserCalls, 2);
  assert.ok(["a.txt", "b.txt", "c.txt"].every(name => store.getDocument(path.join(root, name))?.parse_version === TEXT_PARSE_VERSION));
}));

test("M27 error retries, too_large stays skipped, subtree isolation holds", () => fixture(async (root, store) => {
  const parent = root;
  const child = path.join(parent, "sub");
  await mkdir(child);
  await writeFile(path.join(parent, "outer.txt"), "outer-body");
  await writeFile(path.join(child, "inner.txt"), "inner-body");
  const huge = path.join(parent, "huge.txt");
  const handle = await open(huge, "w");
  await handle.truncate(MAX_FILE_BYTES + 1);
  await handle.close();
  await writeFile(path.join(parent, "broken.pdf"), "not-a-pdf");
  await sync(parent, store);
  const db = new DatabaseSync(store.databasePath);
  db.prepare("UPDATE documents SET parse_version = NULL WHERE path LIKE ?").run(`%${path.sep}outer.txt`);
  db.close();
  let parsed: string[] = [];
  const subtree = await sync(child, store, { parse: async file => { parsed.push(file); return parseDocument(file); } });
  assert.equal(subtree.parserCalls, 0);
  assert.equal(parsed.length, 0);
  parsed = [];
  const full = await sync(parent, store, { parse: async file => { parsed.push(path.basename(file)); return parseDocument(file); } });
  assert.ok(parsed.includes("outer.txt"));
  assert.ok(parsed.includes("broken.pdf"));
  assert.equal(parsed.includes("huge.txt"), false);
  assert.equal(parsed.includes("inner.txt"), false);
  assert.ok(full.parserCalls >= 2);
}));

test("M27 progress throttles stage switches, caps 99.99%, counts unchanged and cancel", () => {
  assert.equal(formatPercent(0, 0, false), "無文件");
  assert.equal(formatPercent(10000, 10000, false), "99.99%");
  assert.equal(formatPercent(9999, 10000, false), "99.99%");
  assert.equal(formatPercent(10000, 10000, true), "100.00%");
  let t = 0;
  const lines: { text: string; inPlace: boolean }[] = [];
  const reporter = createProgressReporter({
    isTTY: true, verbose: false, now: () => t, ttyIntervalMs: 1000,
    write: (text, inPlace) => lines.push({ text, inPlace }),
  });
  reporter.update({ stage: "recover", message: "開啟並檢查本機索引" });
  t = 10;
  reporter.update({ stage: "parse", message: "解析文件內容", current: 1, total: 10, path: "/secret/path.txt" });
  t = 20;
  reporter.update({ stage: "write", message: "寫入文件索引", current: 1, total: 10, path: "/secret/path.txt" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.inPlace, true);
  assert.doesNotMatch(lines[0]!.text, /secret/);
  t = 2000;
  reporter.update({ stage: "read", message: "處理索引文件", current: 10, total: 10 });
  assert.match(lines.at(-1)!.text, /99\.99%/);
  reporter.update({ stage: "complete", message: "索引同步完成", current: 10, total: 10 });
  assert.match(lines.at(-1)!.text, /100\.00%/);
  assert.equal(lines.at(-1)?.inPlace, false);
  reporter.update({ stage: "cancelled", message: "操作已取消" });
  assert.match(lines.at(-1)!.text, /操作已取消/);
  reporter.close();
});

test("M27 unchanged files increment progress and yield", () => fixture(async (root, store) => {
  for (let index = 0; index < 3; index++) await writeFile(path.join(root, `${index}.txt`), "same");
  await sync(root, store);
  const updates: number[] = [];
  const report = await sync(root, store, {
    onProgress: update => { if (update.current !== undefined && update.total !== undefined) updates.push(update.current); },
  });
  assert.equal(report.unchanged, 3);
  assert.equal(report.parserCalls, 0);
  assert.equal(Math.max(0, ...updates), 3);
}));

test("M27 status is read-only and reports capacity, types and two issue groups", () => fixture(async (root, store, temp) => {
  await writeFile(path.join(root, "ok.txt"), "正文");
  await writeFile(path.join(root, "broken.pdf"), "x");
  await writeFile(path.join(root, "notes.java"), "class N {}");
  await writeFile(path.join(root, "none"), "noext");
  await sync(root, store);
  const before = store.getDocument(path.join(root, "ok.txt"))!.parse_version;
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "cli-data") };
  const indexed = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.match(indexed.stdout, /診斷彙總（錯誤碼）/);
  assert.doesNotMatch(indexed.stdout, /broken\.pdf/);
  const status = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /索引容量（檔案長度/);
  assert.match(status.stdout, /目前索引文件問題：/);
  assert.match(status.stdout, /status --issues/);
  assert.doesNotMatch(status.stdout, /PDF_CORRUPT/);
  const issues = spawnSync(process.execPath, [cli, "status", "--issues", "--types"], { encoding: "utf8", env });
  assert.equal(issues.status, 0, issues.stderr);
  assert.match(issues.stdout, /目前索引文件問題：/);
  assert.match(issues.stdout, /各根最近同步診斷：/);
  assert.match(issues.stdout, /PDF_CORRUPT/);
  assert.match(issues.stdout, /\.java：/);
  assert.match(issues.stdout, /（無副檔名）/);
  const dup = spawnSync(process.execPath, [cli, "status", "--issues", "--issues"], { encoding: "utf8", env });
  assert.equal(dup.status, 2);
  const unknown = spawnSync(process.execPath, [cli, "status", "--vacuum"], { encoding: "utf8", env });
  assert.equal(unknown.status, 2);
  assert.equal(store.getDocument(path.join(root, "ok.txt"))?.parse_version, before);
}));

test("M27 storage footprint treats missing as absent and permission errors as unknown", () => {
  const report = collectIndexStorage("/tmp/does-not-exist-lds-index.db", () => { const error = new Error("no") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; });
  assert.equal(report.files.every(item => item.missing), true);
  assert.equal(report.totalBytes, 0);
  const denied = collectIndexStorage("/tmp/index.db", target => {
    if (target.endsWith("-wal")) {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    if (target.endsWith("-shm") || target.endsWith("-journal") || target.includes("writer")) {
      const error = new Error("no") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return { size: 2048 };
  });
  assert.equal(denied.incomplete, true);
  assert.equal(denied.totalBytes, null);
  assert.equal(denied.files.find(item => item.label === "主庫 -wal")?.unknown, true);
  assert.equal(denied.files.find(item => item.label === "主庫")?.bytes, 2048);
});
test("M27 compact 顯示主庫與 WAL 的合計大小", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m27-compact-"));
  const root = path.join(temp, "docs");
  const dataDir = path.join(temp, "data");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  let reader: DatabaseSync | undefined;
  let raw: DatabaseSync | undefined;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "note.txt"), "compact test");
    const indexed = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
    assert.equal(indexed.status, 0, indexed.stderr);
    const database = path.join(dataDir, "LocalDocSearch", "index.db");
    reader = new DatabaseSync(database);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM documents").get();
    raw = new DatabaseSync(database);
    raw.exec("PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE");
    const insert = raw.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)");
    for (let index = 0; index < 2_000; index++) insert.run(`compact-${index}`, "x".repeat(4_096));
    raw.exec("COMMIT");
    raw.close();
    raw = undefined;
    const before = collectIndexStorage(database);
    const mainBytes = before.files.find(file => file.suffix === "")?.bytes ?? 0;
    assert.ok(before.totalBytes !== null && before.totalBytes > mainBytes);
    reader.exec("ROLLBACK");
    reader.close();
    reader = undefined;
    const beforeCompact = collectIndexStorage(database);
    assert.ok(beforeCompact.totalBytes !== null && beforeCompact.totalBytes > mainBytes);
    const compact = spawnSync(process.execPath, [cli, "compact"], { encoding: "utf8", env });
    assert.equal(compact.status, 0, compact.stderr);
    const after = collectIndexStorage(database);
    assert.ok(after.totalBytes !== null);
    const sizes = /壓縮完成：([\d.]+) MiB → ([\d.]+) MiB。/u.exec(compact.stdout);
    assert.ok(sizes, compact.stdout);
    assert.ok(Number(sizes[1]) > mainBytes / (1024 * 1024) + 1, "compact 前大小必須包含 WAL／附屬檔");
    assert.equal(sizes[2], formatMib(after.totalBytes).replace(" MiB", ""));
  } finally {
    try { raw?.close(); } catch { /* 測試失敗清理 */ }
    try { reader?.exec("ROLLBACK"); } catch { /* 測試失敗清理 */ }
    try { reader?.close(); } catch { /* 測試失敗清理 */ }
    await rm(temp, { recursive: true, force: true });
  }
});

test("M27 schema adds parse_version on existing documents table", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m27-schema-"));
  const database = path.join(temp, "index.db");
  try {
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
        extension TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
        indexed_at_ms INTEGER NOT NULL, status TEXT NOT NULL, error_code TEXT, error_message TEXT);`);
    db.close();
    const store = new IndexStore(database);
    const columns = (store as unknown as { db: DatabaseSync }).db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    assert.ok(columns.some(item => item.name === "parse_version"));
    store.close();
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("0.36.1 Windows system exclusions match only exact volume-root children", () => {
  assert.equal(isWindowsVolumeSystemPath("D:\\$RECYCLE.BIN", "win32"), true);
  assert.equal(isWindowsVolumeSystemPath("d:\\system volume information\\tracking.log", "win32"), true);
  assert.equal(isWindowsVolumeSystemPath("\\\\server\\share\\$Recycle.Bin\\item", "win32"), true);
  assert.equal(isWindowsVolumeSystemRoot("D:\\System Volume Information", "win32"), true);
  assert.equal(isWindowsVolumeSystemRoot("\\\\server\\share\\$RECYCLE.BIN", "win32"), true);
  assert.equal(isWindowsVolumeSystemPath("D:\\work\\$RECYCLE.BIN-notes", "win32"), false);
  assert.equal(isWindowsVolumeSystemPath("D:\\archive\\System Volume Information", "win32"), false);
  assert.equal(isWindowsVolumeSystemPath("/tmp/$RECYCLE.BIN", "posix"), false);
});

test("M27 verbose still lists diagnostics while default index stays quiet", () => fixture(async (root, _store, temp) => {
  await writeFile(path.join(root, "broken.pdf"), "x");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "vdata") };
  const quiet = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /broken\.pdf/);
  assert.match(quiet.stdout, /診斷彙總/);
  const verbose = spawnSync(process.execPath, [cli, "index", root, "--verbose"], { encoding: "utf8", env });
  assert.match(verbose.stdout + verbose.stderr, /broken\.pdf/);
}));

test("M27 zero files and help mention new flags", () => fixture(async (root, _store, temp) => {
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "empty-data") };
  const indexed = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.match(indexed.stdout, /沒有找到文件/);
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
  assert.match(help.stdout, /status \[--issues\] \[--types\]/);
  assert.match(help.stdout, /\.java/);
}));
