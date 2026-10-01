import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatLiveStatus } from "../src/autoupdate.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { IndexStore } from "../src/store.js";
import { search } from "../src/search.js";
import { sync } from "../src/sync.js";

type Deferred = { promise: Promise<void>; resolve: () => void };
type FakeTimer = { id: number; ms: number; fn: () => void };
type FakeWatcher = EventEmitter & { close(): void };

type Session = {
  engine: LiveUpdateEngine;
  running: Promise<number>;
  stop: Deferred;
  timers: FakeTimer[];
  emitters: Map<string, FakeWatcher>;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("timed out");
}

function syntheticWatch(emitters: Map<string, FakeWatcher>): typeof fs.watch {
  return ((watchPath: fs.PathLike, options: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
    const callback = (typeof options === "function" ? options : listener) as (event: fs.WatchEventType, filename: string | null) => void;
    const watcher = new EventEmitter() as FakeWatcher;
    const directory = String(watchPath);
    watcher.close = () => {
      if (emitters.get(directory) === watcher) emitters.delete(directory);
      watcher.removeAllListeners();
    };
    watcher.on("change", (event, filename) => callback(event as fs.WatchEventType, filename as string | null));
    emitters.set(directory, watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function makeFixture(prefix: string): Promise<{ temp: string; root: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "seed.txt"), "m85-seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  return { temp, root: store.roots()[0]!, store };
}

async function startSynthetic(store: IndexStore): Promise<Session> {
  const emitters = new Map<string, FakeWatcher>();
  const timers: FakeTimer[] = [];
  let timerId = 0;
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [store.roots()[0]!], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    sleep: async () => {},
    watch: syntheticWatch(emitters),
    setTimer: (fn, ms) => {
      const timer = { id: ++timerId, ms, fn };
      timers.push(timer);
      return timer.id as unknown as NodeJS.Timeout;
    },
    clearTimer: id => {
      const index = timers.findIndex(timer => timer.id === (id as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await ready.promise;
  return { engine, running, stop, timers, emitters };
}

function fireDebounce(session: Session): void {
  const timer = session.timers.find(item => item.ms === 200);
  assert.ok(timer, `missing debounce timer: ${session.timers.map(item => item.ms).join(",")}`);
  session.timers.splice(session.timers.indexOf(timer), 1);
  timer.fn();
}

async function stopSession(session: Session, store: IndexStore, temp: string): Promise<void> {
  session.stop.resolve();
  await session.running;
  store.close();
  await rm(temp, { recursive: true, force: true });
}

test("M85 synthetic watcher records event, stability, enumeration, lock and commit phases", async () => {
  const fixture = await makeFixture("seekah-m85-synthetic-");
  const previousDataDir = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = path.join(fixture.temp, "data");
  const session = await startSynthetic(fixture.store);
  try {
    const created = path.join(fixture.root, "synthetic-new.txt");
    await writeFile(created, "m85-synthetic-needle");
    session.emitters.get(fixture.root)!.emit("change", "rename", "synthetic-new.txt");
    fireDebounce(session);
    await waitUntil(() => search(fixture.store, "m85-synthetic-needle").length === 1);

    const snapshot = session.engine.snapshot();
    const timing = snapshot.roots[0]?.lastTiming;
    assert.ok(timing);
    assert.equal(typeof timing.at, "string");
    assert.equal(typeof timing.eventToScheduleMs, "number");
    assert.equal(typeof timing.stableWaitMs, "number");
    assert.equal(typeof timing.enumerateMs, "number");
    assert.equal(typeof timing.lockMs, "number");
    assert.equal(typeof timing.commitMs, "number");
    assert.match(formatLiveStatus(snapshot), /計時=事件→排程/u);
  } finally {
    await stopSession(session, fixture.store, fixture.temp);
    if (previousDataDir === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = previousDataDir;
  }
});

test("M85 real fs.watch records a searchable new-file update", async () => {
  const fixture = await makeFixture("seekah-m85-fs-watch-");
  const previousDataDir = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = path.join(fixture.temp, "data");
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(fixture.store, [fixture.root], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    watch: fs.watch,
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  try {
    await ready.promise;
    await writeFile(path.join(fixture.root, "real-watch.txt"), "m85-real-fs-watch-needle");
    await waitUntil(() => search(fixture.store, "m85-real-fs-watch-needle").length === 1, 15_000);
    const snapshot = engine.snapshot();
    assert.ok(snapshot.eventCount >= 1);
    assert.ok(snapshot.roots[0]?.lastTiming);
  } finally {
    stop.resolve();
    await running;
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = previousDataDir;
  }
});
