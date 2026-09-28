import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LiveUpdateEngine } from "../src/live-update.js";

// SPEC §56：新資料夾分批展開成逐檔待辦。測試把每輪上限調小，避免建立數千個檔案。

const WALK = 60;

type FakeTimer = { id: number; ms: number; fn: () => void };
type FakeWatcher = EventEmitter & { close(): void };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeWatch(emitters: Map<string, FakeWatcher>): typeof fs.watch {
  return ((watchPath: fs.PathLike, _opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
    const watcher = new EventEmitter() as FakeWatcher;
    watcher.close = () => { emitters.delete(String(watchPath)); watcher.removeAllListeners(); };
    watcher.on("change", (event, filename) => listener!(event as fs.WatchEventType, filename as string | null));
    emitters.set(String(watchPath), watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function start(prefix: string, prepare: (home: string) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(temp, "home");
  await mkdir(path.join(home, "work"), { recursive: true });
  await writeFile(path.join(home, "seed.txt"), "seed");
  await prepare(home);
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(home, store);
  const root = store.roots()[0]!;
  const queue = new LiveWorkQueue(store.databasePath);
  const emitters = new Map<string, FakeWatcher>();
  const timers: FakeTimer[] = [];
  let timerId = 1;
  const syncCalls: string[] = [];
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [root], {
    mode: "foreground", debounceMs: 200, reconcileMs: 0, syncNow: false, sleep: async () => {},
    workQueue: queue,
    localWalkEntries: WALK,
    watch: fakeWatch(emitters),
    sync: async (target, indexStore, options) => { syncCalls.push(target); return sync(target, indexStore, options); },
    setTimer: (fn, ms) => { const id = timerId++; timers.push({ id, ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: id => { const index = timers.findIndex(item => item.id === (id as unknown as number)); if (index >= 0) timers.splice(index, 1); },
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await ready.promise;
  /** 執行一輪：觸發一個防抖或立即接續的計時器，等本輪結束。 */
  const round = async () => {
    const next = timers.find(item => item.ms === 0 || item.ms === 200);
    if (!next) return false;
    timers.splice(timers.indexOf(next), 1);
    next.fn();
    const before = Date.now();
    while (engine.snapshot().phase !== "idle" || timers.every(item => item.ms !== 0 && item.ms !== 200)) {
      if (engine.snapshot().phase === "idle" && Date.now() - before > 50) break;
      await new Promise(resolve => setTimeout(resolve, 5));
      if (Date.now() - before > 60_000) throw new Error("round timed out");
    }
    return true;
  };
  const driveUntil = async (check: () => boolean, maxRounds = 200) => {
    for (let index = 0; index < maxRounds && !check(); index++) {
      if (!await round()) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(check(), "條件未在限定輪數內成立");
  };
  const close = async () => {
    stop.resolve();
    await running;
    queue.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  };
  return { engine, emitters, timers, queue, store, root, syncCalls, round, driveUntil, close };
}

test("0.39.4 a large new folder is expanded in bounded rounds and fully indexed", async () => {
  const session = await start("lds-m46-big-", async () => {});
  try {
    const { root, emitters, queue, store } = session;
    const big = path.join(root, "work", "big");
    const total = WALK * 4;
    for (let group = 0; group < 4; group++) {
      await mkdir(path.join(big, `g${group}`), { recursive: true });
    }
    for (let index = 0; index < total; index++) {
      await writeFile(path.join(big, `g${index % 4}`, `f${index}.txt`), `big-${index}`);
    }
    emitters.get(path.join(root, "work"))!.emit("change", "rename", "big");
    await session.round();
    const queued = queue.listPaths(root);
    assert.ok(queued.some(item => item.relPath === path.join("work", "big")), "資料夾待辦在展開完成前不確認");
    assert.ok(queued.length <= WALK + 1, `第一輪最多讀取上限個項目：${queued.length}`);
    assert.equal(session.engine.snapshot().subtreeScanCount, 1);

    // 展開進行中建立的新檔排在展開待辦之前，下一輪就處理，不必等整棵資料夾（SPEC §56.1）。
    await writeFile(path.join(root, "work", "note.txt"), "during-walk-needle");
    emitters.get(path.join(root, "work"))!.emit("change", "rename", "note.txt");
    await session.driveUntil(() => search(store, "during-walk-needle").length === 1, 2);
    assert.ok(queue.listPaths(root).some(item => item.relPath === path.join("work", "big")), "新檔先於資料夾展開完成");

    await session.driveUntil(() => queue.pendingCount() === 0, 400);
    assert.equal(search(store, "big-0").length, 1);
    assert.equal(search(store, `big-${total - 1}`).length, 1);
    assert.deepEqual(session.syncCalls, []);
    assert.equal(session.engine.snapshot().subtreeScanCount, 1);
  } finally {
    await session.close();
  }
});

test("0.39.4 expansion skips excluded folders and links", async () => {
  const session = await start("lds-m46-skip-", async home => {
    await writeFile(path.join(home, ".localdocsearchignore"), "cache/\n");
  });
  try {
    const { root, emitters, queue, store } = session;
    const moved = path.join(root, "work", "moved");
    await mkdir(path.join(moved, "cache"), { recursive: true });
    await mkdir(path.join(moved, "node_modules"), { recursive: true });
    await writeFile(path.join(moved, "keep.txt"), "moved-keep-needle");
    await writeFile(path.join(moved, "cache", "c.txt"), "moved-cache-needle");
    await writeFile(path.join(moved, "node_modules", "n.txt"), "moved-module-needle");
    const outside = path.join(root, "..", "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "o.txt"), "moved-outside-needle");
    try { await symlink(outside, path.join(moved, "link"), process.platform === "win32" ? "junction" : "dir"); } catch { /* 無法建立連結時略過此項 */ }
    emitters.get(path.join(root, "work"))!.emit("change", "rename", "moved");
    await session.driveUntil(() => queue.pendingCount() === 0 && search(store, "moved-keep-needle").length === 1);
    assert.equal(search(store, "moved-cache-needle").length, 0);
    assert.equal(search(store, "moved-module-needle").length, 0);
    assert.equal(search(store, "moved-outside-needle").length, 0);
  } finally {
    await session.close();
  }
});

test("0.39.4 after a folder is replaced, vanished files are removed and others kept", async () => {
  const session = await start("lds-m46-del-", async home => {
    await mkdir(path.join(home, "work", "proj", "sub"), { recursive: true });
    await writeFile(path.join(home, "work", "proj", "old.txt"), "proj-old-needle");
    await writeFile(path.join(home, "work", "proj", "sub", "stay.txt"), "proj-stay-needle");
  });
  try {
    const { root, emitters, queue, store } = session;
    assert.equal(search(store, "proj-old-needle").length, 1);
    await rm(path.join(root, "work", "proj", "old.txt"));
    await writeFile(path.join(root, "work", "proj", "new.txt"), "proj-new-needle");
    emitters.get(path.join(root, "work"))!.emit("change", "rename", "proj");
    await session.driveUntil(() => queue.pendingCount() === 0 && search(store, "proj-new-needle").length === 1);
    assert.equal(search(store, "proj-old-needle").length, 0, "已不存在的舊文件移除");
    assert.equal(search(store, "proj-stay-needle").length, 1, "仍存在者保留");
    assert.deepEqual(session.syncCalls, []);
  } finally {
    await session.close();
  }
});

test("0.39.4 queue keeps event priority when a path is also found by expansion", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m46-reason-"));
  const queue = new LiveWorkQueue(path.join(temp, "index.db"));
  try {
    queue.acceptPath("/r", "a.txt", "expand");
    queue.acceptPath("/r", "a.txt");
    queue.acceptPath("/r", "b.txt");
    queue.acceptPath("/r", "b.txt", "expand");
    queue.acceptPath("/r", "c.txt", "expand");
    const reasons = Object.fromEntries(queue.listPaths("/r").map(item => [item.relPath, item.reason]));
    assert.deepEqual(reasons, { "a.txt": "event", "b.txt": "event", "c.txt": "expand" });
  } finally {
    queue.close();
    await rm(temp, { recursive: true, force: true });
  }
});
