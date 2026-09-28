import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { applyFileUpdate } from "../src/local-update.js";
import { RootExclusion } from "../src/root-exclusion.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { DEBOUNCE_MAX_WAIT_FACTOR, LiveUpdateEngine, type LiveUpdateOptions } from "../src/live-update.js";
import { formatLiveStatus } from "../src/autoupdate.js";

// SPEC §53：自動更新在監看與事件層就套用排除規則，防抖設上限。

type FakeTimer = { id: number; ms: number; fn: () => void };
type FakeWatcher = EventEmitter & { close(): void; recursive: boolean };

const DEBOUNCE = 200;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("timed out");
}

function fakeWatch(emitters: Map<string, FakeWatcher>, onWatch?: (dir: string) => void): typeof fs.watch {
  return ((watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
    const dir = String(watchPath);
    onWatch?.(dir);
    const recursive = typeof opts === "object" && opts !== null && (opts as { recursive?: boolean }).recursive === true;
    const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
    const watcher = new EventEmitter() as FakeWatcher;
    watcher.recursive = recursive;
    watcher.close = () => { emitters.delete(dir); watcher.removeAllListeners(); };
    watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
    emitters.set(dir, watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function startEngine(store: IndexStore, extra: Partial<LiveUpdateOptions> & { onWatch?: (dir: string) => void } = {}) {
  const registered = store.roots()[0]!;
  const emitters = new Map<string, FakeWatcher>();
  const timers: FakeTimer[] = [];
  let timerId = 1;
  const syncCalls: string[] = [];
  const stop = deferred();
  const ready = deferred();
  const { onWatch, ...options } = extra;
  const engine = new LiveUpdateEngine(store, [registered], {
    mode: "foreground",
    debounceMs: DEBOUNCE,
    reconcileMs: 0,
    syncNow: false,
    sleep: async () => {},
    watch: fakeWatch(emitters, onWatch),
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
    ...options,
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await ready.promise;
  return { engine, emitters, timers, stop, running, syncCalls, root: registered };
}

function fireDebounce(timers: FakeTimer[]): void {
  const debounce = [...timers].reverse().find(item => item.ms <= DEBOUNCE);
  assert.ok(debounce);
  timers.splice(timers.indexOf(debounce), 1);
  debounce.fn();
}

async function fixture(prefix: string, ignore: string) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "home");
  await mkdir(path.join(root, "AppData", "Local"), { recursive: true });
  await mkdir(path.join(root, "Documents"), { recursive: true });
  await mkdir(path.join(root, "work", "cache"), { recursive: true });
  await writeFile(path.join(root, ".localdocsearchignore"), ignore);
  await writeFile(path.join(root, "AppData", "Local", "noise.txt"), "appdata-needle");
  await writeFile(path.join(root, "Documents", "doc.txt"), "documents-seed");
  await writeFile(path.join(root, "work", "cache", "c.txt"), "cache-needle");
  await writeFile(path.join(root, "work", "w.txt"), "work-seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  return { temp, root: store.roots()[0]!, store };
}

test("0.39.1 exclusion matches any excluded ancestor, like a full scan", async () => {
  const { temp, root, store } = await fixture("lds-m43-rule-", "/AppData/\ncache/\n*.tmp\n");
  try {
    const exclusion = await RootExclusion.load(root, store);
    assert.equal(exclusion.excludes(path.join(root, "AppData"), true), true);
    assert.equal(exclusion.excludes(path.join(root, "AppData"), false), false, "只排除目錄的規則不排除同名檔案");
    assert.equal(exclusion.excludes(path.join(root, "AppData", "Local", "x.txt"), false), true);
    assert.equal(exclusion.excludes(path.join(root, "AppData", "Local"), false), true);
    assert.equal(exclusion.excludes(path.join(root, "work", "cache", "deep", "c.txt"), false), true);
    assert.equal(exclusion.excludes(path.join(root, "work", "a.tmp"), false), true);
    assert.equal(exclusion.excludes(path.join(root, "work", "w.txt"), false), false);
    assert.equal(exclusion.excludes(path.join(root, "Documents", "AppData", "x.txt"), false), false, "錨定規則只從根目錄比對");
    assert.equal(exclusion.excludes(path.join(root, "node_modules", "p", "x.txt"), false), true);
    assert.equal(exclusion.excludes(path.join(root, "~$draft.docx"), false), true);
    assert.equal(exclusion.excludes(root, true), false);
    assert.equal(exclusion.excludes(path.join(temp, "elsewhere.txt"), false), false);
    // 完整掃描的結果與此判斷一致。
    assert.equal(search(store, "appdata-needle").length, 0);
    assert.equal(search(store, "cache-needle").length, 0);
    assert.equal(search(store, "work-seed").length, 1);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 merged ignore scopes also exclude descendants", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m43-merge-"));
  const parent = path.join(temp, "all");
  const child = path.join(parent, "team");
  await mkdir(path.join(child, "build", "out"), { recursive: true });
  await writeFile(path.join(child, ".localdocsearchignore"), "/build/\n");
  await writeFile(path.join(child, "build", "out", "b.txt"), "build-needle");
  await writeFile(path.join(child, "t.txt"), "team-seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    await sync(child, store);
    await sync(parent, store);
    const root = store.roots()[0]!;
    assert.equal(store.roots().length, 1);
    const exclusion = await RootExclusion.load(root, store);
    assert.equal(exclusion.excludes(path.join(root, "team", "build", "out", "b.txt"), false), true);
    assert.equal(exclusion.excludes(path.join(root, "team", "t.txt"), false), false);
    assert.equal(exclusion.excludes(path.join(root, "build", "x.txt"), false), false, "子根規則只作用於子根");
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 local update skips files inside a directory-only excluded folder", async () => {
  const { temp, root, store } = await fixture("lds-m43-local-", "/AppData/\n");
  try {
    const target = path.join(root, "AppData", "Local", "late.txt");
    await writeFile(target, "late-appdata-needle");
    const result = await applyFileUpdate(target, root, store, { sleep: async () => {} });
    assert.equal(result.kind, "skipped");
    assert.equal(store.getDocument(target), undefined);
    assert.equal(search(store, "late-appdata-needle").length, 0);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 split mode does not watch excluded direct children", async () => {
  const { temp, root, store } = await fixture("lds-m43-split-", "/AppData/\nwork\n");
  const session = await startEngine(store);
  try {
    const snap = session.engine.snapshot();
    assert.equal(snap.roots[0]?.scopeMode, "split");
    assert.equal(snap.roots[0]?.handles, 2, "根目錄＋Documents");
    assert.equal(session.emitters.has(path.join(root, "AppData")), false);
    assert.equal(session.emitters.has(path.join(root, "work")), false);
    assert.equal(session.emitters.get(path.join(root, "Documents"))?.recursive, true);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 coarse mode drops excluded events before queueing while normal changes still index", async () => {
  const { temp, root, store } = await fixture("lds-m43-coarse-", "/AppData/\n");
  const session = await startEngine(store, { watchHandleLimit: 1 });
  try {
    assert.equal(session.engine.snapshot().roots[0]?.scopeMode, "coarse");
    const rootWatcher = session.emitters.get(root)!;
    for (let index = 0; index < 5000; index++) {
      rootWatcher.emit("change", "change", path.join("AppData", "Local", `f${index % 50}.log`));
    }
    rootWatcher.emit("change", "rename", "AppData");
    let snap = session.engine.snapshot();
    assert.equal(snap.eventCount, 0);
    assert.equal(snap.excludedEventCount, 5001);
    assert.equal(snap.queuePendingCount, 0);
    assert.equal(snap.pendingCount, 0);
    assert.equal(session.timers.length, 0, "被排除事件不排防抖");

    await writeFile(path.join(root, "Documents", "doc.txt"), "documents-fresh-needle");
    rootWatcher.emit("change", "change", path.join("Documents", "doc.txt"));
    fireDebounce(session.timers);
    await waitUntil(() => search(store, "documents-fresh-needle").length === 1);
    snap = session.engine.snapshot();
    assert.equal(snap.eventCount, 1);
    assert.equal(snap.rootScanCount, 0);
    assert.match(formatLiveStatus(snap), /已排除事件 5001/u);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 continuous events cannot postpone processing past the debounce cap", async () => {
  const { temp, root, store } = await fixture("lds-m43-cap-", "/AppData/\n");
  let clock = 1_000_000;
  const session = await startEngine(store, { now: () => clock });
  try {
    const watcher = session.emitters.get(path.join(root, "Documents"))!;
    const delays: number[] = [];
    for (let step = 0; step <= DEBOUNCE_MAX_WAIT_FACTOR * 2; step++) {
      watcher.emit("change", "change", "doc.txt");
      delays.push(session.timers.at(-1)!.ms);
      clock += DEBOUNCE / 2;
    }
    assert.equal(session.timers.length, 1);
    assert.equal(delays[0], DEBOUNCE);
    const capIndex = (DEBOUNCE_MAX_WAIT_FACTOR * DEBOUNCE) / (DEBOUNCE / 2);
    assert.equal(delays[capIndex], 0, "到達上限時立即處理");
    assert.ok(delays.every(ms => ms <= DEBOUNCE));

    await writeFile(path.join(root, "Documents", "doc.txt"), "capped-needle");
    fireDebounce(session.timers);
    await waitUntil(() => search(store, "capped-needle").length === 1);
    // 處理後重新起算。
    watcher.emit("change", "change", "doc.txt");
    assert.equal(session.timers.at(-1)!.ms, DEBOUNCE);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 queued excluded paths are acked without subtree sync", async () => {
  const { temp, root, store } = await fixture("lds-m43-queue-", "/AppData/\n");
  const queue = new LiveWorkQueue(store.databasePath);
  queue.acceptPath(root, path.join("AppData", "Local"));
  queue.acceptPath(root, path.join("AppData", "Local", "noise.txt"));
  queue.acceptPath(root, "AppData");
  await writeFile(path.join(root, "Documents", "doc.txt"), "queued-doc-needle");
  queue.acceptPath(root, path.join("Documents", "doc.txt"));
  const session = await startEngine(store, { workQueue: queue });
  try {
    await waitUntil(() => search(store, "queued-doc-needle").length === 1);
    await waitUntil(() => queue.pendingCount() === 0);
    assert.deepEqual(session.syncCalls, []);
    assert.equal(search(store, "appdata-needle").length, 0);
  } finally {
    session.stop.resolve();
    await session.running;
    queue.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 ignore file change rebuilds split watchers under the new rules", async () => {
  const { temp, root, store } = await fixture("lds-m43-reload-", "/AppData/\n");
  const session = await startEngine(store);
  try {
    assert.equal(session.emitters.has(path.join(root, "work")), true);
    await writeFile(path.join(root, ".localdocsearchignore"), "/AppData/\n/work/\n");
    session.emitters.get(root)!.emit("change", "change", ".localdocsearchignore");
    assert.equal(session.emitters.has(path.join(root, "work")), false);
    assert.equal(session.emitters.has(path.join(root, "AppData")), false);
    assert.equal(session.engine.snapshot().roots[0]?.pending, 1, "排定整根校正");

    await writeFile(path.join(root, ".localdocsearchignore"), "/work/\n");
    session.emitters.get(root)!.emit("change", "change", ".localdocsearchignore");
    assert.equal(session.emitters.get(path.join(root, "AppData"))?.recursive, true);
    assert.equal(session.emitters.has(path.join(root, "work")), false);
    assert.equal(session.engine.snapshot().roots[0]?.scopeMode, "split");
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 a new directory that vanishes before attach keeps split mode", async () => {
  const { temp, root, store } = await fixture("lds-m43-vanish-", "/AppData/\n");
  const flash = path.join(root, "flash");
  const session = await startEngine(store, {
    onWatch: dir => {
      if (dir !== flash) return;
      rmSync(flash, { recursive: true, force: true });
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    },
  });
  try {
    await mkdir(flash);
    session.emitters.get(root)!.emit("change", "rename", "flash");
    const snap = session.engine.snapshot();
    assert.equal(snap.roots[0]?.scopeMode, "split");
    assert.equal(session.emitters.has(root), true);
    assert.equal(session.emitters.get(root)?.recursive, false);
    assert.equal(snap.roots[0]?.pending, 1, "路徑仍排入待辦核對");
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.1 new excluded top-level directory gets no watcher", async () => {
  const { temp, root, store } = await fixture("lds-m43-newex-", "/AppData/\n/Temp*/\n");
  const session = await startEngine(store);
  try {
    const created = path.join(root, "Temp123");
    await mkdir(created);
    session.emitters.get(root)!.emit("change", "rename", "Temp123");
    assert.equal(session.emitters.has(created), false);
    const snap = session.engine.snapshot();
    assert.equal(snap.excludedEventCount, 1);
    assert.equal(snap.eventCount, 0);
    assert.equal(snap.queuePendingCount, 0);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
