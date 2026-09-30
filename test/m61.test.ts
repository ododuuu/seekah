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

type FakeTimer = {
  id: number;
  ms: number;
  dueAt: number;
  fn: () => void;
};

type FakeScheduler = {
  timers: FakeTimer[];
  now: { value: number };
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (id: ReturnType<typeof setTimeout>) => void;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("公平輪替測試未在期限內完成");
}

function fakeScheduler(now: { value: number }): FakeScheduler {
  const timers: FakeTimer[] = [];
  let nextId = 0;
  return {
    timers,
    now,
    setTimer: (fn, ms) => {
      const timer = { id: ++nextId, ms, dueAt: now.value + ms, fn };
      timers.push(timer);
      return timer.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: id => {
      const index = timers.findIndex(timer => timer.id === (id as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
  };
}

function fakeWatch(
  onWatch: (emitter: EventEmitter) => void,
): typeof fs.watch {
  return ((watchPath: fs.PathLike, options: unknown, listener?: (event: fs.WatchEventType, filename: string | Buffer | null) => void) => {
    const callback = (typeof options === "function" ? options : listener) as (event: fs.WatchEventType, filename: string | Buffer | null) => void;
    const emitter = new EventEmitter();
    const watcher = emitter as EventEmitter & { close(): void };
    watcher.close = () => { emitter.removeAllListeners(); };
    emitter.on("change", filename => callback("change", filename));
    onWatch(emitter);
    return watcher as unknown as fs.FSWatcher;
  }) as typeof fs.watch;
}

async function fairnessFixture(): Promise<{
  temp: string;
  root: string;
  store: IndexStore;
  queue: LiveWorkQueue;
  target: string;
  token: string;
}> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m61-fairness-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  for (let index = 0; index < 8; index++) {
    await writeFile(path.join(root, `a${String(index).padStart(3, "0")}.txt`), `seed-${index}`, "utf8");
  }
  const target = path.join(root, "z-target.txt");
  await writeFile(target, "old-target", "utf8");
  const store = new IndexStore(database);
  await sync(root, store);
  const token = `fairness-target-${Date.now()}-m61`;
  await writeFile(target, token, "utf8");
  const queue = new LiveWorkQueue(database);
  queue.markDirtyScope(root, "m61-fairness");
  queue.acceptPath(root, "z-target.txt", "event");
  queue.acceptPath(root, "a001.txt", "event");
  queue.acceptPath(root, "a002.txt", "event");
  return { temp, root: store.roots()[0]!, store, queue, target, token };
}

async function fireWorkTimer(
  scheduler: FakeScheduler,
  logs: string[],
): Promise<void> {
  const index = scheduler.timers.findIndex(timer => timer.dueAt <= scheduler.now.value && timer.ms <= 5_000);
  assert.notEqual(index, -1, "每 15 秒應有一個可執行的 root timer");
  const timer = scheduler.timers.splice(index, 1)[0]!;
  const before = logs.length;
  timer.fn();
  await waitUntil(() => logs.length > before);
}

test("m61 background fairness alternates local work after reconcile under continuous events", { timeout: 15_000 }, async () => {
  const fixture = await fairnessFixture();
  const now = { value: 0 };
  const scheduler = fakeScheduler(now);
  const ready = deferred<void>();
  const stop = deferred<void>();
  const logs: string[] = [];
  let emitter: EventEmitter | undefined;
  let running: Promise<number> | undefined;
  try {
    const engine = new LiveUpdateEngine(fixture.store, [fixture.root], {
      mode: "background",
      debounceMs: 1_500,
      reconcileMs: 900_000,
      syncNow: false,
      watch: fakeWatch(value => { emitter = value; ready.resolve(); }),
      workQueue: fixture.queue,
      reconcileBatchEntries: 1,
      reconcileBatchMs: 60_000,
      now: () => now.value,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      sleep: async () => {
        for (let index = 0; index < 3; index++) emitter?.emit("change", null);
      },
    }, {
      write: text => logs.push(text),
      waitForStop: () => stop.promise,
    });
    running = engine.run();
    await ready.promise;
    await waitUntil(() => logs.some(line => line.startsWith("背景校正：")));

    const first = engine.snapshot().roots[0]?.reconcile;
    assert.ok(first, "第一輪必須保留未完成校正狀態");
    const firstChecked = first.checked;
    const firstFrontier = first.frontierCount;

    await new Promise<void>(resolve => setImmediate(resolve));
    emitter?.emit("change", null);
    assert.ok(scheduler.timers.some(timer => timer.dueAt <= now.value),
      "local 優先 timer 建立後，後續事件不可重新延後該輪");

    now.value = 15_000;
    await fireWorkTimer(scheduler, logs);
    assert.ok(engine.snapshot().localUpdateCount > 0, "校正批次後下一輪必須進入 local branch");
    assert.ok((await search(fixture.store, fixture.token)).some(item => item.path === fixture.target), "事件目標必須可搜尋");

    now.value = 30_000;
    await fireWorkTimer(scheduler, logs);
    const second = engine.snapshot().roots[0]?.reconcile;
    assert.ok(second, "持續事件期間校正狀態必須保留");
    assert.ok(second.checked > firstChecked || second.frontierCount < firstFrontier,
      "local 更新不能餓死校正進度");
  } finally {
    stop.resolve();
    if (running) await running.catch(() => undefined);
    fixture.queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

// 這個 smoke 故意使用真實 timer；它驗證 Node timer 與低 debounce 的實際整合，不以猜測 sleep 取代條件等待。
test("m61 background fairness smoke uses real timer and a low debounce", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m61-timer-"));
  const rootDir = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(rootDir, { recursive: true });
  const target = path.join(rootDir, "timer-target.txt");
  await writeFile(target, "timer-old", "utf8");
  const store = new IndexStore(database);
  let running: Promise<number> | undefined;
  const stop = deferred<void>();
  const ready = deferred<void>();
  let emitter: EventEmitter | undefined;
  try {
    await sync(rootDir, store);
    const token = `timer-target-${Date.now()}-m61`;
    await writeFile(target, token, "utf8");
    const engine = new LiveUpdateEngine(store, [store.roots()[0]!], {
      mode: "background",
      debounceMs: 200,
      reconcileMs: 900_000,
      syncNow: false,
      watch: fakeWatch(value => { emitter = value; ready.resolve(); }),
    }, {
      write: () => undefined,
      waitForStop: () => stop.promise,
    });
    running = engine.run();
    await ready.promise;
    const started = Date.now();
    emitter?.emit("change", "timer-target.txt");
    await waitUntil(() => engine.snapshot().localUpdateCount > 0
      && search(store, token).some(item => item.path === target), 5_000);
    assert.ok(Date.now() - started < 3_000, "低 debounce 的真實 timer smoke 應快速完成");
  } finally {
    stop.resolve();
    if (running) await running.catch(() => undefined);
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
