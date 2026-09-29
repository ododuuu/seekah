import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import test from "node:test";
import { acquireWriteLock, IndexBusyError } from "../src/write-lock.js";
import * as localUpdate from "../src/local-update.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { parseDocument } from "../src/parser.js";
import { RootExclusion } from "../src/root-exclusion.js";
import type { LocalUpdateResult } from "../src/local-update.js";

const DEBOUNCE = 200;

type PreparedUpdate = { kind: string };
type PrepareOptions = {
  sleep?: (ms: number) => Promise<void>;
  deferUnstable?: boolean;
  signal?: AbortSignal;
  parse?: typeof parseDocument;
  acquireLock?: (databasePath: string) => () => void;
};
type PrepareFunction = (filePath: string, root: string, store: IndexStore, options: PrepareOptions) => Promise<PreparedUpdate>;
type CommitFunction = (prepared: PreparedUpdate, store: IndexStore, options: PrepareOptions) => Promise<LocalUpdateResult>;
type BatchCommitFunction = (prepared: readonly PreparedUpdate[], store: IndexStore, options: PrepareOptions) => Promise<LocalUpdateResult[]>;

function preparedFunctions(): { prepare: PrepareFunction; commit: CommitFunction; batchCommit: BatchCommitFunction } | undefined {
  const prepare = Reflect.get(localUpdate, "prepareFileUpdate");
  const commit = Reflect.get(localUpdate, "commitPreparedFileUpdate");
  const batchCommit = Reflect.get(localUpdate, "commitPreparedFileUpdates");
  if (typeof prepare !== "function" || typeof commit !== "function" || typeof batchCommit !== "function") return undefined;
  return {
    prepare: prepare as PrepareFunction,
    commit: commit as CommitFunction,
    batchCommit: batchCommit as BatchCommitFunction,
  };
}

type FakeTimer = { id: number; ms: number; fn: () => void };
type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
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

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("timed out");
}

async function fixture(prefix: string): Promise<{ temp: string; root: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "seed.txt"), "原始內容", "utf8");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  return { temp, root: store.roots()[0]!, store };
}

async function closeFixture(fixtureValue: { temp: string; store: IndexStore }): Promise<void> {
  fixtureValue.store.close();
  await rm(fixtureValue.temp, { recursive: true, force: true });
}

