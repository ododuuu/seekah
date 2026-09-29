import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LOCAL_PREPARED_GROUP_MAX_MS, LiveUpdateEngine } from "../src/live-update.js";
import { WRITER_BACKOFF_MS, withWriterBackoff } from "../src/local-update.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { parseDocument } from "../src/parser.js";
import { sync } from "../src/sync.js";
import { acquireWriteLock, IndexBusyError } from "../src/write-lock.js";

type FakeTimer = { id: number; ms: number; fn: () => void };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeWatch(): typeof fs.watch {
  return (() => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => watcher.removeAllListeners();
    return watcher;
  }) as unknown as typeof fs.watch;
}

function sqliteBusyError(): Error {
  const error = new Error("injected SQLITE_BUSY");
  Object.defineProperty(error, "errcode", { value: 5 });
  return error;
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("m59 背景更新未在測試期限內完成");
}

test("m59: prepared 群組第 2 份 busy 時只 ack 第 1 份並釋放 writer lock", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m59-partial-group-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "seed.txt"), "seed", "utf8");
  const store = new IndexStore(database);
  const queue = new LiveWorkQueue(database, { now: (() => { let value = 0; return () => ++value; })() });
  const stop = deferred();
  let running: Promise<number> | undefined;
  const timers: FakeTimer[] = [];
  let timerId = 0;
  const logs: string[] = [];
  let busySeen = false;
  let blockSecond = true;
  let mainHolder: DatabaseSync | undefined;
  try {
    await sync(root, store);
    for (const [name, content] of [["a.txt", "m59-a"], ["b.txt", "m59-b"], ["c.txt", "m59-c"]] as const) {
      await writeFile(path.join(root, name), content, "utf8");
      queue.acceptPath(root, name, "event");
    }

    const originalUpsert = store.upsert.bind(store);
    let upsertCalls = 0;
    const attemptedPaths: string[] = [];
    const injectedUpsert = (...args: Parameters<IndexStore["upsert"]>): void => {
      attemptedPaths.push(args[0].path);
      upsertCalls++;
      if (blockSecond && upsertCalls >= 2) {
        mainHolder ??= new DatabaseSync(database);
        if (upsertCalls === 2) mainHolder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        throw sqliteBusyError();
      }
      return originalUpsert(...args);
    };
    Reflect.set(store, "upsert", injectedUpsert);
    let bPrepared = false;

    const engine = new LiveUpdateEngine(store, [root], {
      mode: "foreground",
      debounceMs: 200,
      reconcileMs: 0,
      syncNow: false,
      watch: fakeWatch(),
      parse: async filePath => {
        const parsed = await parseDocument(filePath);
        if (path.basename(filePath) === "b.txt") bPrepared = true;
        return parsed;
      },
      now: () => bPrepared ? LOCAL_PREPARED_GROUP_MAX_MS : 0,
      workQueue: queue,
      sleep: async ms => {
        if (ms >= WRITER_BACKOFF_MS[0]!) throw new Error("m59 detected unbounded prepared busy retry");
      },
      setTimer: (fn, ms) => {
        const timer = { id: ++timerId, ms, fn };
        timers.push(timer);
        return timer.id as unknown as NodeJS.Timeout;
      },
      clearTimer: id => {
        const index = timers.findIndex(item => item.id === (id as unknown as number));
        if (index >= 0) timers.splice(index, 1);
      },
      onLog: line => logs.push(line),
    }, {
      write: line => {
        logs.push(line);
        if (line.startsWith("INDEX_BUSY")) busySeen = true;
      },
      waitForStop: () => stop.promise,
    });
    running = engine.run();
    await waitUntil(() => logs.some(line => line.startsWith("監看中：")));
    (engine as unknown as { enqueueReady(root: string): void }).enqueueReady(root);
    const failed = () => logs.some(line => line.includes("LIVE_UPDATE_FAILED") || line.includes("監看同步失敗"));
    await waitUntil(() => busySeen || failed());
    assert.equal(failed(), false);
    assert.deepEqual([...new Set(attemptedPaths.map(filePath => path.relative(root, filePath)))].sort(), ["a.txt", "b.txt"]);
    assert.equal(search(store, "m59-a").length, 1, "第一輪成功的 a.txt 應已 ack");
    assert.equal(search(store, "m59-b").length, 0);
    assert.equal(search(store, "m59-c").length, 0);
    assert.deepEqual(queue.listPaths(root).map(item => item.relPath).sort(), ["b.txt", "c.txt"]);
    await waitUntil(() => timers.some(timer => timer.ms === WRITER_BACKOFF_MS[0]));

    const probeRelease = acquireWriteLock(database);
    probeRelease();
    if (!mainHolder) throw new Error("m59 應持有主庫 busy transaction");
    mainHolder.exec("ROLLBACK");
    mainHolder.close();
    mainHolder = undefined;
    blockSecond = false;
    const retry = timers.find(timer => timer.ms === WRITER_BACKOFF_MS[0]);
    assert.ok(retry, "busy 後應排程下一輪");
    retry.fn();
    await waitUntil(() => queue.listPaths(root).length === 0
      && search(store, "m59-a").length === 1
      && search(store, "m59-b").length === 1
      && search(store, "m59-c").length === 1);
    stop.resolve();
    assert.equal(await running, 0);
  } finally {
    stop.resolve();
    if (running) await running;
    if (mainHolder) {
      try { mainHolder.exec("ROLLBACK"); } catch { /* 測試可能已釋放 */ }
      mainHolder.close();
    }
    queue.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("m59: withWriterBackoff 用盡有限次數後回傳 INDEX_BUSY", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    withWriterBackoff("unused-index.db", {
      acquireLock: () => {
        attempts++;
        throw new IndexBusyError();
      },
      sleep: async ms => { delays.push(ms); },
    }, async () => {}),
    error => error instanceof IndexBusyError,
  );
  assert.equal(attempts, WRITER_BACKOFF_MS.length + 1);
  assert.deepEqual(delays, [...WRITER_BACKOFF_MS]);
});
