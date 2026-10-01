import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveWorkQueue } from "../src/live-queue.js";
import { applyFileUpdate, type LocalUpdateResult } from "../src/local-update.js";
import { LiveUpdateEngine, type LiveUpdateOptions } from "../src/live-update.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

const DEBOUNCE = 200;

type AppliedCall = { relPath: string; batch: number };

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("m65 局部批次測試未在期限內完成");
}

function fakeWatch(): typeof fs.watch {
  return (() => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => watcher.removeAllListeners();
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function fixture(prefix: string): Promise<{ temp: string; root: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(temp, "root");
  await mkdir(rootDir, { recursive: true });
  await writeFile(path.join(rootDir, "seed.txt"), "seed", "utf8");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(rootDir, store);
  return { temp, root: store.roots()[0]!, store };
}

async function startEngine(
  store: IndexStore,
  queue: LiveWorkQueue,
  extra: Partial<LiveUpdateOptions> = {},
): Promise<{
  engine: LiveUpdateEngine;
  stop: { resolve: (value?: void | PromiseLike<void>) => void };
  running: Promise<number>;
}> {
  const stop = deferred<void>();
  const ready = deferred<void>();
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

function resultFor(filePath: string, root: string, deferredResult: boolean): LocalUpdateResult {
  return {
    kind: deferredResult ? "unstable" : "file-upsert",
    path: filePath,
    root,
    updated: deferredResult ? 0 : 1,
    added: deferredResult ? 0 : 1,
    removed: 0,
    unchanged: 0,
    parserCalls: 0,
    complete: !deferredResult,
    deferred: deferredResult,
    diagnostics: [],
    notices: [],
  };
}

async function closeFixture(
  session: Awaited<ReturnType<typeof startEngine>>,
  queue: LiveWorkQueue,
  store: IndexStore,
  temp: string,
): Promise<void> {
  session.stop.resolve();
  await session.running;
  queue.close();
  store.close();
  await rm(temp, { recursive: true, force: true });
}

test("m65 1000 筆以上積壓時，新檔最多等待一個後續局部批次", { timeout: 60_000 }, async () => {
  const { temp, root, store } = await fixture("seekah-m65-newest-");
  await mkdir(path.join(root, "backlog"), { recursive: true });
  let clock = 0;
  const queue = new LiveWorkQueue(store.databasePath, { now: () => ++clock });
  const applied: AppliedCall[] = [];
  let batch = 0;
  let appliedInBatch = 0;
  for (let index = 0; index < 1_000; index++) {
    const relPath = path.join("backlog", `old-${String(index).padStart(4, "0")}.txt`);
    await writeFile(path.join(root, relPath), `old-${index}`, "utf8");
    queue.acceptPath(root, relPath);
  }
  const targetRelPath = "zz-new-target.txt";
  const target = path.join(root, targetRelPath);
  await writeFile(target, "m65-new-target", "utf8");
  queue.acceptPath(root, targetRelPath);

  const session = await startEngine(store, queue, {
    sleep: async ms => {
      assert.ok(ms > 0 && ms <= DEBOUNCE);
    },
    applyFileUpdate: async (filePath, updateRoot, updateStore, options) => {
      if (appliedInBatch === 0) batch++;
      applied.push({ relPath: path.relative(updateRoot, filePath), batch });
      appliedInBatch++;
      if (appliedInBatch === 500) appliedInBatch = 0;
      if (filePath === target) return applyFileUpdate(filePath, updateRoot, updateStore, options);
      return resultFor(filePath, updateRoot, false);
    },
  });
  try {
    await waitUntil(() => queue.pendingCount() === 0);
    const targetCall = applied.find(item => item.relPath === targetRelPath);
    assert.ok(targetCall, "新檔必須實際進入局部更新");
    assert.ok(targetCall.batch <= 2, `新檔不應等待超過兩批：${targetCall.batch}`);
    assert.equal(search(store, "m65-new-target").length, 1, "新檔內容必須可搜尋");
  } finally {
    await closeFixture(session, queue, store, temp);
  }
});

test("m65 持續新增事件時，舊積壓仍在有限輪內完成", { timeout: 60_000 }, async () => {
  const { temp, root, store } = await fixture("seekah-m65-old-fairness-");
  await mkdir(path.join(root, "backlog"), { recursive: true });
  await mkdir(path.join(root, "fresh"), { recursive: true });
  let clock = 0;
  const queue = new LiveWorkQueue(store.databasePath, { now: () => ++clock });
  const applied: AppliedCall[] = [];
  let batch = 0;
  let appliedInBatch = 0;
  for (let index = 0; index < 800; index++) {
    const relPath = path.join("backlog", `old-${String(index).padStart(4, "0")}.txt`);
    await writeFile(path.join(root, relPath), `old-${index}`, "utf8");
    queue.acceptPath(root, relPath);
  }

  const session = await startEngine(store, queue, {
    sleep: async ms => {
      assert.ok(ms > 0 && ms <= DEBOUNCE);
    },
    applyFileUpdate: async (filePath, updateRoot) => {
      if (appliedInBatch === 0) {
        batch++;
        if (batch <= 2) {
          const base = (batch - 1) * 600;
          for (let index = 0; index < 600; index++) {
            const relPath = path.join("fresh", `event-${String(base + index).padStart(4, "0")}.txt`);
            await writeFile(path.join(root, relPath), `fresh-${base + index}`, "utf8");
            queue.acceptPath(root, relPath);
          }
        }
      }
      applied.push({ relPath: path.relative(updateRoot, filePath), batch });
      appliedInBatch++;
      if (appliedInBatch === 500) appliedInBatch = 0;
      return resultFor(filePath, updateRoot, false);
    },
  });
  try {
    await waitUntil(() => queue.pendingCount() === 0);
    const oldMiddle = applied.find(item => item.relPath === path.join("backlog", "old-0400.txt"));
    assert.ok(oldMiddle, "舊積壓檔案必須被處理");
    assert.ok(oldMiddle.batch <= 2, `持續新增事件不可讓舊檔餓死：${oldMiddle.batch}`);
    assert.ok(batch >= 3, "測試期間必須確實產生持續新增事件的後續批次");
    assert.ok(applied.some(item => item.relPath.startsWith(`fresh${path.sep}`)), "新增事件必須也有進度");
  } finally {
    await closeFixture(session, queue, store, temp);
  }
});

test("m65 剛 defer 的噪音積壓不會佔滿下一批而阻塞穩定檔案", { timeout: 60_000 }, async () => {
  const { temp, root, store } = await fixture("seekah-m65-noise-");
  await mkdir(path.join(root, "noise"), { recursive: true });
  await mkdir(path.join(root, "stable"), { recursive: true });
  let clock = 0;
  const queue = new LiveWorkQueue(store.databasePath, { now: () => ++clock });
  const applied: AppliedCall[] = [];
  const noiseAttempts = new Map<string, number>();
  let batch = 0;
  let appliedInBatch = 0;
  for (let index = 0; index < 1_000; index++) {
    const relPath = path.join("noise", `n-${String(index).padStart(4, "0")}.txt`);
    await writeFile(path.join(root, relPath), `noise-${index}`, "utf8");
    queue.acceptPath(root, relPath);
  }
  const stableRelPath = path.join("stable", "after-noise.txt");
  const session = await startEngine(store, queue, {
    sleep: async ms => {
      assert.ok(ms > 0 && ms <= DEBOUNCE);
    },
    applyFileUpdate: async (filePath, updateRoot) => {
      if (appliedInBatch === 0) {
        batch++;
        if (batch === 1) {
          await writeFile(path.join(root, stableRelPath), "stable-after-noise", "utf8");
          queue.acceptPath(root, stableRelPath);
        }
      }
      const relPath = path.relative(updateRoot, filePath);
      applied.push({ relPath, batch });
      appliedInBatch++;
      if (appliedInBatch === 500) appliedInBatch = 0;
      if (relPath.startsWith(`noise${path.sep}`)) {
        const attempts = (noiseAttempts.get(relPath) ?? 0) + 1;
        noiseAttempts.set(relPath, attempts);
        return resultFor(filePath, updateRoot, attempts === 1);
      }
      return resultFor(filePath, updateRoot, false);
    },
  });
  try {
    await waitUntil(() => queue.pendingCount() === 0);
    const stableCall = applied.find(item => item.relPath === stableRelPath);
    assert.ok(stableCall, "穩定檔案必須實際進入局部更新");
    assert.equal(stableCall.batch, 2, `穩定檔案應在 defer 後的下一批處理：${stableCall.batch}`);
    const secondBatchCalls = applied.filter(item => item.batch === 2);
    assert.ok(secondBatchCalls.some(item => item.relPath === stableRelPath),
      "第二批必須已有穩定檔案進度，不可再次被噪音檔填滿");
    assert.ok(noiseAttempts.size >= 500, "噪音檔仍須依既有 defer 流程持續收斂");
  } finally {
    await closeFixture(session, queue, store, temp);
  }
});
