import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { applyFileUpdate, type LocalUpdateOptions } from "../src/local-update.js";
import { RootExclusion } from "../src/root-exclusion.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { DEBOUNCE_MAX_WAIT_FACTOR, LiveUpdateEngine, type LiveUpdateOptions } from "../src/live-update.js";

const DEBOUNCE = 100;

type FakeTimer = { id: number; ms: number; fn: () => void };
type FakeWatcher = EventEmitter & { close(): void; recursive: boolean };

import { EventEmitter } from "node:events";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
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

async function startEngine(store: IndexStore, extra: Partial<LiveUpdateOptions> = {}) {
  const registered = store.roots()[0]!;
  const emitters = new Map<string, FakeWatcher>();
  const timers: FakeTimer[] = [];
  let timerId = 1;
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [registered], {
    mode: "foreground",
    debounceMs: DEBOUNCE,
    reconcileMs: 100000,
    syncNow: false,
    sleep: async () => {},
    watch: fakeWatch(emitters),
    sync: async (rootPath, indexStore, syncOptions) => sync(rootPath, indexStore, syncOptions),
    setTimer: (fn, ms) => {
      const id = timerId++;
      timers.push({ id, ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: id => {
      const index = timers.findIndex(item => item.id === (id as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
    ...extra,
  }, {
    write: text => { ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await ready.promise;
  return { engine, emitters, timers, stop, running, root: registered };
}

function fireDebounce(timers: FakeTimer[]): void {
  const debounce = [...timers].reverse().find(item => item.ms <= DEBOUNCE);
  assert.ok(debounce);
  timers.splice(timers.indexOf(debounce), 1);
  debounce.fn();
}

async function fixture(prefix: string, ignoreContent: string) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(temp, "r");
  await mkdir(rootDir, { recursive: true });
  await writeFile(path.join(rootDir, ".localdocsearchignore"), ignoreContent);
  const store = new IndexStore(path.join(temp, "idx.db"));
  await sync(rootDir, store);
  return { temp, root: store.roots()[0]!, store };
}

test("m50 a) 傳入 exclusion 時一批多個檔案只載入規則一次（計數 spy）", async () => {
  const { temp, root, store } = await fixture("m50-reuse-", "secret/\n");
  let loadCalls = 0;
  const origLoad = RootExclusion.load;
  const origLoadSync = RootExclusion.loadSync;
  RootExclusion.load = async (root: string, store: IndexStore) => {
    loadCalls++;
    return origLoad(root, store);
  };
  // unchecked assign for static spy only in test; runtime shape known
  const loadSyncHolder = RootExclusion as unknown as { loadSync?: typeof RootExclusion.loadSync };
  if (origLoadSync) {
    loadSyncHolder.loadSync = (root: string, store: IndexStore) => {
      loadCalls++;
      return origLoadSync(root, store);
    };
  }
  try {
    const exclusion = await RootExclusion.load(root, store);
    const before = loadCalls;
    // 模擬一批 3 檔
    const f1 = path.join(root, "a.txt"); await writeFile(f1, "alpha");
    const f2 = path.join(root, "b.txt"); await writeFile(f2, "beta");
    const f3 = path.join(root, "c.txt"); await writeFile(f3, "gamma");
    const o1: LocalUpdateOptions = { exclusion, sleep: async () => {} };
    const o2: LocalUpdateOptions = { exclusion, sleep: async () => {} };
    const o3: LocalUpdateOptions = { exclusion, sleep: async () => {} };
    await applyFileUpdate(f1, root, store, o1);
    await applyFileUpdate(f2, root, store, o2);
    await applyFileUpdate(f3, root, store, o3);
    assert.equal(loadCalls - before, 0, "傳入 exclusion 時不應再 load");
    // 確認檔案被索引（未被排除）
    assert.ok(search(store, "alpha").length >= 1);
  } finally {
    (RootExclusion as unknown as { load?: typeof RootExclusion.load }).load = origLoad;
    if (origLoadSync) {
      loadSyncHolder.loadSync = origLoadSync;
    }
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("m50 b) 規則檔改變後新規則生效（不會用到舊快取而索引應排除檔）", async () => {
  const { temp, root, store } = await fixture("m50-rulechg-", "");
  try {
    const keep = path.join(root, "keep.txt");
    await writeFile(keep, "keep-needle");
    const excl1 = await RootExclusion.load(root, store);
    const r1 = await applyFileUpdate(keep, root, store, { exclusion: excl1, sleep: async () => {} });
    assert.notEqual(r1.kind, "skipped");
    assert.ok(search(store, "keep-needle").length >= 1);

    await writeFile(path.join(root, ".localdocsearchignore"), "keep*\n");
    const excl2 = await RootExclusion.load(root, store);
    const excluded = path.join(root, "keep2.txt");
    await writeFile(excluded, "keep2-needle");
    const r2 = await applyFileUpdate(excluded, root, store, { exclusion: excl2, sleep: async () => {} });
    assert.equal(r2.kind, "skipped");
    assert.equal(search(store, "keep2-needle").length, 0);
    assert.equal(store.getDocument(excluded), undefined);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("m50 c) 未傳入 exclusion 時行為與原本相同", async () => {
  const { temp, root, store } = await fixture("m50-nopass-", "skipme/\n");
  let loadCalls = 0;
  const origLoad = RootExclusion.load;
  RootExclusion.load = async (root: string, store: IndexStore) => { loadCalls++; return origLoad(root, store); };
  try {
    const f = path.join(root, "skipme", "x.txt");
    await mkdir(path.join(root, "skipme"), { recursive: true });
    await writeFile(f, "skipped-content");
    // 不傳 exclusion，應每次 load 且行為相同（skipped）
    const r1 = await applyFileUpdate(f, root, store, { sleep: async () => {} });
    const r2 = await applyFileUpdate(f, root, store, { sleep: async () => {} });
    assert.equal(r1.kind, "skipped");
    assert.equal(r2.kind, "skipped");
    assert.ok(loadCalls >= 2, "未傳時應維持每檔載入");
    assert.equal(search(store, "skipped-content").length, 0);
  } finally {
    RootExclusion.load = origLoad;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
