import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { LiveUpdateEngine, type LiveUpdateOptions } from "../src/live-update.js";

// SPEC §55：已在監看範圍內的資料夾 `change` 事件不觸發子樹掃描。

type FakeWatcher = EventEmitter & { close(): void; recursive: boolean };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

function fakeWatch(emitters: Map<string, FakeWatcher>): typeof fs.watch {
  return ((watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
    const dir = String(watchPath);
    const recursive = typeof opts === "object" && opts !== null && (opts as { recursive?: boolean }).recursive === true;
    const watcher = new EventEmitter() as FakeWatcher;
    watcher.recursive = recursive;
    watcher.close = () => { emitters.delete(dir); watcher.removeAllListeners(); };
    watcher.on("change", (event, filename) => listener!(event as fs.WatchEventType, filename as string | null));
    emitters.set(dir, watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function start(extra: Partial<LiveUpdateOptions> = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m45-"));
  const home = path.join(temp, "home");
  await mkdir(path.join(home, "tool", "deep"), { recursive: true });
  await writeFile(path.join(home, "tool", "deep", "old.txt"), "old");
  await writeFile(path.join(home, "note.txt"), "note");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(home, store);
  const root = store.roots()[0]!;
  const emitters = new Map<string, FakeWatcher>();
  const syncCalls: string[] = [];
  const stop = deferred();
  const ready = deferred();
  const engine = new LiveUpdateEngine(store, [root], {
    mode: "foreground", debounceMs: 200, reconcileMs: 0, syncNow: false, sleep: async () => {},
    watch: fakeWatch(emitters),
    sync: async (target, indexStore, options) => { syncCalls.push(target); return sync(target, indexStore, options); },
    ...extra,
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });
  const running = engine.run();
  await ready.promise;
  const close = async () => {
    stop.resolve();
    await running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  };
  return { engine, emitters, syncCalls, store, root, close };
}

test("0.39.3 directory change events inside watched scopes do not queue subtree scans", async () => {
  const session = await start();
  try {
    const { root, emitters, engine } = session;
    const tool = path.join(root, "tool");
    assert.equal(emitters.get(tool)?.recursive, true);
    await writeFile(path.join(tool, "deep", "fresh.txt"), "fresh-inner-needle");
    emitters.get(root)!.emit("change", "change", "tool");
    emitters.get(tool)!.emit("change", "change", "deep");
    let snap = engine.snapshot();
    assert.equal(snap.eventCount, 0);
    assert.equal(snap.queuePendingCount, 0);
    assert.equal(snap.pendingCount, 0);

    emitters.get(tool)!.emit("change", "rename", path.join("deep", "fresh.txt"));
    await waitUntil(() => search(session.store, "fresh-inner-needle").length === 1);
    snap = engine.snapshot();
    assert.equal(snap.eventCount, 1);
    assert.equal(snap.subtreeScanCount, 0);
    assert.deepEqual(session.syncCalls, []);
  } finally {
    await session.close();
  }
});

test("0.39.3 a directory moved in (rename) is still scanned as a subtree", async () => {
  const session = await start();
  try {
    const { root, emitters, engine } = session;
    const tool = path.join(root, "tool");
    const moved = path.join(tool, "moved");
    await mkdir(moved);
    await writeFile(path.join(moved, "inside.txt"), "moved-in-needle");
    emitters.get(tool)!.emit("change", "rename", "moved");
    await waitUntil(() => search(session.store, "moved-in-needle").length === 1);
    assert.equal(engine.snapshot().subtreeScanCount, 1);
    assert.deepEqual(session.syncCalls, [], "展開成逐檔待辦，不整棵同步（SPEC §56）");
  } finally {
    await session.close();
  }
});

test("0.39.3 coarse mode ignores directory change events too", async () => {
  const session = await start({ watchHandleLimit: 1 });
  try {
    const { root, emitters, engine } = session;
    assert.equal(engine.snapshot().roots[0]?.scopeMode, "coarse");
    emitters.get(root)!.emit("change", "change", "tool");
    emitters.get(root)!.emit("change", "change", path.join("tool", "deep"));
    const snap = engine.snapshot();
    assert.equal(snap.eventCount, 0);
    assert.equal(snap.queuePendingCount, 0);
  } finally {
    await session.close();
  }
});
