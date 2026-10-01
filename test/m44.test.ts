import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { acquireWriteLock, IndexBusyError } from "../src/write-lock.js";
import { LOCAL_BATCH_MAX_ITEMS, LiveUpdateEngine, type LiveUpdateOptions } from "../src/live-update.js";

// SPEC §54／§89：局部更新分批、每檔穩定觀察，並讓後續檔案等待與前一檔處理重疊。

const DEBOUNCE = 200;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

function fakeWatch(): typeof fs.watch {
  return (() => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => watcher.removeAllListeners();
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function fixture(prefix: string) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "home");
  await mkdir(path.join(root, "flood"), { recursive: true });
  await writeFile(path.join(root, "seed.txt"), "seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  return { temp, root: store.roots()[0]!, store };
}

async function startEngine(store: IndexStore, queue: LiveWorkQueue, extra: Partial<LiveUpdateOptions> = {}) {
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [store.roots()[0]!], {
    mode: "foreground",
    debounceMs: DEBOUNCE,
    reconcileMs: 0,
    syncNow: false,
    watch: fakeWatch(),
    workQueue: queue,
    ...extra,
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await ready.promise;
  return { engine, stop, running };
}

test("0.47 each queued file gets a stability wait while batch processing remains lock-free", async () => {
  const { temp, root, store } = await fixture("lds-m44-flood-");
  const count = 700;
  for (let index = 0; index < count; index++) {
    await writeFile(path.join(root, "flood", `p${index}.txt`), `plugin-${index}`);
  }
  await writeFile(path.join(root, "last.txt"), "flood-last-needle");
  const queue = new LiveWorkQueue(store.databasePath);
  for (let index = 0; index < count; index++) queue.acceptPath(root, path.join("flood", `p${index}.txt`));
  queue.acceptPath(root, "last.txt");
  const waits: number[] = [];
  let lockFreeBetweenBatches = 0;
  let lockBusyDuringWait = 0;
  const session = await startEngine(store, queue, {
    now: () => 0,
    sleep: async ms => {
      waits.push(ms);
      try { acquireWriteLock(store.databasePath)(); } catch (error) {
        if (error instanceof IndexBusyError) lockBusyDuringWait++;
        else throw error;
      }
    },
    setTimer: (fn, ms) => {
      if (ms === 0) {
        try { acquireWriteLock(store.databasePath)(); lockFreeBetweenBatches++; } catch { /* 另一輪背景工作 */ }
      }
      return setTimeout(fn, ms);
    },
  });
  try {
    await waitUntil(() => search(store, "flood-last-needle").length === 1);
    await waitUntil(() => queue.pendingCount() === 0);
    const batches = Math.ceil((count + 1) / LOCAL_BATCH_MAX_ITEMS);
    const stabilityWaits = waits.filter(ms => ms > 0 && ms <= DEBOUNCE).length;
    assert.ok(stabilityWaits >= count + 1, `每檔至少一次穩定等待：${stabilityWaits}; waits=${waits.length}:${waits.slice(0, 5).join(",")}`);
    assert.ok(waits.every(ms => ms > 0 && ms <= DEBOUNCE), "沒有原地退避");
    assert.equal(lockBusyDuringWait, 0, "穩定等待期間 writer lock 必須可取得");
    assert.ok(lockFreeBetweenBatches >= batches - 1, "輪與輪之間釋放 writer lock");
    assert.equal(search(store, "plugin-0").length, 1);
    assert.equal(search(store, `plugin-${count - 1}`).length, 1);
  } finally {
    session.stop.resolve();
    await session.running;
    queue.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.39.2 a file that keeps changing is deferred without blocking the rest, then given up", async () => {
  const { temp, root, store } = await fixture("lds-m44-churn-");
  const churn = path.join(root, "churn.txt");
  await writeFile(churn, "churn-initial");
  await writeFile(path.join(root, "calm.txt"), "calm-needle");
  const queue = new LiveWorkQueue(store.databasePath);
  queue.acceptPath(root, "churn.txt");
  queue.acceptPath(root, "calm.txt");
  let tick = 0;
  let waits = 0;
  const session = await startEngine(store, queue, {
    // 每次穩定等待期間都改寫 churn.txt，讓兩次觀察永遠不同。
    sleep: async () => {
      waits++;
      tick++;
      await writeFile(churn, `churn-${tick}`);
      const at = new Date(Date.now() + tick * 1000);
      await utimes(churn, at, at);
    },
  });
  try {
    await waitUntil(() => search(store, "calm-needle").length === 1);
    await waitUntil(() => queue.pendingCount() === 0);
    assert.ok(waits >= 2, "每個候選都必須進入自己的穩定等待");
    assert.equal(search(store, "churn-").length, 0, "不穩定的檔案保留既有索引（原本未索引）");
    assert.equal(session.engine.snapshot().recentErrors.length, 0);
  } finally {
    session.stop.resolve();
    await session.running;
    queue.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
