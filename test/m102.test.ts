import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveUpdateEngine } from "../src/live-update.js";
import type { LiveTimingSample } from "../src/autoupdate-control.js";
import { parseDocument } from "../src/parser.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

type Deferred = { promise: Promise<void>; resolve: () => void };
type ExpectedFiles = Map<string, string>;
type PressureResult = {
  scenario: string;
  expected: number;
  searchable: number;
  missing: number;
  stale: number;
  lossRate: number | null;
  eventCount: number;
  emptyFilenameEventCount: number;
  uncertainRescanCount: number;
  degradedSubdirectories: number;
  watcherErrorCodes: Record<string, number>;
  lastTiming?: LiveTimingSample;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error("M102 timed out waiting for searchable synthetic fixture");
}

function foundPath(token: string): string | undefined {
  return search(currentStore!, token)[0]?.path;
}

let currentStore: IndexStore | undefined;
function indexedAt(filePath: string): boolean {
  return currentStore?.getDocument(filePath)?.status === "indexed";
}

async function measureScenario(
  engine: LiveUpdateEngine,
  scenario: string,
  expected: ExpectedFiles,
  absent: readonly string[] = [],
  timeoutMs = 30_000,
): Promise<PressureResult> {
  await waitUntil(() => {
    const present = [...expected].every(([, filePath]) => indexedAt(filePath));
    const removed = absent.every(token => search(currentStore!, token).length === 0);
    return present && removed;
  }, timeoutMs);
  const searchable = [...expected].filter(([token, filePath]) => foundPath(token) === filePath).length;
  const missing = expected.size - searchable;
  const stale = absent.filter(token => search(currentStore!, token).length > 0).length;
  const snapshot = engine.snapshot();
  const root = snapshot.roots[0];
  const lastTiming = root?.lastTiming;
  const result = {
    scenario,
    expected: expected.size,
    searchable,
    missing,
    stale,
    lossRate: expected.size ? missing / expected.size : null,
    eventCount: snapshot.eventCount,
    emptyFilenameEventCount: snapshot.emptyFilenameEventCount ?? 0,
    uncertainRescanCount: snapshot.uncertainRescanCount ?? 0,
    degradedSubdirectories: root?.degradedSubdirectories?.length ?? 0,
    watcherErrorCodes: { ...(snapshot.watcherErrorCounts ?? {}) },
    ...(lastTiming ? { lastTiming: { ...lastTiming } } : {}),
  } satisfies PressureResult;
  assert.equal(missing, 0, `${scenario} lost ${missing}/${expected.size} synthetic files`);
  assert.equal(stale, 0, `${scenario} retained ${stale} deleted synthetic files`);
  return result;
}

