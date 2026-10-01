import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { lstat as realLstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type fs from "node:fs";
import { spawnSync } from "node:child_process";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { applyFileUpdate } from "../src/local-update.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { formatLiveStatus } from "../src/autoupdate.js";
import { buildHelpText } from "../src/cli.js";

const cli = path.resolve("dist/src/cli.js");

type FakeTimer = { id: number; ms: number; fn: () => void };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return Date.now() - started;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("timed out waiting for condition");
}

async function driveImmediate(timers: FakeTimer[], check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out driving immediate timers");
    const next = timers.find(item => item.ms === 0);
    if (next) {
      timers.splice(timers.indexOf(next), 1);
      next.fn();
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

test("0.37.0 CLI presents index as full reconcile and autoupdate as the daily path", () => {
  const help = buildHelpText();
  assert.match(help, /立即完整校正/u);
  assert.match(help, /日常變更/u);
  assert.match(help, /enumerate／stat／parse／compress／bloom／write／commit/u);
  const status = formatLiveStatus({
    schemaVersion: 1, instanceId: "i", pid: 1, mode: "background",
    startedAt: "t0", lastHeartbeatAt: "t1", phase: "idle",
    settings: { debounceMs: 1500, reconcileMs: 21_600_000 },
    ready: true, roots: [], pendingCount: 0,
    eventCount: 4, localUpdateCount: 3, rootScanCount: 1, subtreeScanCount: 0,
    queuePendingCount: 2, queueDegraded: false,
    recentErrors: [],
    nextReconcileAt: "t2",
  });
  assert.match(status, /基線：事件 4；局部更新 3；根目錄掃描 1；子樹掃描 0/u);
  assert.match(status, /工作佇列：待辦 2；正常/u);
  assert.match(status, /下次完整校正：t2/u);
});

test("0.37.0 full reconcile profile records enumerate and later stages", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-profile-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  for (let index = 0; index < 8; index++) await writeFile(path.join(root, `f${index}.txt`), `body-${index}-needle`);
  const store = new IndexStore(path.join(temp, "index.db"));
  const phases: Array<Record<string, number>> = [];
  try {
    for (let round = 0; round < 3; round++) {
      const report = await sync(root, store);
      phases.push(report.phasesMs);
      assert.ok((report.phasesMs.enumerate ?? -1) >= 0);
      assert.ok((report.phasesMs.stat ?? -1) >= 0);
      if (round === 0) {
        assert.ok((report.phasesMs.parse ?? 0) > 0);
        assert.ok((report.phasesMs.compress ?? 0) + (report.phasesMs.bloom ?? 0) + (report.phasesMs.write ?? 0) + (report.phasesMs.commit ?? 0) > 0);
      }
    }
    assert.equal(phases.length, 3);
    assert.ok((phases[1]?.enumerate ?? -1) >= 0);
    assert.equal(phases[1]?.parse ?? 0, 0);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 file updates wait for two matching metadata observations across stableMs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-stable-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  const file = path.join(root, "live.txt");
  await writeFile(file, "first-stable");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(root, store);
  const sleeps: number[] = [];
  let n = 0;
  try {
    const result = await applyFileUpdate(file, store.roots()[0]!, store, {
      stableMs: 200,
      sleep: async ms => { sleeps.push(ms); },
      lstat: (async target => {
        n++;
        const info = await realLstat(target);
        if (n === 2) {
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { size: info.size + 1 });
        }
        return info;
      }) as typeof realLstat,
    });
    assert.equal(result.kind, "file-upsert");
    assert.ok(sleeps.includes(200));
    assert.ok(n >= 4);
    assert.equal(search(store, "first-stable").length, 1);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 twenty file add/modify/delete events stay local with 15s search delay and zero root scans", {
  timeout: 30000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-events-"));
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
    sleep: async () => {},
    watch: ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
      const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
      watcher.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
      return watcher;
    }) as unknown as typeof fs.watch,
    sync: async (rootPath, indexStore, syncOptions) => sync(rootPath, indexStore, syncOptions),
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
  const delays: number[] = [];
  try {
    await ready.promise;
    const fire = () => {
      const debounce = [...timers].reverse().find(item => item.ms === 200);
      assert.ok(debounce);
      debounce.fn();
    };
    const visible = async (check: () => boolean) => {
      const delay = await waitUntil(() => check() && engine.snapshot().phase === "idle");
      delays.push(delay);
    };
    for (let round = 0; round < 20; round++) {
      const name = `e${round}.txt`;
      const abs = path.join(root, name);
      const added = `add-needle-${round}`;
      await writeFile(abs, added);
      watcher.emit("change", "change", name);
      fire();
      await visible(() => search(store, added).length === 1);

      const modified = `mod-needle-${round}`;
      await writeFile(abs, modified);
      watcher.emit("change", "change", name);
      fire();
      await visible(() => search(store, modified).length === 1);

      await rm(abs);
      watcher.emit("change", "change", name);
      fire();
      await visible(() => search(store, modified).length === 0);
    }
    const snap = engine.snapshot();
    assert.equal(snap.rootScanCount, 0);
    assert.equal(snap.localUpdateCount, 60);
    assert.equal(snap.eventCount, 60);
    assert.equal(delays.length, 60);
    assert.ok(delays.every(ms => ms < 15_000));
    assert.equal(search(store, "seed").length, 1);
  } finally {
    stop.resolve();
    await running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 unknown watcher filename still reconciles the registered root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-overflow-"));
  const root = path.join(temp, "docs");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "keep");
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
    watcher.emit("change", "change", null);
    const debounce = timers.find(item => item.ms === 200);
    assert.ok(debounce);
    debounce.fn();
    await driveImmediate(timers, () => engine.snapshot().rootScanCount >= 1);
  } finally {
    stop.resolve();
    await running;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 index --profile on a resolved path writes enumerate phase keys", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-cli-profile-"));
  const root = path.join(temp, "docs");
  const dataDir = path.join(temp, "data");
  const profile = path.join(temp, "anon.json");
  await mkdir(root);
  await mkdir(dataDir);
  await writeFile(path.join(root, "a.txt"), "profile-stage-needle");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  try {
    const run = spawnSync(process.execPath, [cli, "index", root, "--profile", profile], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    const body = JSON.parse(await readFile(profile, "utf8")) as { phasesMs: Record<string, number> };
    assert.ok((body.phasesMs.enumerate ?? -1) >= 0);
    assert.ok((body.phasesMs.stat ?? -1) >= 0);
    assert.ok((body.phasesMs.parse ?? 0) > 0);
    assert.doesNotMatch(await readFile(profile, "utf8"), /profile-stage-needle/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
