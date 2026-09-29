import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
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

type FakeTimer = { id: number; ms: number; fn: () => void };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("背景更新未在測試期限內完成");
}

function fakeWatch(): typeof fs.watch {
  return (() => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => watcher.removeAllListeners();
    return watcher;
  }) as unknown as typeof fs.watch;
}

test("m55: 背景更新遇主庫 SQLITE_BUSY 保留待辦並在下一輪完成", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m55-live-busy-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  const seed = path.join(root, "seed.txt");
  const added = path.join(root, "added.txt");
  await mkdir(root, { recursive: true });
  await writeFile(seed, "seed");

  const store = new IndexStore(database);
  const queue = new LiveWorkQueue(database);
  const stop = deferred();
  let holder: DatabaseSync | undefined;
  let running: Promise<number> | undefined;
  try {
    await sync(root, store);
    await writeFile(added, "live-busy-needle");
    queue.markDirtyScope(root, "m55");

    holder = new DatabaseSync(database);
    holder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");

    const timers: FakeTimer[] = [];
    let timerId = 0;
    const engine = new LiveUpdateEngine(store, [root], {
      mode: "background",
      debounceMs: 200,
      reconcileMs: 900_000,
      syncNow: false,
      watch: fakeWatch(),
      workQueue: queue,
      reconcileBatchEntries: 500,
      reconcileBatchMs: 60_000,
      setTimer: (fn, ms) => {
        const timer = { id: ++timerId, ms, fn };
        timers.push(timer);
        return timer.id as unknown as NodeJS.Timeout;
      },
      clearTimer: id => {
        const index = timers.findIndex(item => item.id === (id as unknown as number));
        if (index >= 0) timers.splice(index, 1);
      },
    }, {
      write: () => undefined,
      waitForStop: () => stop.promise,
    });

    running = engine.run();
    await waitUntil(() => timers.some(timer => timer.ms === 1_000));

    const blocked = engine.snapshot();
    assert.equal(blocked.recentErrors.some(error => error.startsWith("LIVE_UPDATE_FAILED")), false);
    assert.equal(JSON.stringify(blocked).includes("database is locked"), false);
    assert.equal(queue.hasScope(root), true, "主庫忙碌時校正待辦必須保留");
    assert.equal(blocked.roots[0]?.reconcile?.phase, "active");

    holder.exec("ROLLBACK");
    holder.close();
    holder = undefined;
    const retry = timers.find(timer => timer.ms === 1_000);
    assert.ok(retry, "應排程主庫 busy 重試");
    retry.fn();

    await waitUntil(() => search(store, "live-busy-needle").some(item => item.path === added)
      && !queue.hasScope(root)
      && engine.snapshot().lastReconcile?.complete === true);
    stop.resolve();
    assert.equal(await running, 0);
  } finally {
    stop.resolve();
    if (running) await running;
    if (holder) {
      try { holder.exec("ROLLBACK"); } catch { /* 交易可能已由 SQLite 回復 */ }
      holder.close();
    }
    queue.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
