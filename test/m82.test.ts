import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type fsTypes from "node:fs";
import { autoupdateStartForWorkbench, autoupdateStop } from "../src/autoupdate.js";
import { formatLiveStatus } from "../src/autoupdate.js";
import { IndexStore } from "../src/store.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LiveUpdateEngine, MAX_UNCERTAIN_RESCAN_STATES_PER_ROOT } from "../src/live-update.js";
import { search } from "../src/search.js";
import { sync } from "../src/sync.js";
import { createWorkbench, type WorkbenchHandle } from "../src/workbench.js";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void };
type FakeTimer = { id: number; ms: number; fn: () => void };
type FakeWatcher = EventEmitter & { close(): void; recursive: boolean };

type SessionOptions = {
  failPaths?: Set<string>;
  now?: () => number;
  lstatSync?: typeof fs.lstatSync;
  watchHandleLimit?: number;
  uncertainRescanCooldownMs?: number;
  uncertainRescanWindowMs?: number;
  uncertainRescanMaxPerWindow?: number;
  uncertainRescanBackoffMs?: readonly number[];
  readdir?: (directory: fsTypes.PathLike) => Promise<fsTypes.Dirent[]>;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function nextTurn(): Promise<void> {
  const turn = deferred<void>();
  setImmediate(() => turn.resolve());
  return turn.promise;
}


async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await nextTurn();
  }
  throw new Error("timed out");
}

function isRecursiveOption(opts: unknown): boolean {
  if (typeof opts !== "object" || opts === null || !("recursive" in opts)) return false;
  return opts.recursive === true;
}

