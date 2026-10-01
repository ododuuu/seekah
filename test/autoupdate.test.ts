import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { applyFileDelete, applyFileUpdate, UNSTABLE_BACKOFF_MS, WRITER_BACKOFF_MS } from "../src/local-update.js";
import { parseDocument } from "../src/parser.js";
import { IndexBusyError } from "../src/write-lock.js";
import { runWatch } from "../src/watch.js";
import { createAutoupdateLog, AUTOUPDATE_LOG_LIMIT } from "../src/autoupdate-log.js";
import { sendControlRequest, writeStateFile, readStateFile, createInstanceToken, createInstanceId } from "../src/autoupdate-control.js";
import { resolveAutoupdateReconcile, QUEUE_LIMIT, WatchError } from "../src/live-update.js";
import { canonicalIndexPath } from "../src/live-lease.js";

const cli = path.resolve("dist/src/cli.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture<T>(run: (root: string, store: IndexStore, temp: string) => Promise<T>): Promise<T> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-031-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  const store = new IndexStore(path.join(temp, "index.db"));
  try { return await run(root, store, temp); }
  finally { store.close(); await rm(temp, { recursive: true, force: true }); }
}

test("0.31.0 reconcile bounds reject 0 and out of range values", () => {
  assert.equal(resolveAutoupdateReconcile(undefined), 21_600_000);
  assert.equal(resolveAutoupdateReconcile(900_000), 900_000);
  assert.equal(resolveAutoupdateReconcile(86_400_000), 86_400_000);
  for (const invalid of [0, 899_999, 86_400_001, 1.5, NaN]) {
    assert.throws(() => resolveAutoupdateReconcile(invalid), (error: WatchError) => error.code === "AUTOUPDATE_RECONCILE_INVALID");
  }
});

