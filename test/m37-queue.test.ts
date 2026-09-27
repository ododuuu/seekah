import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { isIndexArtifact, indexArtifactPaths } from "../src/store.js";
import { indexingStatePath } from "../src/indexing-state.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { LiveWorkQueue, QueuePersistError, workStatePath, DEFAULT_QUEUE_LIMIT } from "../src/live-queue.js";
import { LiveUpdateEngine, QUEUE_LIMIT } from "../src/live-update.js";

type FakeTimer = { id: number; ms: number; fn: () => void };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("timed out");
}

test("0.37.0 work queue persists before accept and acks by generation", () => {
  const temp = path.join(os.tmpdir(), `lds-m37-q-${process.pid}-${Date.now()}`);
  const db = path.join(temp, "index.db");
  const queue = new LiveWorkQueue(db);
  try {
    assert.equal(QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT);
    const first = queue.acceptPath("/docs", "a.txt");
    assert.equal(first.generation, 1);
    const second = queue.acceptPath("/docs", "a.txt");
    assert.equal(second.generation, 2);
    queue.ack("/docs", "a.txt", 1);
    const remaining = queue.listPaths("/docs");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.generation, 2);
    queue.ack("/docs", "a.txt", 2);
    assert.equal(queue.listPaths("/docs").length, 0);
  } finally {
    queue.close();
    void rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 crash before persist does not accept; after persist survives reopen", () => {
  const temp = path.join(os.tmpdir(), `lds-m37-qcrash-${process.pid}-${Date.now()}`);
  const db = path.join(temp, "index.db");
  let hookPhase: "before-commit" | "after-commit" | undefined = "before-commit";
  const failing = new LiveWorkQueue(db, {
    persistHook: (_op, phase) => {
      if (hookPhase && phase === hookPhase) throw new Error("injected crash");
    },
  });
  try {
    assert.throws(() => failing.acceptPath("/docs", "a.txt"), QueuePersistError);
  } finally {
    failing.close();
  }
  const reopenedEmpty = new LiveWorkQueue(db);
  try {
    assert.equal(reopenedEmpty.reopened, true);
    assert.equal(reopenedEmpty.list().length, 0);
  } finally {
    reopenedEmpty.close();
  }
  hookPhase = undefined;
  const ok = new LiveWorkQueue(db);
  try {
    ok.acceptPath("/docs", "a.txt");
  } finally {
    ok.close();
  }
  const replay = new LiveWorkQueue(db);
  try {
    assert.equal(replay.listPaths("/docs").length, 1);
    assert.equal(replay.listPaths("/docs")[0]?.generation, 1);
  } finally {
    replay.close();
    void rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 overflow persists dirty scope then drops path items", () => {
  const temp = path.join(os.tmpdir(), `lds-m37-qov-${process.pid}-${Date.now()}`);
  const db = path.join(temp, "index.db");
  const queue = new LiveWorkQueue(db, { limit: 2 });
  try {
    queue.acceptPath("/docs", "a.txt");
    queue.acceptPath("/docs", "b.txt");
    queue.acceptPath("/docs", "c.txt");
    assert.equal(queue.overflowIfNeeded("/docs"), true);
    assert.equal(queue.listPaths("/docs").length, 0);
    assert.equal(queue.hasScope("/docs"), true);
    assert.equal(queue.list("/docs").some(item => item.reason === "overflow"), true);
  } finally {
    queue.close();
    void rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 removed root work is isolated from a later root", () => {
  const temp = path.join(os.tmpdir(), `lds-m37-qiso-${process.pid}-${Date.now()}`);
  const db = path.join(temp, "index.db");
  const queue = new LiveWorkQueue(db);
  try {
    queue.acceptPath("/old", "a.txt");
    queue.acceptPath("/keep", "b.txt");
    queue.isolateRoot("/old");
    assert.equal(queue.listPaths("/old").length, 0);
    assert.equal(queue.listPaths("/keep").length, 1);
  } finally {
    queue.close();
    void rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 damaged work-state database fails visibly", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-qbad-"));
  const db = path.join(temp, "index.db");
  writeFileSync(workStatePath(db), "not-a-sqlite-database");
  assert.throws(() => new LiveWorkQueue(db), QueuePersistError);
  await rm(temp, { recursive: true, force: true });
});

test("0.37.0 work sqlite and workbench state sidecars are index artifacts", () => {
  const databasePath = path.join(os.tmpdir(), "index.db");
  const live = workStatePath(databasePath);
  const indexing = indexingStatePath(databasePath);
  assert.ok(indexArtifactPaths(databasePath).includes(live));
  assert.ok(indexArtifactPaths(databasePath).includes(indexing));
  assert.equal(isIndexArtifact(live, databasePath), true);
  assert.equal(isIndexArtifact(`${live}-wal`, databasePath), true);
  assert.equal(isIndexArtifact(indexing, databasePath), true);
  assert.equal(isIndexArtifact(`${indexing}.tmp`, databasePath), true);
});

test("0.37.0 engine persists file events and replays unacked work after reopen", {
  timeout: 20000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-qeng-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  await writeFile(path.join(root, "seed.txt"), "seed");
  const databasePath = path.join(temp, "index.db");
  const store = new IndexStore(databasePath);
  await sync(root, store);
  const registered = store.roots()[0]!;
  const target = path.join(root, "live.txt");
  await writeFile(target, "queued-needle");

  const runEngine = async (syncNow: boolean) => {
    const timers: FakeTimer[] = [];
    let timerId = 1;
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => {};
    const stop = deferred();
    const ready = deferred();
    const engine = new LiveUpdateEngine(store, [registered], {
      mode: "foreground",
      debounceMs: 200,
      reconcileMs: 0,
      syncNow,
      sleep: async () => {},
      watch: ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
        const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
        watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
        return watcher;
      }) as unknown as typeof fs.watch,
      setTimer: (fn, ms) => {
        const id = timerId++;
        timers.push({ id, ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: id => {
        const index = timers.findIndex(item => item.id === (id as unknown as number));
        if (index >= 0) timers.splice(index, 1);
      },
    }, {
      write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
      waitForStop: () => stop.promise,
    });
    const running = engine.run();
    await ready.promise;
    return { engine, watcher, timers, stop, running };
  };

  const first = await runEngine(false);
  try {
    first.watcher.emit("change", "change", "live.txt");
    assert.equal(first.engine.snapshot().queuePendingCount, 1);
    assert.equal(search(store, "queued-needle").length, 0);
  } finally {
    first.stop.resolve();
    await first.running;
  }

  const second = await runEngine(false);
  try {
    await waitUntil(() => search(store, "queued-needle").length === 1);
    assert.equal(search(store, "queued-needle").length, 1);
  } finally {
    second.stop.resolve();
    await second.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 persist failure degrades the watcher and does not drop health silently", {
  timeout: 15000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-qfail-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "keep");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const registered = store.roots()[0]!;
  const watcher = new EventEmitter() as EventEmitter & { close(): void };
  watcher.close = () => {};
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [registered], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    queuePersistHook: (op, phase) => {
      if (op === "upsert" && phase === "before-commit") throw new Error("disk full");
    },
    watch: ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
      const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
      watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
      return watcher;
    }) as unknown as typeof fs.watch,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: id => clearTimeout(id),
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  try {
    await ready.promise;
    watcher.emit("change", "change", "a.txt");
    const snap = engine.snapshot();
    assert.equal(snap.queueDegraded, true);
    assert.match(snap.recentErrors.join("；"), /QUEUE_PERSIST_FAILED/u);
    assert.equal(snap.roots[0]?.watch, "degraded");
  } finally {
    stop.resolve();
    await running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 engine overflow persists dirty scope instead of keeping 10001 path items", {
  timeout: 15000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-qoveng-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  await writeFile(path.join(root, "seed.txt"), "seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const registered = store.roots()[0]!;
  const timers: FakeTimer[] = [];
  let timerId = 1;
  const watcher = new EventEmitter() as EventEmitter & { close(): void };
  watcher.close = () => {};
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [registered], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    queueLimit: 2,
    sleep: async () => {},
    watch: ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
      const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
      watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
      return watcher;
    }) as unknown as typeof fs.watch,
    setTimer: (fn, ms) => {
      const id = timerId++;
      timers.push({ id, ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: id => {
      const index = timers.findIndex(item => item.id === (id as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  try {
    await ready.promise;
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(path.join(root, name), name);
      watcher.emit("change", "change", name);
    }
    const snap = engine.snapshot();
    assert.ok(snap.queuePendingCount <= 2);
    assert.equal(snap.roots[0]?.watch, "active");
    const debounce = [...timers].reverse().find(item => item.ms === 200);
    assert.ok(debounce);
    debounce.fn();
    await waitUntil(() => engine.snapshot().rootScanCount >= 1);
  } finally {
    stop.resolve();
    await running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