function fakeWatch(emitters: Map<string, FakeWatcher>, failPaths: Set<string>): typeof fs.watch {
  return ((watchPath: fsTypes.PathLike, opts: unknown, listener?: (event: fsTypes.WatchEventType, filename: string | null) => void) => {
    const dir = String(watchPath);
    if (failPaths.has(dir)) throw new Error(`attach denied: ${path.basename(dir)}`);
    const recursive = isRecursiveOption(opts);
    const callback = (typeof opts === "function" ? opts : listener) as (event: fsTypes.WatchEventType, filename: string | null) => void;
    const watcher = new EventEmitter() as FakeWatcher;
    watcher.recursive = recursive;
    watcher.close = () => {
      if (emitters.get(dir) === watcher) emitters.delete(dir);
      watcher.removeAllListeners();
    };
    watcher.on("change", (event, filename) => callback(event as fsTypes.WatchEventType, filename as string | null));
    emitters.set(dir, watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function startSession(store: IndexStore, extra: SessionOptions = {}): Promise<{
  engine: LiveUpdateEngine;
  emitters: Map<string, FakeWatcher>;
  timers: FakeTimer[];
  stop: Deferred<void>;
  running: Promise<number>;
  syncCalls: string[];
}> {
  const root = store.roots()[0]!;
  const emitters = new Map<string, FakeWatcher>();
  const failPaths = extra.failPaths ?? new Set<string>();
  const timers: FakeTimer[] = [];
  let timerId = 1;
  const ready = deferred();
  const stop = deferred();
  const syncCalls: string[] = [];
  const engine = new LiveUpdateEngine(store, [root], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    sleep: async () => {},
    watch: fakeWatch(emitters, failPaths),
    sync: async (rootPath, indexStore, options) => {
      syncCalls.push(rootPath);
      return sync(rootPath, indexStore, options);
    },
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.lstatSync ? { lstatSync: extra.lstatSync } : {}),
    ...(extra.watchHandleLimit !== undefined ? { watchHandleLimit: extra.watchHandleLimit } : {}),
    ...(extra.uncertainRescanCooldownMs !== undefined ? { uncertainRescanCooldownMs: extra.uncertainRescanCooldownMs } : {}),
    ...(extra.uncertainRescanWindowMs !== undefined ? { uncertainRescanWindowMs: extra.uncertainRescanWindowMs } : {}),
    ...(extra.uncertainRescanMaxPerWindow !== undefined ? { uncertainRescanMaxPerWindow: extra.uncertainRescanMaxPerWindow } : {}),
    ...(extra.uncertainRescanBackoffMs ? { uncertainRescanBackoffMs: extra.uncertainRescanBackoffMs } : {}),
    ...(extra.readdir ? { readdir: extra.readdir } : {}),
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

async function driveUntil(timers: FakeTimer[], check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    const next = timers.find(item => item.ms === 0 || item.ms === 200);
    if (next) {
      timers.splice(timers.indexOf(next), 1);
      next.fn();
    }
    await nextTurn();
  }
}

function fireDebounce(timers: FakeTimer[]): void {
  const timer = [...timers].reverse().find(item => item.ms === 200 || item.ms === 0);
  assert.ok(timer, `timers=${timers.map(item => item.ms).join(",")}`);
  timers.splice(timers.indexOf(timer), 1);
  timer.fn();
}

async function makeWatcherFixture(prefix: string): Promise<{ temp: string; root: string; alpha: string; beta: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "docs");
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  await mkdir(alpha, { recursive: true });
  await mkdir(beta);
  await writeFile(path.join(alpha, "a.txt"), "alpha-seed");
  await writeFile(path.join(beta, "b.txt"), "beta-seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  return { temp, root, alpha, beta, store };
}


async function closeSession(
  session: { stop: Deferred<void>; running: Promise<number> },
  store: IndexStore,
  temp: string,
): Promise<void> {
  session.stop.resolve();
  await session.running;
  store.close();
  await rm(temp, { recursive: true, force: true });
}
type IndexStatusPayload = {
  autoupdate: {
    live: {
      emptyFilenameEventCount: number;
      uncertainRescanCount: number;
      roots: Array<{ scopeMode?: string; handles?: number; degradedSubdirectories?: unknown[] }>;
    };
  };
};

function isIndexStatusPayload(value: unknown): value is IndexStatusPayload {
  if (typeof value !== "object" || value === null || !("autoupdate" in value)) return false;
  const autoupdate = value.autoupdate;
  if (typeof autoupdate !== "object" || autoupdate === null || !("live" in autoupdate)) return false;
  const live = autoupdate.live;
  return typeof live === "object" && live !== null
    && "emptyFilenameEventCount" in live
    && typeof live.emptyFilenameEventCount === "number"
    && "uncertainRescanCount" in live
    && typeof live.uncertainRescanCount === "number"
    && "roots" in live
    && Array.isArray(live.roots);
}


test("M82 child attach failure degrades only that child and preserves sibling split watcher", async () => {
  const fixture = await makeWatcherFixture("lds-m82-child-");
  const failPaths = new Set([fixture.alpha]);
  const session = await startSession(fixture.store, { failPaths });
  try {
    await waitUntil(() => (session.engine.snapshot().roots[0]?.degradedSubdirectories?.length ?? 0) === 1);
    const root = session.engine.snapshot().roots[0]!;
    assert.equal(root.scopeMode, "split");
    assert.equal(root.watch, "degraded");
    assert.equal(root.handles, 2);
    assert.deepEqual(root.degradedSubdirectories, [{ path: fixture.alpha, reason: "attach denied: alpha" }]);
    assert.equal(session.emitters.get(fixture.root)?.recursive, false);
    assert.equal(session.emitters.get(fixture.beta)?.recursive, true);
    assert.equal(session.emitters.has(fixture.alpha), false);

    await writeFile(path.join(fixture.beta, "b.txt"), "healthy-sibling-needle");
    session.emitters.get(fixture.beta)!.emit("change", "change", "b.txt");
    fireDebounce(session.timers);
    await driveUntil(session.timers, () => search(fixture.store, "healthy-sibling-needle").length === 1);
    assert.equal(session.engine.snapshot().roots[0]?.scopeMode, "split");
  } finally {
    await closeSession(session, fixture.store, fixture.temp);
  }
});

test("M82 runtime child watcher failure reattaches only that child without coarse fallback", async () => {
  const fixture = await makeWatcherFixture("lds-m82-runtime-");
  const failPaths = new Set<string>();
  const session = await startSession(fixture.store, { failPaths });
  try {
    const alphaWatcher = session.emitters.get(fixture.alpha)!;
    alphaWatcher.emit("change", "change", null);
    assert.equal(session.engine.snapshot().roots[0]?.uncertainRescanStateCount, 1);
    failPaths.add(fixture.alpha);
    alphaWatcher.emit("error", new Error("runtime denied"));
    await waitUntil(() => (session.engine.snapshot().roots[0]?.degradedSubdirectories?.length ?? 0) === 1);
    const root = session.engine.snapshot().roots[0]!;
    assert.equal(root.scopeMode, "split");
    assert.equal(root.handles, 2);
    assert.equal(session.emitters.get(fixture.beta)?.recursive, true);
    assert.deepEqual(root.degradedSubdirectories, [{ path: fixture.alpha, reason: "attach denied: alpha" }]);
    assert.equal(root.uncertainRescanStateCount, 0);
    assert.ok(session.engine.snapshot().recentErrors.some(error => error.includes("runtime denied")));
  } finally {
    await closeSession(session, fixture.store, fixture.temp);
  }
});


test("M82 handle limit still uses whole-root coarse fallback", async () => {
  const fixture = await makeWatcherFixture("lds-m82-limit-");
  const session = await startSession(fixture.store, { watchHandleLimit: 1 });
  try {
    const root = session.engine.snapshot().roots[0]!;
    assert.equal(root.scopeMode, "coarse");
    assert.equal(root.handles, 1);
    assert.equal(session.emitters.get(fixture.root)?.recursive, true);
    assert.deepEqual(root.degradedSubdirectories, []);
  } finally {
    await closeSession(session, fixture.store, fixture.temp);
  }
});


test("M82 empty filename uses watchDir expansion, cooldown, bounded window and status fields", async () => {
  const fixture = await makeWatcherFixture("lds-m82-unknown-");
  let clock = Date.now();
  let lstatCalls = 0;
  const session = await startSession(fixture.store, {
    now: () => clock,
    lstatSync: ((filePath: fsTypes.PathLike) => { lstatCalls++; return fs.lstatSync(filePath); }) as typeof fs.lstatSync,
    uncertainRescanCooldownMs: 100,
    uncertainRescanWindowMs: 1000,
    uncertainRescanMaxPerWindow: 2,
    uncertainRescanBackoffMs: [200, 400],
  });
  try {
    const target = path.join(fixture.alpha, "unknown-target.txt");
    await writeFile(target, "unknown-watch-dir-target");
    const alphaWatcher = session.emitters.get(fixture.alpha)!;
    const beforeUnknownLstat = lstatCalls;
    alphaWatcher.emit("change", "change", null);
    assert.equal(lstatCalls, beforeUnknownLstat);
    let snapshot = session.engine.snapshot();
    assert.equal(snapshot.emptyFilenameEventCount, 1);
    assert.equal(snapshot.uncertainRescanCount, 1);
    assert.equal(snapshot.roots[0]?.emptyFilenameEventCount, 1);
    assert.equal(snapshot.roots[0]?.uncertainRescanCount, 1);
    assert.ok(snapshot.lastUncertainRescanAt);
    assert.match(formatLiveStatus(snapshot), /不確定訊號：空檔名 1；補掃 1/u);

    fireDebounce(session.timers);
    await driveUntil(session.timers, () => search(fixture.store, "unknown-watch-dir-target").length === 1);
    snapshot = session.engine.snapshot();
    assert.equal(snapshot.rootScanCount, 0);
    assert.ok(snapshot.subtreeScanCount >= 1);
    assert.match(formatLiveStatus(snapshot), /範圍=split 句柄=3/u);

    // 同一 watchDir 的第二個訊號仍在冷卻內；事件可觀測，但不重複排入補掃。
    alphaWatcher.emit("change", "change", null);
    alphaWatcher.emit("change", "change", null);
    assert.equal(session.engine.snapshot().emptyFilenameEventCount, 3);
    assert.equal(session.engine.snapshot().uncertainRescanCount, 1);

    clock += 100;
    alphaWatcher.emit("change", "change", null);
    assert.equal(session.engine.snapshot().uncertainRescanCount, 2);
    clock += 1;
    alphaWatcher.emit("change", "change", null);
    assert.equal(session.engine.snapshot().uncertainRescanCount, 2);

    // 達到視窗上限後先進入退避；即使跨過視窗邊界，退避未到期也不得立刻補掃。
    clock += 799;
    alphaWatcher.emit("change", "change", null);
    snapshot = session.engine.snapshot();
    assert.equal(snapshot.emptyFilenameEventCount, 6);
    assert.equal(snapshot.uncertainRescanCount, 2);
    clock += 100;
    alphaWatcher.emit("change", "change", null);
    assert.equal(session.engine.snapshot().emptyFilenameEventCount, 7);
    assert.equal(session.engine.snapshot().uncertainRescanCount, 2);
    clock += 100;
    alphaWatcher.emit("change", "change", null);
    snapshot = session.engine.snapshot();
    assert.equal(snapshot.emptyFilenameEventCount, 8);
    assert.equal(snapshot.uncertainRescanCount, 3);
  } finally {
    await closeSession(session, fixture.store, fixture.temp);
  }
});

test("M82 root expansion work item coexists with durable dirty scope", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m82-queue-"));
  const databasePath = path.join(temp, "index.db");
  const root = path.join(temp, "docs");
  const queue = new LiveWorkQueue(databasePath);
  try {
    queue.markDirtyScope(root, "unknown-filename");
    const expansion = queue.acceptDirectory(root, "");
    assert.equal(expansion.kind, "path");
    assert.equal(expansion.relPath, "");
    const items = queue.list(root).map(item => ({ relPath: item.relPath, kind: item.kind })).sort((left, right) => left.relPath.localeCompare(right.relPath));
    assert.deepEqual(items.map(item => [item.relPath, item.kind]), [["", "path"], [".", "dirty-scope"]]);
    queue.ack(root, "", expansion.generation);
    assert.equal(queue.hasScope(root), true);
  } finally {
    queue.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("M82 uncertain watchDir state is bounded and clears when the root is removed", { timeout: 120_000 }, async () => {
  const fixture = await makeWatcherFixture("lds-m82-bounded-");
  const session = await startSession(fixture.store);
  const internals = session.engine as unknown as {
    states: Map<string, { pending: Set<string> }>;
    handleEvent(state: { pending: Set<string> }, filename: null, watchDir: string, eventType: fsTypes.WatchEventType): void;
    persistPath(state: unknown, abs: string, reason?: "event" | "expand"): boolean;
  };
  internals.persistPath = () => true;
  try {
    const state = internals.states.get(fixture.root);
    assert.ok(state);
    for (let index = 0; index < 5_000; index++) {
      internals.handleEvent.call(session.engine, state, null, path.join(fixture.root, `synthetic-${index}`), "rename");
      state.pending.clear();
    }
    const bounded = session.engine.snapshot();
    assert.equal(bounded.roots[0]?.uncertainRescanStateCount, MAX_UNCERTAIN_RESCAN_STATES_PER_ROOT);
    assert.equal(bounded.uncertainRescanStateCount, MAX_UNCERTAIN_RESCAN_STATES_PER_ROOT);

    fixture.store.removeRoot(fixture.root);
    session.engine.refreshRoots();
    const cleared = session.engine.snapshot();
    assert.equal(cleared.roots[0]?.uncertainRescanStateCount, 0);
    assert.equal(cleared.uncertainRescanStateCount, 0);
  } finally {
    await closeSession(session, fixture.store, fixture.temp);
  }
});

test("M82 unreadable uncertain expansion keeps existing indexed rows", async () => {
  const fixture = await makeWatcherFixture("lds-m82-unreadable-");
  const session = await startSession(fixture.store, {
    readdir: async directory => {
      if (path.resolve(String(directory)) === path.resolve(fixture.alpha)) {
        const error = new Error("temporary unreadable watchDir") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return fs.promises.readdir(String(directory), { withFileTypes: true });
    },
  });
  try {
    session.emitters.get(fixture.alpha)!.emit("change", "change", null);
    fireDebounce(session.timers);
    await driveUntil(session.timers, () => {
      const snapshot = session.engine.snapshot();
      return snapshot.subtreeScanCount >= 1 && snapshot.queuePendingCount === 0;
    });
    assert.equal(search(fixture.store, "alpha-seed").length, 1);
  } finally {
    await closeSession(session, fixture.store, fixture.temp);
  }
});


test("M82 index-status exposes live uncertainty fields through workbench", { timeout: 120_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m82-api-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "seed.txt"), "m82-api-seed");
  const seedStore = new IndexStore(databasePath);
  await sync(root, seedStore);
  seedStore.close();

  let handle: WorkbenchHandle | undefined;
  let daemonStarted = false;
  try {
    handle = await createWorkbench({ databasePath, token: "m82-token", secret: Buffer.alloc(32, 82), environment: {}, tempParent: temp });
    await handle.waitForIndex();
    await autoupdateStartForWorkbench(databasePath, {
      cliPath: path.resolve("dist/src/cli.js"),
      dataDir: path.join(temp, "data"),
      handshakeTimeoutMs: 20_000,
    });
    daemonStarted = true;
    const origin = handle.url.split("/#")[0]!;
    const response = await fetch(origin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": handle.token } });
    assert.equal(response.status, 200);
    const raw: unknown = await response.json();
    if (!isIndexStatusPayload(raw)) throw new Error("index-status autoupdate.live 欄位格式無效");
    const payload = raw;
    assert.equal(payload.autoupdate.live?.emptyFilenameEventCount, 0);
    assert.equal(payload.autoupdate.live?.uncertainRescanCount, 0);
    assert.equal(payload.autoupdate.live?.roots[0]?.scopeMode, "split");
    assert.equal(payload.autoupdate.live?.roots[0]?.degradedSubdirectories?.length, 0);
  } finally {
    if (daemonStarted) await autoupdateStop(databasePath, { stopWaitMs: 20_000 }).catch(() => undefined);
    await handle?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