test("M102 real fs.watch stress matrix records expected versus searchable synthetic files", { timeout: 180_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m102-watch-"));
  const dataDir = path.join(temp, "data");
  const root = path.join(temp, "docs");
  const outside = path.join(temp, "outside");
  const incomingSource = path.join(temp, "incoming-source");
  const incomingTarget = path.join(root, "incoming-batch");
  const movedOut = path.join(outside, "incoming-batch");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(incomingSource, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const deepDirectories: string[] = [];
  let deep = path.join(root, "deep-root");
  for (let level = 0; level < 6; level++) {
    deep = path.join(deep, `level-${level}-${"x".repeat(10)}`);
    deepDirectories.push(deep);
  }
  await mkdir(deep, { recursive: true });
  const longFile = path.join(deep, `long-name-${"y".repeat(22)}.txt`);
  assert.ok(longFile.length >= 180 && longFile.length < 260, `synthetic long path length=${longFile.length}`);
  const atomicFinal = path.join(root, "atomic.txt");
  const atomicOld = "m102-atomic-old";
  await writeFile(atomicFinal, atomicOld);

  const incomingTokens: string[] = [];
  for (let index = 0; index < 40; index++) {
    const token = `m102-move-${String(index).padStart(3, "0")}`;
    incomingTokens.push(token);
    await writeFile(path.join(incomingSource, `batch-${String(index).padStart(3, "0")}.txt`), token);
  }
  await writeFile(path.join(root, "seed.txt"), "m102-seed");

  const store = new IndexStore(path.join(temp, "index.db"));
  currentStore = store;
  await sync(root, store);
  const previousDataDir = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = dataDir;
  const stop = deferred();
  const ready = deferred();
  const expected: ExpectedFiles = new Map();
  const results: PressureResult[] = [];
  let running: Promise<number> | undefined;
  const engine = new LiveUpdateEngine(store, [store.roots()[0]!], {
    mode: "foreground",
    debounceMs: 200,
    reconcileMs: 0,
    syncNow: false,
    watch: fs.watch,
    parse: async filePath => {
      await new Promise<void>(resolve => setTimeout(resolve, 15));
      return parseDocument(filePath);
    },
  }, {
    write: text => { if (text.startsWith("監看中：")) ready.resolve(); },
    waitForStop: () => stop.promise,
  });

  try {
    running = engine.run();
    await ready.promise;

    const burst = new Map<string, string>();
    await Promise.all(Array.from({ length: 220 }, async (_, index) => {
      const token = `m102-burst-${String(index).padStart(3, "0")}`;
      const filePath = path.join(root, "burst", `file-${index}.txt`);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, token);
      burst.set(token, filePath);
    }));
    for (const [token, filePath] of burst) expected.set(token, filePath);
    results.push(await measureScenario(engine, "大量建立", burst));

    const mutate = new Map<string, string>();
    for (let index = 0; index < 20; index++) {
      const token = `m102-mutate-original-${String(index).padStart(2, "0")}`;
      const filePath = path.join(root, "mutate", `file-${index}.txt`);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, token);
      mutate.set(token, filePath);
      expected.set(token, filePath);
    }
    results.push(await measureScenario(engine, "建立後修改矩陣", mutate));

    const modifiedTokens: string[] = [];
    const modifiedExpected = new Map<string, string>();
    for (let index = 0; index < 10; index++) {
      const oldToken = `m102-mutate-original-${String(index).padStart(2, "0")}`;
      const newToken = `m102-mutate-modified-${String(index).padStart(2, "0")}`;
      const filePath = mutate.get(oldToken)!;
      await writeFile(filePath, newToken);
      modifiedTokens.push(oldToken);
      modifiedExpected.set(newToken, filePath);
      expected.delete(oldToken);
      expected.set(newToken, filePath);
    }
    results.push(await measureScenario(engine, "大量修改", modifiedExpected, modifiedTokens));

    const renamedExpected = new Map<string, string>();
    const renamedOldTokens: string[] = [];
    for (let index = 10; index < 15; index++) {
      const token = `m102-mutate-original-${String(index).padStart(2, "0")}`;
      const oldPath = mutate.get(token)!;
      const newPath = path.join(path.dirname(oldPath), `renamed-${index}.txt`);
      await rename(oldPath, newPath);
      renamedExpected.set(token, newPath);
      renamedOldTokens.push(token);
      expected.set(token, newPath);
    }
    results.push(await measureScenario(engine, "改名", renamedExpected, renamedOldTokens.map(token => `${token}-never`)));

    const movedExpected = new Map<string, string>();
    for (let index = 15; index < 20; index++) {
      const token = `m102-mutate-original-${String(index).padStart(2, "0")}`;
      const oldPath = mutate.get(token)!;
      const newPath = path.join(root, "mutate-moved", `moved-${index}.txt`);
      await mkdir(path.dirname(newPath), { recursive: true });
      await rename(oldPath, newPath);
      movedExpected.set(token, newPath);
      expected.set(token, newPath);
    }
    results.push(await measureScenario(engine, "單檔移動", movedExpected));

    const deletedTokens: string[] = [];
    for (let index = 0; index < 3; index++) {
      const token = `m102-mutate-original-${String(index).padStart(2, "0")}`;
      await rm(mutate.get(token)!, { force: true });
      expected.delete(token);
      deletedTokens.push(token);
    }
    results.push(await measureScenario(engine, "刪除", expected, deletedTokens));

    const deepToken = "m102-deep-long";
    await writeFile(longFile, deepToken);
    expected.set(deepToken, longFile);
    results.push(await measureScenario(engine, "深層與長路徑", new Map([[deepToken, longFile]])));

    const officeToken = "m102-office-final";
    const officeTemp = path.join(root, "office", "~$report.tmp");
    const officeFinal = path.join(root, "office", "report.txt");
    await mkdir(path.dirname(officeFinal), { recursive: true });
    await writeFile(officeTemp, "m102-office-temp");
    await rename(officeTemp, officeFinal);
    expected.set(officeToken, officeFinal);
    await writeFile(officeFinal, officeToken);
    results.push(await measureScenario(engine, "Office 暫存檔", new Map([[officeToken, officeFinal]])));

    const atomicToken = "m102-atomic-replace";
    const atomicTemp = path.join(root, "atomic.tmp");
    await writeFile(atomicTemp, atomicToken);
    await rename(atomicTemp, atomicFinal);
    expected.set(atomicToken, atomicFinal);
    results.push(await measureScenario(engine, "暫存後 rename 原子替換", new Map([[atomicToken, atomicFinal]]), [atomicOld]));

    const safeOld = "m102-safe-old";
    const safeNew = "m102-safe-new";
    const safeFinal = path.join(root, "editor.txt");
    const safeTemp = path.join(root, "editor.txt.tmp");
    await writeFile(safeFinal, safeOld);
    expected.set(safeOld, safeFinal);
    results.push(await measureScenario(engine, "safe-write 初始", new Map([[safeOld, safeFinal]])));
    await writeFile(safeTemp, safeNew);
    await rm(safeFinal, { force: true });
    await rename(safeTemp, safeFinal);
    expected.delete(safeOld);
    expected.set(safeNew, safeFinal);
    results.push(await measureScenario(engine, "編輯器 safe-write", new Map([[safeNew, safeFinal]]), [safeOld]));

    await rename(incomingSource, incomingTarget);
    const movedInExpected = new Map(incomingTokens.map(token => [token, path.join(incomingTarget, `batch-${token.slice("m102-move-".length)}.txt`)]));
    for (const [token, filePath] of movedInExpected) expected.set(token, filePath);
    results.push(await measureScenario(engine, "資料夾整批移入", movedInExpected));
    await rename(incomingTarget, movedOut);
    for (const token of incomingTokens) expected.delete(token);
    results.push(await measureScenario(engine, "資料夾整批移出", new Map(), incomingTokens));

    const busySeed = "m102-busy-seed";
    const busySeedPath = path.join(root, "busy-seed.txt");
    await writeFile(busySeedPath, busySeed);
    expected.set(busySeed, busySeedPath);
    await waitUntil(() => engine.snapshot().phase === "updating", 10_000);
    const busyExpected = new Map<string, string>([[busySeed, busySeedPath]]);
    await Promise.all(Array.from({ length: 80 }, async (_, index) => {
      const token = `m102-busy-${String(index).padStart(3, "0")}`;
      const filePath = path.join(root, "busy", `busy-${index}.txt`);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, token);
      busyExpected.set(token, filePath);
      expected.set(token, filePath);
    }));
    results.push(await measureScenario(engine, "局部更新忙碌時事件湧入", busyExpected, [], 60_000));

    const snapshot = engine.snapshot();
    const timingSampleMax = snapshot.roots.reduce((max, root) => Math.max(max, root.lastTimings?.length ?? (root.lastTiming ? 1 : 0)), 0);
    assert.ok(timingSampleMax <= 32, `timing samples must be bounded, got ${timingSampleMax}`);
    assert.ok(snapshot.eventCount >= 300, `expected a real fs.watch event burst, got ${snapshot.eventCount}`);
    assert.equal(snapshot.roots[0]?.degradedSubdirectories?.length ?? 0, 0);
    assert.equal(results.reduce((sum, item) => sum + item.missing, 0), 0);
    assert.equal(results.reduce((sum, item) => sum + item.stale, 0), 0);
    console.log(`M102_PRESSURE ${JSON.stringify({
      scenarios: results,
      totalExpected: results.reduce((sum, item) => sum + item.expected, 0),
      totalSearchable: results.reduce((sum, item) => sum + item.searchable, 0),
      totalMissing: results.reduce((sum, item) => sum + item.missing, 0),
      totalStale: results.reduce((sum, item) => sum + item.stale, 0),
      eventCount: snapshot.eventCount,
      emptyFilenameEventCount: snapshot.emptyFilenameEventCount,
      uncertainRescanCount: snapshot.uncertainRescanCount,
      degradedSubdirectories: snapshot.roots[0]?.degradedSubdirectories?.length ?? 0,
      timingSampleMax,
      lastTiming: snapshot.roots[0]?.lastTiming ? {
        eventToScheduleMs: snapshot.roots[0].lastTiming.eventToScheduleMs,
        eventToSearchMs: snapshot.roots[0].lastTiming.eventToSearchMs,
        stableWaitMs: snapshot.roots[0].lastTiming.stableWaitMs,
        enumerateMs: snapshot.roots[0].lastTiming.enumerateMs,
        lockMs: snapshot.roots[0].lastTiming.lockMs,
        commitMs: snapshot.roots[0].lastTiming.commitMs,
      } : null,
    })}`);
  } finally {
    stop.resolve();
    await running;
    store.close();
    currentStore = undefined;
    if (previousDataDir === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = previousDataDir;
    await rm(temp, { recursive: true, force: true });
  }
});