test("M52 writer lock stays available during batch stability wait", async () => {
  const fixtureValue = await fixture("seekah-m52-lock-free-wait-");
  const queue = new LiveWorkQueue(fixtureValue.store.databasePath);
  const stop = deferred();
  const ready = deferred();
  const waitDurations: number[] = [];
  let lockBusyDuringWait = 0;
  const timers: FakeTimer[] = [];
  let timerId = 0;
  const target = path.join(fixtureValue.root, "new.txt");
  await writeFile(target, "鎖外等待可搜尋", "utf8");
  queue.acceptPath(fixtureValue.root, "new.txt");
  const engine = new LiveUpdateEngine(fixtureValue.store, [fixtureValue.root], {
    mode: "foreground",
    debounceMs: DEBOUNCE,
    reconcileMs: 0,
    syncNow: false,
    watch: fakeWatch(),
    workQueue: queue,
    setTimer: (fn, ms) => {
      const id = ++timerId;
      timers.push({ id, ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: id => {
      const index = timers.findIndex(item => item.id === (id as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
    sleep: async ms => {
      waitDurations.push(ms);
      try {
        acquireWriteLock(fixtureValue.store.databasePath)();
      } catch (error) {
        if (error instanceof IndexBusyError) lockBusyDuringWait++;
        else throw error;
      }
    },
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  try {
    await ready.promise;
    await waitUntil(() => search(fixtureValue.store, "鎖外等待可搜尋").length === 1);
    assert.ok(waitDurations.includes(DEBOUNCE), "應執行一次批次穩定等待");
    assert.equal(lockBusyDuringWait, 0, "穩定等待期間不應持有 writer lock");
  } finally {
    stop.resolve();
    await running;
    queue.close();
    await closeFixture(fixtureValue);
  }
});

test("M52 one writer lock commits multiple prepared files", async () => {
  const fixtureValue = await fixture("seekah-m52-group-commit-");
  const firstPath = path.join(fixtureValue.root, "first.txt");
  const secondPath = path.join(fixtureValue.root, "second.txt");
  try {
    const functions = preparedFunctions();
    assert.ok(functions, "production prepared-update API must be available");
    if (!functions) return;
    await writeFile(firstPath, "群組提交第一份", "utf8");
    await writeFile(secondPath, "群組提交第二份", "utf8");
    const first = await functions.prepare(firstPath, fixtureValue.root, fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
    });
    const second = await functions.prepare(secondPath, fixtureValue.root, fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
    });
    assert.equal(first.kind, "file");
    assert.equal(second.kind, "file");
    let acquisitions = 0;
    const results = await functions.batchCommit([first, second], fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
      acquireLock: databasePath => {
        acquisitions++;
        return acquireWriteLock(databasePath);
      },
    });
    assert.equal(acquisitions, 1, "多份 prepared 文件應共用一次 writer lock");
    assert.deepEqual(results.map(result => result.updated), [1, 1]);
    assert.equal(search(fixtureValue.store, "群組提交第一份").length, 1);
    assert.equal(search(fixtureValue.store, "群組提交第二份").length, 1);
  } finally {
    await closeFixture(fixtureValue);
  }
});

test("M52 prepared path reuses one root exclusion for a multi-file batch", async () => {
  const fixtureValue = await fixture("seekah-m52-prepared-exclusion-");
  const ignoreFile = path.join(fixtureValue.root, ".localdocsearchignore");
  await writeFile(ignoreFile, "secret/\n", "utf8");
  const queue = new LiveWorkQueue(fixtureValue.store.databasePath);
  const stop = deferred();
  const ready = deferred();
  let loadCalls = 0;
  let asyncLoadCalls = 0;
  const originalLoad = RootExclusion.load;
  const originalLoadSync = RootExclusion.loadSync;
  RootExclusion.load = async (root, store) => {
    asyncLoadCalls++;
    return originalLoad(root, store);
  };
  RootExclusion.loadSync = (root, store) => {
    loadCalls++;
    return originalLoadSync(root, store);
  };
  let running: Promise<number> | undefined;
  try {
    const engine = new LiveUpdateEngine(fixtureValue.store, [fixtureValue.root], {
      mode: "foreground",
      debounceMs: DEBOUNCE,
      reconcileMs: 0,
      syncNow: false,
      watch: fakeWatch(),
      sleep: async () => {},
      workQueue: queue,
    }, {
      write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
      waitForStop: () => stop.promise,
    });
    running = engine.run();
    await ready.promise;
    loadCalls = 0;
    asyncLoadCalls = 0;
    const firstPath = path.join(fixtureValue.root, "first.txt");
    const secondPath = path.join(fixtureValue.root, "second.txt");
    await writeFile(firstPath, "prepared exclusion 第一份", "utf8");
    await writeFile(secondPath, "prepared exclusion 第二份", "utf8");
    queue.acceptPath(fixtureValue.root, "first.txt");
    queue.acceptPath(fixtureValue.root, "second.txt");
    (engine as unknown as { enqueueReady(root: string): void }).enqueueReady(fixtureValue.root);
    await waitUntil(() => search(fixtureValue.store, "prepared exclusion 第一份").length === 1
      && search(fixtureValue.store, "prepared exclusion 第二份").length === 1);
    assert.equal(loadCalls, 1, "一批正式 prepared 更新只應載入一次 RootExclusion");
    assert.equal(asyncLoadCalls, 0, "傳入 exclusion 時 prepare 不應逐檔 async load");
    assert.equal(queue.pendingCount(), 0);
    stop.resolve();
    await running;
    running = undefined;
  } finally {
    stop.resolve();
    if (running) await running;
    queue.close();
    RootExclusion.load = originalLoad;
    RootExclusion.loadSync = originalLoadSync;
    await closeFixture(fixtureValue);
  }
});

test("M52 prepared path keeps invalid ignore rules unacknowledged and retryable", async () => {
  const fixtureValue = await fixture("seekah-m52-prepared-ignore-error-");
  const ignoreFile = path.join(fixtureValue.root, ".localdocsearchignore");
  await writeFile(ignoreFile, "secret/\n", "utf8");
  const blockedPath = path.join(fixtureValue.root, "secret", "blocked.txt");
  const relativeBlockedPath = path.relative(fixtureValue.root, blockedPath);
  await mkdir(path.dirname(blockedPath), { recursive: true });
  const queue = new LiveWorkQueue(fixtureValue.store.databasePath);
  const stop = deferred();
  const ready = deferred();
  let running: Promise<number> | undefined;
  try {
    const engine = new LiveUpdateEngine(fixtureValue.store, [fixtureValue.root], {
      mode: "foreground",
      debounceMs: DEBOUNCE,
      reconcileMs: 0,
      syncNow: false,
      watch: fakeWatch(),
      sleep: async () => {},
      workQueue: queue,
    }, {
      write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
      waitForStop: () => stop.promise,
    });
    running = engine.run();
    await ready.promise;
    await writeFile(ignoreFile, "!\n", "utf8");
    await writeFile(blockedPath, "invalid ignore should not be indexed", "utf8");
    queue.acceptPath(fixtureValue.root, relativeBlockedPath);
    (engine as unknown as { enqueueReady(root: string): void }).enqueueReady(fixtureValue.root);
    await waitUntil(() => engine.snapshot().roots[0]?.watch === "offline");
    assert.equal(queue.pendingCount(), 1, "規則錯誤時不應 ack queued path");
    assert.equal(search(fixtureValue.store, "invalid ignore should not be indexed").length, 0);
    assert.equal(fixtureValue.store.getDocument(blockedPath), undefined);

    await writeFile(ignoreFile, "secret/\n", "utf8");
    queue.acceptPath(fixtureValue.root, relativeBlockedPath);
    (engine as unknown as { enqueueReady(root: string): void }).enqueueReady(fixtureValue.root);
    await waitUntil(() => queue.pendingCount() === 0);
    assert.equal(search(fixtureValue.store, "invalid ignore should not be indexed").length, 0);
    assert.equal(fixtureValue.store.getDocument(blockedPath), undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    stop.resolve();
    await running;
    running = undefined;
  } finally {
    stop.resolve();
    if (running) await running;
    queue.close();
    await closeFixture(fixtureValue);
  }
});

test("M52 metadata changes after preparation never commit stale parsed content", async () => {
  const fixtureValue = await fixture("seekah-m52-stale-commit-");
  const filePath = path.join(fixtureValue.root, "seed.txt");
  try {
    const functions = preparedFunctions();
    assert.ok(functions, "production prepared-update API must be available");
    if (!functions) return;
    await writeFile(filePath, "準備完成但即將過期", "utf8");
    const prepared = await functions.prepare(filePath, fixtureValue.root, fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
    });
    if (prepared.kind !== "file") throw new Error("expected a file preparation");
    await writeFile(filePath, "提交前已變更", "utf8");
    const result = await functions.commit(prepared, fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
    });
    assert.equal(result.deferred, true);
    assert.equal(search(fixtureValue.store, "準備完成但即將過期").length, 0);
    assert.equal(search(fixtureValue.store, "原始內容").length, 1);
  } finally {
    await closeFixture(fixtureValue);
  }
});

test("M52 deletion after preparation follows the existing safe-delete path", async () => {
  const fixtureValue = await fixture("seekah-m52-delete-after-prepare-");
  const filePath = path.join(fixtureValue.root, "seed.txt");
  try {
    const functions = preparedFunctions();
    assert.ok(functions, "production prepared-update API must be available");
    if (!functions) return;
    await writeFile(filePath, "準備後刪除", "utf8");
    const prepared = await functions.prepare(filePath, fixtureValue.root, fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
    });
    if (prepared.kind !== "file") throw new Error("expected a file preparation");
    await unlink(filePath);
    const result = await functions.commit(prepared, fixtureValue.store, {
      sleep: async () => {},
      deferUnstable: true,
    });
    assert.equal(result.removed, 1);
    assert.equal(search(fixtureValue.store, "原始內容").length, 0);
    assert.equal(fixtureValue.store.getDocument(filePath), undefined);
  } finally {
    await closeFixture(fixtureValue);
  }
});

test("M52 abort during lock-free preparation leaves the previous index intact", async () => {
  const fixtureValue = await fixture("seekah-m52-cancel-");
  const filePath = path.join(fixtureValue.root, "seed.txt");
  const started = deferred();
  const release = deferred();
  const controller = new AbortController();
  try {
    const functions = preparedFunctions();
    assert.ok(functions, "production prepared-update API must be available");
    if (!functions) return;
    await writeFile(filePath, "取消中的解析", "utf8");
    const preparing = functions.prepare(filePath, fixtureValue.root, fixtureValue.store, {
      signal: controller.signal,
      deferUnstable: true,
      sleep: async () => {},
      parse: async target => {
        started.resolve();
        await release.promise;
        return parseDocument(target);
      },
    });
    await started.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(preparing, { code: "OPERATION_CANCELLED" });
    assert.equal(search(fixtureValue.store, "原始內容").length, 1);
    assert.equal(search(fixtureValue.store, "取消中的解析").length, 0);
  } finally {
    await closeFixture(fixtureValue);
  }
});

test("M52 process stop aborts preparation without partial index writes", async () => {
  const fixtureValue = await fixture("seekah-m52-process-stop-");
  const filePath = path.join(fixtureValue.root, "seed.txt");
  const queue = new LiveWorkQueue(fixtureValue.store.databasePath);
  const stop = deferred();
  const ready = deferred();
  const started = deferred();
  const release = deferred();
  try {
    await writeFile(filePath, "停止中的解析", "utf8");
    queue.acceptPath(fixtureValue.root, "seed.txt");
    const engine = new LiveUpdateEngine(fixtureValue.store, [fixtureValue.root], {
      mode: "foreground",
      debounceMs: DEBOUNCE,
      reconcileMs: 0,
      syncNow: false,
      watch: fakeWatch(),
      workQueue: queue,
      sleep: async () => {},
      parse: async (target: string) => {
        started.resolve();
        await release.promise;
        return parseDocument(target);
      },
    } as unknown as ConstructorParameters<typeof LiveUpdateEngine>[2], {
      write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
      waitForStop: () => stop.promise,
    });
    const running = engine.run();
    await ready.promise;
    await started.promise;
    stop.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve();
    await running;
    assert.equal(queue.pendingCount(), 1, "停止時不得確認準備中的佇列項目");
    assert.equal(search(fixtureValue.store, "原始內容").length, 1);
    assert.equal(search(fixtureValue.store, "停止中的解析").length, 0);
  } finally {
    queue.close();
    await closeFixture(fixtureValue);
  }
});
