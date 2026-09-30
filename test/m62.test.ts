import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveWorkQueue, workStatePath } from "../src/live-queue.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createWorkbench, type WorkbenchHandle } from "../src/workbench.js";
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
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m62-orphan-"));
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

function holdWorkStateWriteLock(database: string): DatabaseSync {
  const blocker = new DatabaseSync(workStatePath(database));
  blocker.exec("BEGIN IMMEDIATE");
  return blocker;
}

function runStartupCleanup(store: IndexStore, queue: LiveWorkQueue): string[] {
  const logs: string[] = [];
  new LiveUpdateEngine(store, store.roots(), { mode: "foreground", workQueue: queue }, {
    write: line => { logs.push(line); },
    waitForStop: () => Promise.resolve(),
  });
  return logs;
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

test("0.43.0 purge of a current root leaves all live work state unchanged", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const queue = new LiveWorkQueue(fixture.database);
  try {
    seedState(queue, fixture.root);
    const beforeItems = queue.list(fixture.root);
    const beforeState = queue.reconcileStatus(fixture.root);
    const beforeSeen = queue.reconcileSeenPaths(fixture.root, beforeState!.generation);
    assert.equal(fixture.store.purgeTrashRoots([fixture.root]), 0);
    assert.deepEqual(queue.list(fixture.root), beforeItems);
    assert.deepEqual(queue.reconcileStatus(fixture.root), beforeState);
    assert.deepEqual(queue.reconcileSeenPaths(fixture.root, beforeState!.generation), beforeSeen);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 purge of a trashed root removes its stale live work state", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const queue = new LiveWorkQueue(fixture.database);
  try {
    fixture.store.moveRootsToTrash([fixture.root]);
    seedState(queue, fixture.root);
    assert.equal(fixture.store.purgeTrashRoots([fixture.root]), 1);
    assertRootStateCleared(queue, fixture.root);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 workbench complete index preserves current root live work state", async () => {
  const fixture = await setup({ "seed.txt": "seed" });
  const queue = new LiveWorkQueue(fixture.database);
  let handle: WorkbenchHandle | undefined;
  try {
    seedState(queue, fixture.root);
    const beforeItems = queue.list(fixture.root);
    const beforeState = queue.reconcileStatus(fixture.root);
    const beforeSeen = queue.reconcileSeenPaths(fixture.root, beforeState!.generation);
    handle = await createWorkbench({
      databasePath: fixture.database,
      token: "m62-token",
      secret: Buffer.alloc(32, 4),
      environment: {},
      tempParent: fixture.temp,
      indexHold: async () => {},
    });
    const origin = handle.url.split("/#")[0]!;
    const response = await fetch(origin + "/api/index", {
      method: "POST",
      headers: { "X-LocalDocSearch-Token": "m62-token", origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 202);
    await handle.waitForIndex();
    const status = await fetch(origin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": "m62-token" } });
    assert.equal((await status.json() as { indexing: { state: string } }).indexing.state, "complete");
    assert.deepEqual(queue.list(fixture.root), beforeItems);
    assert.deepEqual(queue.reconcileStatus(fixture.root), beforeState);
    assert.deepEqual(queue.reconcileSeenPaths(fixture.root, beforeState!.generation), beforeSeen);
  } finally {
    await handle?.close();
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("0.43.0 root lifecycle succeeds when work-state cleanup is busy", async () => {
  const trashFixture = await setup({ "seed.txt": "seed" });
  const trashQueue = new LiveWorkQueue(trashFixture.database);
  let trashBlocker: DatabaseSync | undefined;
  try {
    seedState(trashQueue, trashFixture.root);
    trashBlocker = holdWorkStateWriteLock(trashFixture.database);
    assert.equal(trashFixture.store.moveRootsToTrash([trashFixture.root]).length, 1);
    assert.deepEqual(trashFixture.store.roots(), []);
  } finally {
    trashBlocker?.exec("ROLLBACK");
    trashBlocker?.close();
    const logs = runStartupCleanup(trashFixture.store, trashQueue);
    assertRootStateCleared(trashQueue, trashFixture.root);
    assert.equal(logs.some(line => line.includes("根 1；work_items 2；reconcile_state 1；reconcile_seen 1")), true);
    trashQueue.close();
    trashFixture.store.close();
    await rm(trashFixture.temp, { recursive: true, force: true });
  }

  const removeFixture = await setup({ "seed.txt": "seed" });
  const removeQueue = new LiveWorkQueue(removeFixture.database);
  let removeBlocker: DatabaseSync | undefined;
  try {
    seedState(removeQueue, removeFixture.root);
    removeBlocker = holdWorkStateWriteLock(removeFixture.database);
    assert.equal(removeFixture.store.removeRoot(removeFixture.root), 1);
    assert.deepEqual(removeFixture.store.roots(), []);
  } finally {
    removeBlocker?.exec("ROLLBACK");
    removeBlocker?.close();
    runStartupCleanup(removeFixture.store, removeQueue);
    assertRootStateCleared(removeQueue, removeFixture.root);
    removeQueue.close();
    removeFixture.store.close();
    await rm(removeFixture.temp, { recursive: true, force: true });
  }

  const mergeFixture = await setup({ "seed.txt": "seed" });
  const mergeQueue = new LiveWorkQueue(mergeFixture.database);
  const parent = path.join(mergeFixture.temp, "parent");
  let mergeBlocker: DatabaseSync | undefined;
  try {
    seedState(mergeQueue, mergeFixture.root);
    mergeBlocker = holdWorkStateWriteLock(mergeFixture.database);
    assert.deepEqual(mergeFixture.store.mergeChildRoots(parent, [mergeFixture.root]), { transferred: 1 });
    assert.deepEqual(mergeFixture.store.roots(), [parent]);
  } finally {
    mergeBlocker?.exec("ROLLBACK");
    mergeBlocker?.close();
    runStartupCleanup(mergeFixture.store, mergeQueue);
    assertRootStateCleared(mergeQueue, mergeFixture.root);
    mergeQueue.close();
    mergeFixture.store.close();
    await rm(mergeFixture.temp, { recursive: true, force: true });
  }

  const purgeFixture = await setup({ "seed.txt": "seed" });
  const purgeQueue = new LiveWorkQueue(purgeFixture.database);
  let purgeBlocker: DatabaseSync | undefined;
  try {
    purgeFixture.store.moveRootsToTrash([purgeFixture.root]);
    seedState(purgeQueue, purgeFixture.root);
    purgeBlocker = holdWorkStateWriteLock(purgeFixture.database);
    assert.equal(purgeFixture.store.purgeTrashRoots([purgeFixture.root]), 1);
    assert.deepEqual(purgeFixture.store.roots(), []);
  } finally {
    purgeBlocker?.exec("ROLLBACK");
    purgeBlocker?.close();
    runStartupCleanup(purgeFixture.store, purgeQueue);
    assertRootStateCleared(purgeQueue, purgeFixture.root);
    purgeQueue.close();
    purgeFixture.store.close();
    await rm(purgeFixture.temp, { recursive: true, force: true });
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
