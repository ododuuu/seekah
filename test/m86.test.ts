import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { IndexStore } from "../src/store.js";
import { parseDocument } from "../src/parser.js";
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

async function makeFixture(): Promise<{ temp: string; root: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m86-overlap-"));
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "seed.txt"), "m86-seed");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  return { temp, root: store.roots()[0]!, store };
}

async function startSession(
  store: IndexStore,
  parse: (filePath: string) => Promise<DocumentRecord>,
  sleep: (ms: number) => Promise<void>,
): Promise<Session> {
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
    watch: syntheticWatch(emitters),
    parse,
    sleep,
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

test("M86 starts the next file stability wait while the previous file is parsed", async () => {
  const fixture = await makeFixture();
  const previousDataDir = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = path.join(fixture.temp, "data");
  const firstParseStarted = deferred();
  const releaseFirstParse = deferred();
  const releaseSecondWait = deferred();
  let sleepCalls = 0;
  let secondWaitStarted = false;
  let blockedFirstParse = false;
  const parse = async (filePath: string) => {
    if (!blockedFirstParse) {
      blockedFirstParse = true;
      firstParseStarted.resolve();
      await releaseFirstParse.promise;
    }
    return parseDocument(filePath);
  };
  const sleep = async () => {
    sleepCalls++;
    if (sleepCalls === 2) {
      secondWaitStarted = true;
      await releaseSecondWait.promise;
    }
  };
  const session = await startSession(fixture.store, parse, sleep);
  try {
    await writeFile(path.join(fixture.root, "a.txt"), "m86-a-needle");
    await writeFile(path.join(fixture.root, "b.txt"), "m86-b-needle");
    const watcher = [...session.emitters.values()][0];
    assert.ok(watcher, `watchers=${[...session.emitters.keys()].join("|")} root=${fixture.root}`);
    watcher.emit("change", "rename", "a.txt");
    watcher.emit("change", "rename", "b.txt");
    fireDebounce(session);

    await firstParseStarted.promise;
    assert.equal(sleepCalls, 2);
    assert.equal(secondWaitStarted, true, "the second file must already be in its stability wait");
    releaseFirstParse.resolve();
    releaseSecondWait.resolve();
    await waitUntil(() => search(fixture.store, "m86-a-needle").length === 1 && search(fixture.store, "m86-b-needle").length === 1);
  } finally {
    releaseFirstParse.resolve();
    releaseSecondWait.resolve();
    session.stop.resolve();
    await session.running;
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = previousDataDir;
  }
});
