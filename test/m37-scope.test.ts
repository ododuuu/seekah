import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { DEFAULT_WATCH_HANDLE_LIMIT, LiveUpdateEngine } from "../src/live-update.js";
import { formatLiveStatus } from "../src/autoupdate.js";

type FakeTimer = { id: number; ms: number; fn: () => void };
type FakeWatcher = EventEmitter & { close(): void; recursive: boolean };

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

function fakeWatch(emitters: Map<string, FakeWatcher>): typeof fs.watch {
  return ((watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
    const dir = String(watchPath);
    const recursive = typeof opts === "object" && opts !== null && (opts as { recursive?: boolean }).recursive === true;
    const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
    const watcher = new EventEmitter() as FakeWatcher;
    watcher.recursive = recursive;
    watcher.close = () => { emitters.delete(dir); watcher.removeAllListeners(); };
    watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
    emitters.set(dir, watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function startEngine(
  store: IndexStore,
  extra: { watchHandleLimit?: number } = {},
): Promise<{
  engine: LiveUpdateEngine;
  emitters: Map<string, FakeWatcher>;
  timers: FakeTimer[];
  stop: ReturnType<typeof deferred>;
  running: Promise<number>;
  syncCalls: string[];
}> {
  const registered = store.roots()[0]!;
  const emitters = new Map<string, FakeWatcher>();
  const timers: FakeTimer[] = [];
  let timerId = 1;
  const syncCalls: string[] = [];
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [registered], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    sleep: async () => {},
    ...(extra.watchHandleLimit !== undefined ? { watchHandleLimit: extra.watchHandleLimit } : {}),
    watch: fakeWatch(emitters),
    sync: async (rootPath, indexStore, syncOptions) => {
      syncCalls.push(rootPath);
      return sync(rootPath, indexStore, syncOptions);
    },
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
  return { engine, emitters, timers, stop, running, syncCalls };
}

/** 反覆觸發防抖與立即接續（0 ms）的計時器，直到條件成立（SPEC §56 展開需多輪）。 */
async function driveUntil(timers: FakeTimer[], check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    const next = timers.find(item => item.ms === 0 || item.ms === 200);
    if (next) {
      timers.splice(timers.indexOf(next), 1);
      next.fn();
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

function fireDebounce(timers: FakeTimer[]): void {
  const debounce = [...timers].reverse().find(item => item.ms === 200);
  assert.ok(debounce);
  debounce.fn();
}

test("0.37.0 handle limit default is 128 and status shows scope mode", () => {
  assert.equal(DEFAULT_WATCH_HANDLE_LIMIT, 128);
  const status = formatLiveStatus({
    schemaVersion: 1, instanceId: "i", pid: 1, mode: "background",
    startedAt: "t0", lastHeartbeatAt: "t1", phase: "idle",
    settings: { debounceMs: 1500, reconcileMs: 21_600_000 },
    ready: true,
    roots: [{ path: "/docs", watch: "active", pending: 0, scopeMode: "split", handles: 3 }],
    pendingCount: 0, eventCount: 0, localUpdateCount: 0, rootScanCount: 0, subtreeScanCount: 0,
    queuePendingCount: 0, queueDegraded: false, recentErrors: [],
  });
  assert.match(status, /範圍=split 句柄=3/u);
});

test("0.37.0 split watches root non-recursively and each direct child recursively", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-split-"));
  const root = path.join(temp, "docs");
  const child = path.join(root, "chapter");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(root, "top.txt"), "top");
  await writeFile(path.join(child, "inner.txt"), "inner");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store);
  try {
    const snap = session.engine.snapshot();
    assert.equal(snap.roots[0]?.scopeMode, "split");
    assert.equal(snap.roots[0]?.handles, 2);
    assert.equal(session.emitters.get(store.roots()[0]!)?.recursive, false);
    assert.equal(session.emitters.get(child)?.recursive, true);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 unknown filename on sibling A only subtree-scans A", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-sib-"));
  const root = path.join(temp, "docs");
  const dirA = path.join(root, "alpha");
  const dirB = path.join(root, "beta");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB);
  await writeFile(path.join(dirA, "a.txt"), "alpha-orig");
  await writeFile(path.join(dirB, "b.txt"), "beta-orig");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store);
  try {
    await writeFile(path.join(dirA, "a.txt"), "alpha-unknown");
    session.emitters.get(dirA)!.emit("change", "change", null);
    fireDebounce(session.timers);
    await driveUntil(session.timers, () => search(store, "alpha-unknown").length === 1);
    assert.equal(session.engine.snapshot().rootScanCount, 0);
    assert.ok(session.engine.snapshot().subtreeScanCount >= 1);
    assert.ok(session.syncCalls.every(item => item !== store.roots()[0]));

    await writeFile(path.join(dirB, "b.txt"), "beta-local-needle");
    session.emitters.get(dirB)!.emit("change", "change", "b.txt");
    fireDebounce(session.timers);
    await waitUntil(() => search(store, "beta-local-needle").length === 1);
    assert.equal(session.engine.snapshot().rootScanCount, 0);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 new top-level directory is attached then scanned", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-newdir-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  await writeFile(path.join(root, "seed.txt"), "seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store);
  try {
    assert.equal(session.engine.snapshot().roots[0]?.handles, 1);
    const created = path.join(root, "fresh");
    await mkdir(created);
    await writeFile(path.join(created, "n.txt"), "new-dir-needle");
    const rootWatcher = session.emitters.get(store.roots()[0]!);
    assert.ok(rootWatcher);
    rootWatcher.emit("change", "change", "fresh");
    assert.equal(session.emitters.get(created)?.recursive, true);
    await driveUntil(session.timers, () => search(store, "new-dir-needle").length === 1);
    assert.equal(session.engine.snapshot().subtreeScanCount, 1);
    assert.equal(session.engine.snapshot().rootScanCount, 0);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 handle limit falls back to a coarse recursive root watcher", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-limit-"));
  const root = path.join(temp, "docs");
  await mkdir(path.join(root, "one"), { recursive: true });
  await mkdir(path.join(root, "two"));
  await writeFile(path.join(root, "one", "a.txt"), "one");
  await writeFile(path.join(root, "two", "b.txt"), "two");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store, { watchHandleLimit: 2 });
  try {
    const snap = session.engine.snapshot();
    assert.equal(snap.roots[0]?.scopeMode, "coarse");
    assert.equal(snap.roots[0]?.handles, 1);
    assert.equal(session.emitters.get(store.roots()[0]!)?.recursive, true);
    assert.equal(session.emitters.size, 1);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 directory symlink is not given its own watcher", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-link-"));
  const root = path.join(temp, "docs");
  const outside = path.join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside-needle");
  await writeFile(path.join(root, "seed.txt"), "seed");
  try {
    await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    await rm(temp, { recursive: true, force: true });
    return;
  }
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store);
  try {
    assert.equal(session.emitters.has(path.join(root, "link")), false);
    assert.equal(session.engine.snapshot().roots[0]?.scopeMode, "split");
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 unlocatable filename on the root watcher reconciles the whole root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-unk-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  await writeFile(path.join(root, "seed.txt"), "seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store);
  try {
    session.emitters.get(store.roots()[0]!)!.emit("change", "change", null);
    fireDebounce(session.timers);
    await driveUntil(session.timers, () => session.engine.snapshot().rootScanCount >= 1);
    assert.ok(session.syncCalls.includes(store.roots()[0]!));
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 error on child watcher keeps the sibling watcher", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-err-"));
  const root = path.join(temp, "docs");
  const dirA = path.join(root, "alpha");
  const dirB = path.join(root, "beta");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB);
  await writeFile(path.join(dirA, "a.txt"), "a");
  await writeFile(path.join(dirB, "b.txt"), "b");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const session = await startEngine(store);
  try {
    const watcherA = session.emitters.get(dirA);
    assert.ok(watcherA);
    watcherA.emit("error", new Error("alpha watch failed"));
    await writeFile(path.join(dirB, "b.txt"), "beta-after-error");
    const watcherB = session.emitters.get(dirB);
    assert.ok(watcherB);
    watcherB.emit("change", "change", "b.txt");
    fireDebounce(session.timers);
    await waitUntil(() => search(store, "beta-after-error").length === 1);
    assert.equal(session.engine.snapshot().roots[0]?.watch, "active");
    assert.equal(session.engine.snapshot().rootScanCount, 0);
  } finally {
    session.stop.resolve();
    await session.running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