test("0.31.0 CLI autoupdate usage and invalid options", () => {
  for (const args of [
    ["autoupdate"],
    ["autoupdate", "start", "--debounce"],
    ["autoupdate", "start", "--reconcile", "0"],
    ["autoupdate", "start", "--reconcile", "1000"],
    ["autoupdate", "status", "--debounce", "200"],
    ["autoupdate", "nope"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")} → ${result.stderr}`);
  }
});

test("0.31.0 local file add/modify/delete becomes searchable and does not update last complete sync", async () => {
  await fixture(async (root, store) => {
    await writeFile(path.join(root, "a.txt"), "初版內容");
    await sync(root, store);
    const before = store.getLastSyncReport(root).successfulAt;
    assert.ok(before);
    const added = path.join(root, "b.txt");
    await writeFile(added, "新增關鍵字");
    const add = await applyFileUpdate(added, store.roots()[0]!, store);
    assert.equal(add.updated, 1);
    assert.equal(add.added, 1);
    assert.equal(search(store, "新增關鍵字").length, 1);
    await writeFile(path.join(root, "a.txt"), "修改後 可搜尋");
    const mod = await applyFileUpdate(path.join(root, "a.txt"), store.roots()[0]!, store);
    assert.equal(mod.updated, 1);
    assert.equal(search(store, "可搜尋").length, 1);
    await rm(path.join(root, "a.txt"));
    const del = await applyFileDelete(path.join(root, "a.txt"), store.roots()[0]!, store);
    assert.equal(del.removed, 1);
    assert.equal(search(store, "可搜尋").length, 0);
    assert.equal(store.getLastSyncReport(root).successfulAt, before);
  });
});

test("0.31.0 rename and new directory tree use precise delete plus subtree scan", async () => {
  await fixture(async (root, store) => {
    const oldPath = path.join(root, "old.txt");
    await writeFile(oldPath, "改名前內容");
    await sync(root, store);
    const before = store.getLastSyncReport(root).successfulAt;
    const renamed = path.join(root, "new.txt");
    await writeFile(renamed, "改名後內容");
    await rm(oldPath);
    const del = await applyFileDelete(oldPath, store.roots()[0]!, store);
    const add = await applyFileUpdate(renamed, store.roots()[0]!, store);
    assert.equal(del.removed, 1);
    assert.equal(add.updated, 1);
    assert.equal(search(store, "改名前內容").length, 0);
    assert.equal(search(store, "改名後內容").length, 1);
    const nested = path.join(root, "subdir", "deep.txt");
    await mkdir(path.dirname(nested), { recursive: true });
    await writeFile(nested, "子樹新增");
    const report = await sync(path.dirname(nested), store);
    assert.equal(search(store, "子樹新增").length, 1);
    assert.equal(report.operation, "subtree");
    assert.equal(store.getLastSyncReport(root).successfulAt, before);
  });
});

test("0.31.0 delete retains old index when parent is unreadable", async () => {
  await fixture(async (root, store) => {
    const file = path.join(root, "keep.txt");
    await writeFile(file, "保留舊索引");
    await sync(root, store);
    const del = await applyFileDelete(file, store.roots()[0]!, store, {
      readdir: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    });
    assert.equal(del.kind, "retained");
    assert.equal(search(store, "保留舊索引").length, 1);
  });
});

test("0.31.0 unstable file retries with backoff and keeps the previous index", async () => {
  await fixture(async (root, store) => {
    const file = path.join(root, "live.txt");
    await writeFile(file, "穩定原文");
    await sync(root, store);
    await writeFile(file, "第一次變更");
    const delays: number[] = [];
    let attempts = 0;
    const result = await applyFileUpdate(file, store.roots()[0]!, store, {
      sleep: async ms => { delays.push(ms); },
      parse: async filePath => {
        attempts++;
        await writeFile(filePath, `變動中 ${attempts} ${"x".repeat(attempts * 8)}`);
        return parseDocument(filePath);
      },
    });
    assert.equal(result.kind, "unstable");
    assert.equal(attempts, UNSTABLE_BACKOFF_MS.length + 1);
    assert.deepEqual(delays, [...UNSTABLE_BACKOFF_MS]);
    assert.equal(search(store, "穩定原文").length, 1);
    assert.equal(search(store, "變動中").length, 0);
  });
});

test("0.31.0 writer lock uses capped backoff then succeeds", async () => {
  await fixture(async (root, store) => {
    const file = path.join(root, "busy.txt");
    await writeFile(file, "鎖競爭");
    await sync(root, store);
    await writeFile(file, "鎖競爭 成功");
    const delays: number[] = [];
    let fails = 0;
    const result = await applyFileUpdate(file, store.roots()[0]!, store, {
      sleep: async ms => { delays.push(ms); },
      acquireLock: () => {
        if (fails++ < 3) throw new IndexBusyError();
        return () => {};
      },
    });
    assert.equal(result.updated, 1);
    assert.deepEqual(delays, WRITER_BACKOFF_MS.slice(0, 3));
    assert.equal(search(store, "成功").length, 1);
  });
});

test("0.31.0 watch file events do not call injected full-root sync", async () => {
  await fixture(async (root, store) => {
    await writeFile(path.join(root, "a.txt"), "監看原文");
    await sync(root, store);
    const registered = store.roots()[0]!;
    const syncCalls: string[] = [];
    const timers: Array<{ id: number; ms: number; fn: () => void }> = [];
    let timerId = 1;
    const stop = deferred();
    const ready = deferred();
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => {};
    const running = runWatch(store, [registered], {
      debounceMs: 200, rescanMs: 0, syncNow: false, enableControl: false,
      watch: ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
        const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
        watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
        return watcher;
      }) as unknown as typeof fs.watch,
      sync: async (rootPath, indexStore, syncOptions) => {
        syncCalls.push(rootPath);
        return sync(rootPath, indexStore, syncOptions);
      },
      setTimer: (fn, ms) => {
        const id = timerId++;
        timers.push({ id, ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: id => {
        const index = timers.findIndex(item => item.id === (id as unknown as number));
        if (index >= 0) timers.splice(index, 1);
      },
    }, {
      write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
      waitForStop: () => stop.promise,
    });
    await ready.promise;
    await writeFile(path.join(root, "a.txt"), "局部更新命中");
    watcher.emit("change", "change", "a.txt");
    const debounce = timers.find(item => item.ms === 200);
    assert.ok(debounce);
    debounce.fn();
    const start = Date.now();
    while (!search(store, "局部更新命中").length && Date.now() - start < 5000) await new Promise(r => setImmediate(r));
    assert.equal(search(store, "局部更新命中").length, 1);
    assert.equal(syncCalls.length, 0);
    watcher.emit("change", "change", null);
    assert.ok(timers.some(item => item.ms === 200));
    const overflow = timers.find(item => item.ms === 200);
    overflow?.fn();
    const started = Date.now();
    while (syncCalls.length === 0 && Date.now() - started < 5000) {
      const immediate = timers.find(item => item.ms === 0);
      if (immediate) {
        timers.splice(timers.indexOf(immediate), 1);
        immediate.fn();
      }
      await new Promise(r => setImmediate(r));
    }
    assert.equal(syncCalls.length, 1, "unknown filename must reconcile the root");
    stop.resolve();
    await running;
  });
});

test("0.31.0 queue overflow clears local candidates and reconciles", () => {
  assert.equal(QUEUE_LIMIT, 10_000);
});

test("0.31.0 autoupdate status without a live instance is AUTOUPDATE_NOT_RUNNING", () => {
  const temp = path.join(os.tmpdir(), `lds-031-status-${process.pid}`);
  const result = spawnSync(process.execPath, [cli, "autoupdate", "status"], {
    encoding: "utf8",
    env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: temp },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /AUTOUPDATE_NOT_RUNNING/);
});

test("0.31.0 search and status do not start a background instance", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-031-ro-"));
  const dataDir = path.join(temp, "data");
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "不啟動背景");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  try {
    assert.equal(spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env }).status, 0);
    const status = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", env });
    const lookup = spawnSync(process.execPath, [cli, "search", "不啟動背景"], { encoding: "utf8", env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(lookup.status, 0, lookup.stderr);
    const auto = spawnSync(process.execPath, [cli, "autoupdate", "status"], { encoding: "utf8", env });
    assert.equal(auto.status, 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.31.0 log rotation keeps five files and records AUTOUPDATE_LOG_ERROR on failure", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-031-log-"));
  try {
    const log = createAutoupdateLog(temp);
    const chunk = "x".repeat(64 * 1024);
    while (!existsSync(path.join(temp, "autoupdate.log.4"))) {
      log.write(chunk);
      if (statSync(path.join(temp, "autoupdate.log")).size > AUTOUPDATE_LOG_LIMIT) break;
    }
    for (let index = 0; index < 80; index++) log.write(chunk);
    assert.ok(existsSync(path.join(temp, "autoupdate.log")));
    assert.ok(existsSync(path.join(temp, "autoupdate.log.1")));
    assert.ok(existsSync(path.join(temp, "autoupdate.log.4")));
    const bytes = await readFile(path.join(temp, "autoupdate.log"), "utf8");
    assert.ok(!bytes.includes("secret-token-should-not-appear"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.31.0 wrong control token is rejected", async () => {
  await fixture(async (root, store, temp) => {
    await writeFile(path.join(root, "a.txt"), "token");
    await sync(root, store);
    writeStateFile({
      schemaVersion: 1,
      databasePath: canonicalIndexPath(store.databasePath),
      instanceId: createInstanceId(),
      pid: process.pid,
      token: createInstanceToken(),
      endpoint: path.join(temp, "missing.sock"),
      startedAt: new Date().toISOString(),
      settings: { debounceMs: 1500, reconcileMs: 21_600_000 },
      mode: "background",
    });
    await assert.rejects(
      sendControlRequest(path.join(temp, "missing.sock"), "deadbeef", "ping", 500),
      (error: Error & { code?: string }) => error.code === "AUTOUPDATE_NOT_RUNNING" || error.code === "AUTOUPDATE_UNRESPONSIVE",
    );
  });
});

test("0.31.0 detached start, status, file event search, stop, and second start of the same settings", {
  timeout: 30000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-031-live-"));
  const dataDir = path.join(temp, "data");
  const root = path.join(temp, "文件 目錄 (測試)");
  await mkdir(root, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "啟動前");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  const index = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env });
  assert.equal(index.status, 0, index.stderr);
  const start = spawnSync(process.execPath, [cli, "autoupdate", "start", "--debounce", "200", "--reconcile", "900000"], {
    encoding: "utf8", env, timeout: 20000,
  });
  assert.equal(start.status, 0, start.stderr + start.stdout);
  assert.match(start.stdout, /已啟動背景自動更新|已在執行/);
  const again = spawnSync(process.execPath, [cli, "autoupdate", "start", "--debounce", "200", "--reconcile", "900000"], {
    encoding: "utf8", env, timeout: 20000,
  });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /已在執行/);
  const different = spawnSync(process.execPath, [cli, "autoupdate", "start", "--debounce", "400", "--reconcile", "900000"], {
    encoding: "utf8", env,
  });
  assert.equal(different.status, 3);
  assert.match(different.stderr, /AUTOUPDATE_ALREADY_RUNNING/);
  await writeFile(path.join(root, "a.txt"), "背景可搜尋 關鍵字");
  const searchable = Date.now();
  let found = 0;
  while (Date.now() - searchable < 8000) {
    const lookup = spawnSync(process.execPath, [cli, "search", "背景可搜尋"], { encoding: "utf8", env });
    if (lookup.stdout.includes("背景可搜尋")) { found = 1; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(found, 1, "background local update should make the new text searchable");
  const status = spawnSync(process.execPath, [cli, "autoupdate", "status"], { encoding: "utf8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /背景執行中/);
  assert.doesNotMatch(status.stdout, /token=/);
  const state = readStateFile(path.join(dataDir, "LocalDocSearch", "index.db"));
  assert.ok(state);
  const argv = spawnSync("ps", ["-p", String(state.pid), "-o", "args="], { encoding: "utf8" });
  if (argv.status === 0) assert.doesNotMatch(argv.stdout, new RegExp(state.token));
  const stop = spawnSync(process.execPath, [cli, "autoupdate", "stop"], { encoding: "utf8", env, timeout: 20000 });
  assert.equal(stop.status, 0, stop.stderr);
  const after = spawnSync(process.execPath, [cli, "autoupdate", "status"], { encoding: "utf8", env });
  assert.equal(after.status, 3);
  await rm(temp, { recursive: true, force: true });
});

test("0.31.0 stale dead pid is replaced on start; live pid without control is unresponsive", {
  timeout: 20000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-031-stale-"));
  const dataDir = path.join(temp, "data");
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "stale");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  assert.equal(spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env }).status, 0);
  const db = path.join(dataDir, "LocalDocSearch", "index.db");
  writeStateFile({
    schemaVersion: 1,
    databasePath: canonicalIndexPath(db),
    instanceId: createInstanceId(),
    pid: 999999,
    token: createInstanceToken(),
    endpoint: path.join(dataDir, "LocalDocSearch", "missing.sock"),
    startedAt: new Date().toISOString(),
    settings: { debounceMs: 1500, reconcileMs: 900000 },
    mode: "background",
  });
  const start = spawnSync(process.execPath, [cli, "autoupdate", "start", "--reconcile", "900000"], {
    encoding: "utf8", env, timeout: 20000,
  });
  assert.equal(start.status, 0, start.stderr + start.stdout);
  spawnSync(process.execPath, [cli, "autoupdate", "stop"], { encoding: "utf8", env, timeout: 20000 });
  await rm(temp, { recursive: true, force: true });
});

test("0.31.0 foreground watch conflicts with autoupdate start and stop", { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-031-fg-"));
  const dataDir = path.join(temp, "data");
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "前景衝突");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  assert.equal(spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env }).status, 0);
  const child = spawn(process.execPath, [cli, "watch", "--rescan", "0"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watch did not start")), 10000);
    child.stdout?.on("data", chunk => {
      output += String(chunk);
      if (output.includes("按 Ctrl+C")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  try {
    const start = spawnSync(process.execPath, [cli, "autoupdate", "start", "--reconcile", "900000"], { encoding: "utf8", env });
    assert.equal(start.status, 3, start.stderr);
    assert.match(start.stderr, /AUTOUPDATE_FOREGROUND_ACTIVE/);
    const stop = spawnSync(process.execPath, [cli, "autoupdate", "stop"], { encoding: "utf8", env });
    assert.equal(stop.status, 3, stop.stderr);
    assert.match(stop.stderr, /AUTOUPDATE_FOREGROUND_ACTIVE/);
    const status = spawnSync(process.execPath, [cli, "autoupdate", "status"], { encoding: "utf8", env });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /前景監看/);
  } finally {
    child.kill("SIGINT");
    await new Promise(resolve => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
