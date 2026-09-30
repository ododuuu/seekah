import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, attempts = 1000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise<void>(resolve => { setImmediate(resolve); });
  }
  throw new Error("孤兒佇列 restore 測試逾時");
}

async function setup(files: Record<string, string>): Promise<{
  temp: string;
  root: string;
  database: string;
  store: IndexStore;
}> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m61-orphan-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const store = new IndexStore(database);
  await sync(root, store);
  return { temp, root, database, store };
}

function seedState(queue: LiveWorkQueue, root: string): void {
  queue.acceptPath(root, "stale.txt");
  queue.markDirtyScope(root, "stale");
  const state = queue.beginReconcile(root, "stale");
  queue.saveReconcileStep(state, "stale.txt", "file");
}

function assertRootStateCleared(queue: LiveWorkQueue, root: string): void {
  assert.deepEqual(queue.list(root), []);
  assert.equal(queue.reconcileStatus(root), undefined);
  assert.deepEqual(queue.reconcileSeenPaths(root, 1), []);
}

test("0.43.0 engine startup removes orphan work and reconcile state only", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  let now = 1000;
  const queue = new LiveWorkQueue(fixture.database, { now: () => now });
  const current = fixture.store.roots()[0]!;
  const orphan = path.join(fixture.temp, "old-root");
  try {
    seedState(queue, orphan);
    now = 2000;
    const currentItem = queue.acceptPath(current, "current.txt");
    const currentState = queue.beginReconcile(current, "current");
    queue.saveReconcileStep(currentState, "seed.txt", "file");
    const logs: string[] = [];
    new LiveUpdateEngine(fixture.store, [current], { mode: "foreground", workQueue: queue }, {
      write: line => { logs.push(line); },
      waitForStop: () => Promise.resolve(),
    });

    assertRootStateCleared(queue, orphan);
    assert.deepEqual(queue.listPaths(current).map(item => item.relPath), [currentItem.relPath]);
    assert.equal(queue.reconcileStatus(current)?.generation, currentState.generation);
    assert.deepEqual(queue.reconcileSeenPaths(current, currentState.generation), ["seed.txt"]);
    assert.equal(queue.pendingCount(), 1);
    assert.equal(queue.pendingPathCount(), 1);
    assert.equal(queue.oldestCreatedAtMs(), 2000);
    assert.equal(logs.some(line => line.includes("根 1；work_items 2；reconcile_state 1；reconcile_seen 1")), true);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 moving a root to trash clears every live state table", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const queue = new LiveWorkQueue(fixture.database);
  try {
    seedState(queue, fixture.root);
    fixture.store.moveRootsToTrash([fixture.root]);
    assert.deepEqual(fixture.store.roots(), []);
    assertRootStateCleared(queue, fixture.root);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 merging a child root clears child state but keeps parent state", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const child = fixture.root;
  const parent = path.join(fixture.temp, "parent");
  const queue = new LiveWorkQueue(fixture.database);
  try {
    seedState(queue, child);
    queue.acceptPath(parent, "parent.txt");
    fixture.store.mergeChildRoots(parent, [child]);
    assert.deepEqual(fixture.store.roots(), [parent]);
    assertRootStateCleared(queue, child);
    assert.deepEqual(queue.listPaths(parent).map(item => item.relPath), ["parent.txt"]);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 removing a root clears every live state table", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const queue = new LiveWorkQueue(fixture.database);
  try {
    seedState(queue, fixture.root);
    fixture.store.removeRoot(fixture.root);
    assert.deepEqual(fixture.store.roots(), []);
    assertRootStateCleared(queue, fixture.root);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 restored root accepts and processes new live work", { timeout: 20000 }, async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const queue = new LiveWorkQueue(fixture.database);
  const watcher = new EventEmitter() as EventEmitter & { close(): void };
  watcher.close = () => {};
  const stop = deferred<void>();
  const ready = deferred<void>();
  try {
    seedState(queue, fixture.root);
    fixture.store.moveRootsToTrash([fixture.root]);
    await sync(fixture.root, fixture.store);
    const restored = fixture.store.roots()[0]!;
    await writeFile(path.join(restored, "restored.txt"), "restored-token", "utf8");
    queue.acceptPath(restored, "restored.txt");
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const engine = new LiveUpdateEngine(fixture.store, [restored], {
      mode: "foreground",
      debounceMs: 200,
      reconcileMs: 0,
      syncNow: false,
      sleep: async () => {},
      workQueue: queue,
      watch: ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
        const callback = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
        watcher.on("change", (event, filename) => callback(event as fs.WatchEventType, filename as string | null));
        return watcher;
      }) as unknown as typeof fs.watch,
      setTimer: (fn, _ms) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: id => { timers.delete(id as unknown as number); },
    }, {
      write: line => { if (line.startsWith("監看中：")) ready.resolve(undefined); },
      waitForStop: () => stop.promise,
    });
    const running = engine.run();
    await ready.promise;
    await waitUntil(() => search(fixture.store, "restored-token").length === 1);
    assert.equal(queue.listPaths(restored).length, 0);
    stop.resolve(undefined);
    await running;
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});
