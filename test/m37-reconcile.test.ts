import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { applyFileUpdate } from "../src/local-update.js";
import { search } from "../src/search.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { runBackgroundReconcileBatch } from "../src/reconcile.js";
import type { LocalUpdateResult } from "../src/local-update.js";
import { LiveUpdateEngine } from "../src/live-update.js";
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(files: Record<string, string>): Promise<{ temp: string; root: string; database: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m37-reconcile-"));
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

async function closeFixture(fixture: { temp: string; store?: IndexStore; queue?: LiveWorkQueue }): Promise<void> {
  fixture.queue?.close();
  fixture.store?.close();
  await rm(fixture.temp, { recursive: true, force: true });
}

async function runUntilDone(root: string, store: IndexStore, queue: LiveWorkQueue, maxEntries = 2): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await runBackgroundReconcileBatch(root, store, queue, { maxEntries, maxMs: 60_000 });
    if (result.done) return;
  }
  throw new Error("校正未在測試期限內完成");
}

async function waitUntil(check: () => boolean, attempts = 1000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    const next = deferred<void>();
    setImmediate(() => next.resolve(undefined));
    await next.promise;
  }
  throw new Error("背景校正未在測試期限內完成");
}

function failedUpdate(filePath: string, root: string): LocalUpdateResult {
  return {
    kind: "unstable", path: filePath, root, updated: 0, added: 0, removed: 0, unchanged: 0,
    parserCalls: 0, complete: false, deferred: false,
    diagnostics: [{ stage: "read", path: filePath, code: "EACCES", message: "無法讀取文件，保留既有索引" }], notices: [],
  };
}

test("0.37.0 background reconciliation persists frontier and resumes after reopen", async () => {
  const fixture = await setup({
    "old.txt": "old",
    "a/one.txt": "one",
    "a/two.txt": "two",
    "b/three.txt": "three",
    "b/four.txt": "four",
    "c/five.txt": "five",
  });
  let queue = new LiveWorkQueue(fixture.database);
  await writeFile(path.join(fixture.root, "new.txt"), "new", "utf8");
  await rm(path.join(fixture.root, "old.txt"));
  const first = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, { maxEntries: 2, maxMs: 60_000 });
  assert.equal(first.done, false);
  assert.equal(queue.reconcileStatus(fixture.root)?.phase, "active");
  queue.close();
  fixture.store.close();
  queue = new LiveWorkQueue(fixture.database);
  fixture.store = new IndexStore(fixture.database);
  await runUntilDone(fixture.root, fixture.store, queue);
  const results = await search(fixture.store, "new");
  const oldResults = await search(fixture.store, "old");
  assert.equal(results.some(item => item.path.endsWith("new.txt")), true);
  assert.equal(oldResults.some(item => item.path.endsWith("old.txt")), false);
  assert.equal(queue.reconcileStatus(fixture.root)?.phase, "complete");
  await closeFixture({ temp: fixture.temp, store: fixture.store, queue });
});

test("0.37.0 each reconciliation batch releases the writer lock", async () => {
  const fixture = await setup({ "one.txt": "one", "two.txt": "two", "three.txt": "three" });
  const queue = new LiveWorkQueue(fixture.database);
  let acquired = 0;
  let released = 0;
  const acquireLock = () => {
    acquired++;
    return () => { released++; };
  };
  let result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
    maxEntries: 1, maxMs: 60_000, acquireLock,
  });
  while (!result.done) {
    result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 1, maxMs: 60_000, acquireLock,
    });
  }
  assert.equal(acquired >= 3, true);
  assert.equal(released, acquired);
  await closeFixture({ temp: fixture.temp, store: fixture.store, queue });
});

test("0.37.0 events arriving during reconciliation prevent unsafe deletion", async () => {
  const fixture = await setup({ "keep.txt": "keep", "gone.txt": "gone", "dir/file.txt": "file" });
  const queue = new LiveWorkQueue(fixture.database);
  const first = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, { maxEntries: 1, maxMs: 60_000 });
  assert.equal(first.done, false);
  await rm(path.join(fixture.root, "keep.txt"));
  const event = queue.acceptPath(fixture.root, "keep.txt");
  const blocked = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, { maxEntries: 500, maxMs: 60_000 });
  assert.equal(blocked.complete, false);
  const applied = await applyFileUpdate(path.join(fixture.root, "keep.txt"), fixture.root, fixture.store);
  assert.equal(applied.removed >= 1, true);
  queue.ack(fixture.root, event.relPath, event.generation);
  await runUntilDone(fixture.root, fixture.store, queue, 1);
  const state = queue.reconcileStatus(fixture.root);
  assert.equal(state?.phase, "complete");
  const keep = await search(fixture.store, "keep");
  assert.equal(keep.some(item => item.path.endsWith("keep.txt")), false);
  await closeFixture({ temp: fixture.temp, store: fixture.store, queue });
});

test("0.37.0 failed scopes retain indexed files and are visible in state", async () => {
  const fixture = await setup({ "broken.txt": "before", "removed.txt": "removed" });
  const queue = new LiveWorkQueue(fixture.database);
  await rm(path.join(fixture.root, "removed.txt"));
  const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
    maxEntries: 500,
    maxMs: 60_000,
    applyFileUpdate: async filePath => failedUpdate(filePath, fixture.root),
  });
  assert.equal(result.done, true);
  assert.equal(result.complete, false);
  assert.equal(result.failedScopes.some(item => item.endsWith("broken.txt")), true);
  const retained = await search(fixture.store, "removed");
  assert.equal(retained.some(item => item.path.endsWith("removed.txt")), true);
  assert.equal(queue.reconcileStatus(fixture.root)?.phase, "failed");
  await closeFixture({ temp: fixture.temp, store: fixture.store, queue });
});

test("0.37.0 background daemon runs reconciliation in resumable batches", async () => {
  const fixture = await setup({
    "old.txt": "old",
    "a/one.txt": "one",
    "b/two.txt": "two",
    "c/three.txt": "three",
  });
  const queue = new LiveWorkQueue(fixture.database);
  await writeFile(path.join(fixture.root, "new.txt"), "new", "utf8");
  await rm(path.join(fixture.root, "old.txt"));
  const stop = deferred<void>();
  const fakeWatch = (() => {
    const watcher = new EventEmitter() as fs.FSWatcher & { close(): void };
    watcher.close = () => undefined;
    return watcher;
  }) as typeof fs.watch;
  const engine = new LiveUpdateEngine(fixture.store, [fixture.root], {
    mode: "background",
    debounceMs: 200,
    reconcileMs: 900_000,
    syncNow: true,
    watch: fakeWatch,
    workQueue: queue,
    reconcileBatchEntries: 1,
    reconcileBatchMs: 60_000,
  }, {
    write: () => undefined,
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await waitUntil(() => search(fixture.store, "new").some(item => item.path.endsWith("new.txt"))
    && engine.snapshot().lastReconcile?.complete === true);
  stop.resolve();
  assert.equal(await running, 0);
  assert.equal(engine.snapshot().lastReconcile?.complete, true);
  assert.equal((await search(fixture.store, "old")).some(item => item.path.endsWith("old.txt")), false);
  queue.close();
  await closeFixture({ temp: fixture.temp, store: fixture.store });
});
