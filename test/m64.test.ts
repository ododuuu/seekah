import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  explainExclusion,
  listDefaultExclusions,
  matchDefaultExclusion,
} from "../src/default-exclusions.js";
import { IgnoreConfigurationError } from "../src/ignore.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { applyFileDelete, applyFileUpdate } from "../src/local-update.js";
import { RootExclusion } from "../src/root-exclusion.js";
import { runtimePathPlatform } from "../src/root-plan.js";
import { runBackgroundReconcileBatch } from "../src/reconcile.js";
import { scan } from "../src/scanner.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { shouldIgnoreWatchPath } from "../src/watch-path.js";

const WIN32 = "win32" as const;
const VOLUME = "C:\\";

function defaultSource(root: string, relative: string, isDirectory = false): string {
  return matchDefaultExclusion(root, path.win32.join(root, relative), isDirectory, WIN32).source;
}

async function fixture(prefix: string): Promise<{ temp: string; root: string; database: string; store: IndexStore }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  return { temp, root, database, store: new IndexStore(database) };
}

function closeFixture(item: { temp: string; store: IndexStore }): Promise<void> {
  item.store.close();
  return rm(item.temp, { recursive: true, force: true });
}

test("M64 volume-root defaults are exact, non-UNC, and reversible by choosing a narrow root", () => {
  const rules = listDefaultExclusions(VOLUME, WIN32);
  assert.equal(rules.length, 12);
  assert.deepEqual(rules.map(rule => rule.id), [
    "builtin:.git", "builtin:node-modules", "builtin:localdocsearch", "builtin:office-temp",
    "builtin:$recycle-bin", "builtin:system-volume-information",
    "volume-default:windows", "volume-default:program-files", "volume-default:program-files-x86",
    "volume-default:program-data", "volume-default:users-profile-appdata", "volume-default:perflogs",
  ]);
  assert.deepEqual(listDefaultExclusions("C:", WIN32).map(rule => rule.id), rules.map(rule => rule.id));
  assert.equal(matchDefaultExclusion("c:", "c:\\WINDOWS\\System32\\x.txt", false, WIN32).source, "volume-default");
  assert.equal(matchDefaultExclusion(VOLUME, VOLUME, true, WIN32).source, "not-excluded");
  for (const rule of rules) {
    assert.ok(rule.pattern);
    assert.ok(rule.name);
    assert.ok(rule.reason);
    assert.ok(rule.warning);
  }

  for (const relative of [
    "Windows\\System32\\kernel.dll",
    "Program Files\\Seekah\\README.txt",
    "Program Files (x86)\\Legacy\\README.txt",
    "ProgramData\\Vendor\\report.txt",
    "Users\\Alice\\AppData\\Local\\cache.bin",
    "PerfLogs\\Admin\\trace.txt",
  ]) assert.equal(defaultSource(VOLUME, relative), "volume-default", relative);
  for (const relative of ["$Recycle.Bin\\S-1-5-21\\x.txt", "System Volume Information\\tracking.log"]) {
    assert.equal(defaultSource(VOLUME, relative), "builtin", relative);
  }
  for (const relative of [
    "Windows.old\\notes.txt",
    "Program Files2\\notes.txt",
    "PROGRA~1\\Seekah\\README.txt",
    "ProgramData-old\\notes.txt",
    "Users\\Alice\\AppData-old\\notes.txt",
    "User\\Alice\\AppData\\notes.txt",
    "Users\\Alice\\Documents\\notes.txt",
    "Windows",
  ]) assert.equal(defaultSource(VOLUME, relative), "not-excluded", relative);

  const nonVolume = "C:\\Users\\Alice";
  assert.equal(defaultSource(nonVolume, "AppData\\Local\\cache.bin"), "not-excluded");
  assert.equal(defaultSource(nonVolume, "Windows\\notes.txt"), "not-excluded");
  const unc = "\\\\server\\share";
  const uncRules = listDefaultExclusions(unc, WIN32);
  assert.equal(uncRules.some(rule => rule.source === "volume-default"), false);
  assert.equal(defaultSource(unc, "Windows\\notes.txt"), "not-excluded");
  assert.equal(defaultSource("/", "Windows/notes.txt"), "not-excluded");

  // 移除 C:\\ 後，直接把 C:\\Windows 作為窄根目錄，文件不再帶有 volume-default 規則。
  assert.equal(defaultSource("C:\\Windows", "notes.txt"), "not-excluded");
});
test("M64 coarse volume-default events are excluded before lstat", async () => {
  const item = await fixture("seekah-m64-fast-path-");
  const { root, store } = item;
  let queue: LiveWorkQueue | undefined;
  const originalLoadSync = RootExclusion.loadSync;
  let lstatCalls = 0;
  let callback: ((event: fs.WatchEventType, filename: string | Buffer | null) => void) | undefined;
  const loadSyncHost = RootExclusion as unknown as {
    loadSync: typeof RootExclusion.loadSync;
  };
  const fakeExclusion = {
    excludes(absPath: string, isDirectory: boolean | undefined, isLink = false): boolean {
      if (isLink) return true;
      const relative = path.relative(root, absPath).replaceAll(path.sep, "\\");
      const synthetic = path.win32.join(VOLUME, relative);
      return matchDefaultExclusion(VOLUME, synthetic, isDirectory, WIN32).excluded;
    },
  } as unknown as RootExclusion;
  try {
    await mkdir(path.join(root, "ordinary"), { recursive: true });
    await sync(root, store);
    loadSyncHost.loadSync = () => fakeExclusion;
    const watch = ((_: string, __: unknown, listener: (event: fs.WatchEventType, filename: string | Buffer | null) => void) => {
      callback = listener;
      const watcher = new EventEmitter() as fs.FSWatcher;
      watcher.close = () => {};
      return watcher;
    }) as unknown as typeof fs.watch;
    queue = new LiveWorkQueue(store.databasePath);
    const engine = new LiveUpdateEngine(store, [root], {
      mode: "foreground",
      syncNow: false,
      reconcileMs: 0,
      watch,
      watchHandleLimit: 1,
      workQueue: queue,
      lstatSync: ((target: fs.PathLike) => {
        lstatCalls++;
        return fs.lstatSync(target);
      }) as typeof fs.lstatSync,
    }, {
      write: () => {},
      waitForStop: async () => {
        while (!callback) await new Promise<void>(resolve => setImmediate(resolve));
        for (let index = 0; index < 50; index++) {
          callback("change", `Windows\\event-${index}.log`);
          callback("change", `Users\\Alice\\AppData\\event-${index}.log`);
        }
      },
    });
    await engine.run();
    const snapshot = engine.snapshot();
    assert.equal(snapshot.roots[0]?.scopeMode, "coarse");
    assert.equal(lstatCalls, 0);
    assert.equal(snapshot.excludedEventCount, 100);
    assert.equal(snapshot.eventCount, 0);
  } finally {
    loadSyncHost.loadSync = originalLoadSync;
    queue?.close();
    await closeFixture(item);
  }
});


test("M64 root-exclusion, scanner, watch-path, local-update and live-update share one decision", async () => {
  const item = await fixture("seekah-m64-parity-");
  const { root, store } = item;
  const skipped = path.join(root, "skip", "inside.txt");
  const builtIn = path.join(root, "node_modules", "inside.txt");
  const keep = path.join(root, "keep.txt");
  let queue: LiveWorkQueue | undefined;
  try {
    await mkdir(path.dirname(skipped), { recursive: true });
    await mkdir(path.dirname(builtIn), { recursive: true });
    await writeFile(skipped, "skip");
    await writeFile(builtIn, "skip");
    await writeFile(keep, "keep");
    await writeFile(path.join(root, ".localdocsearchignore"), "skip/\n");
    let linkPath: string | undefined;
    try {
      linkPath = path.join(root, "linked");
      await symlink(path.dirname(keep), linkPath, "junction");
    } catch {
      linkPath = undefined;
    }
    const exclusion = await RootExclusion.load(root, store);
    const userExplanation = exclusion.explain(skipped, false);
    assert.equal(userExplanation.excluded, true);
    assert.equal(userExplanation.source, "user-rule");
    assert.equal(userExplanation.matchedRule, "skip/");
    assert.equal(userExplanation.matchedPath, path.join(root, "skip"));
    assert.deepEqual(await explainExclusion(root, skipped, store), userExplanation);
    if (linkPath) assert.equal((await explainExclusion(root, linkPath, store)).source, "link");
    assert.equal(exclusion.explain(builtIn, false).source, "builtin");
    assert.equal(exclusion.explain(keep, false).source, "not-excluded");
    assert.equal(exclusion.explain(store.databasePath, false).source, "index-artifact");
    assert.equal(shouldIgnoreWatchPath(skipped, root, runtimePathPlatform(), exclusion), true);
    assert.equal(shouldIgnoreWatchPath(keep, root, runtimePathPlatform(), exclusion), false);

    const result = await scan(root, { exclusion, databasePath: store.databasePath });
    assert.equal(result.paths.includes(skipped), false);
    assert.equal(result.paths.includes(builtIn), false);
    assert.equal(result.paths.includes(keep), true);
    assert.equal(result.skipped.byRule[`user-rule:${root}:skip/`], 1);
    assert.equal(result.skipped.byRule["builtin:node-modules"], 1);
    if (linkPath) assert.equal(result.skipped.byRule.link, 1);

    const report = await sync(root, store, { exclusion });
    assert.equal(report.skipped.byRule[`user-rule:${root}:skip/`], 1);
    assert.equal(report.skipped.byRule["builtin:node-modules"], 1);
    const local = await applyFileUpdate(skipped, root, store, { exclusion });
    assert.equal(local.kind, "skipped");
    const kept = await applyFileUpdate(keep, root, store, { exclusion });
    assert.equal(kept.complete, true);

    await writeFile(path.join(root, ".localdocsearchignore"), "node_modules/\n!node_modules/\n");
    await assert.rejects(() => scan(root), IgnoreConfigurationError);
    await writeFile(path.join(root, ".localdocsearchignore"), "skip/\n");

    let callback: ((event: fs.WatchEventType, filename: string | Buffer | null) => void) | undefined;
    const watch = ((_: string, __: unknown, listener: (event: fs.WatchEventType, filename: string | Buffer | null) => void) => {
      callback = listener;
      const watcher = new EventEmitter() as fs.FSWatcher;
      watcher.close = () => {};
      return watcher;
    }) as unknown as typeof fs.watch;
    queue = new LiveWorkQueue(store.databasePath);
    const engine = new LiveUpdateEngine(store, [root], {
      mode: "foreground", syncNow: false, reconcileMs: 0, watch, workQueue: queue,
    }, {
      write: () => {},
      waitForStop: async () => {
        while (!callback) await new Promise<void>(resolve => setImmediate(resolve));
        callback("rename", path.join("skip", "inside.txt"));
      },
    });
    await engine.run();
    assert.equal(engine.snapshot().excludedEventCount, 1);
  } finally {
    queue?.close();
    await closeFixture(item);
  }
});
test("M64 user ancestor rules keep scan, watch, local-update and explain in parity", async () => {
  const item = await fixture("seekah-m64-user-ancestor-");
  const { root, store } = item;
  const cases = [
    { rule: "cache", directory: "cache" },
    { rule: "/AppData/", directory: "AppData" },
    { rule: "skip/", directory: "skip" },
  ] as const;
  const files = cases.map(({ directory }) => path.join(root, directory, "inside.txt"));
  const keep = path.join(root, "keep.txt");
  try {
    for (const file of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "excluded");
    }
    await writeFile(keep, "keep");
    await sync(root, store);
    await writeFile(path.join(root, ".localdocsearchignore"), `${cases.map(item => item.rule).join("\n")}\n`);
    const exclusion = await RootExclusion.load(root, store);
    for (const [index, file] of files.entries()) {
      const itemCase = cases[index]!;
      const explanation = exclusion.explain(file, false);
      assert.equal(explanation.excluded, true);
      assert.equal(explanation.source, "user-rule");
      assert.equal(explanation.matchedRule, itemCase.rule);
      assert.equal(explanation.matchedPath, path.join(root, itemCase.directory));
      assert.equal(shouldIgnoreWatchPath(file, root, runtimePathPlatform(), exclusion, false), true);
      assert.deepEqual(await explainExclusion(root, file, store), explanation);
      assert.equal((await applyFileUpdate(file, root, store, { exclusion })).kind, "skipped");
    }
    assert.equal(exclusion.explain(keep, false).excluded, false);
    const result = await scan(root, { exclusion, databasePath: store.databasePath });
    for (const file of files) assert.equal(result.paths.includes(file), false);
    for (const itemCase of cases) {
      assert.equal(result.skipped.byRule[`user-rule:${root}:${itemCase.rule}`], 1);
    }
  } finally {
    await closeFixture(item);
  }
});


test("M64 background reconcile removes indexed files under newly excluded scopes and persists visibility", async () => {
  const item = await fixture("seekah-m64-reconcile-");
  const { root, store } = item;
  const excluded = path.join(root, "skip", "old.bin");
  let queue: LiveWorkQueue | undefined;
  try {
    await mkdir(path.dirname(excluded), { recursive: true });
    await writeFile(excluded, "old");
    await sync(root, store);
    assert.ok(store.getDocument(excluded));
    await writeFile(path.join(root, ".localdocsearchignore"), "skip/\n");
    const exclusion = await RootExclusion.load(root, store);
    await rm(excluded);
    const deleted = await applyFileDelete(excluded, root, store, { exclusion });
    assert.equal(deleted.kind, "skipped");
    assert.ok(store.getDocument(excluded));
    await writeFile(excluded, "old");
    queue = new LiveWorkQueue(store.databasePath);
    const result = await runBackgroundReconcileBatch(root, store, queue, { maxEntries: 100, maxMs: 10_000 });
    assert.equal(result.done, true);
    assert.equal(result.skipped.byRule[`user-rule:${root}:skip/`], 1);
    assert.equal(result.exclusionCleanup.removed, 1);
    assert.equal(result.exclusionCleanup.pending, 0);
    assert.equal(store.getDocument(excluded), undefined);
    assert.equal((await readdir(path.dirname(excluded))).includes("old.bin"), true);
    const summary = store.getLastSyncReport(root).summary;
    assert.equal(summary?.skipped.byRule[`user-rule:${root}:skip/`], 1);
    assert.deepEqual(summary?.exclusionCleanup, { removed: 1, pending: 0 });
  } finally {
    queue?.close();
    await closeFixture(item);
  }
});

test("M64 exclusion cleanup preserves sources and commits the SPEC 51 batch boundary", async () => {
  const item = await fixture("seekah-m64-batch-");
  const { root, store } = item;
  const excludedRoot = path.join(root, "skip");
  const total = 1100;
  try {
    await mkdir(excludedRoot, { recursive: true });
    for (let index = 0; index < total; index++) {
      await writeFile(path.join(excludedRoot, `file-${index}.bin`), String(index));
    }
    const first = await sync(root, store);
    assert.equal(first.found, total);
    assert.equal(store.documentCountForRoot(root), total);
    await writeFile(path.join(root, ".localdocsearchignore"), "skip/\n");
    const progress: number[] = [];
    const report = await sync(root, store, { onProgress: update => {
      if (update.stage === "write" && update.current !== undefined) progress.push(update.current);
    } });
    assert.equal(report.removed, total);
    assert.deepEqual(report.exclusionCleanup, { removed: total, pending: 0 });
    assert.equal(report.skipped.byRule[`user-rule:${root}:skip/`], 1);
    assert.equal(progress.includes(1000), true);
    assert.equal((await readdir(excludedRoot)).length, total);
    assert.equal(store.documentCountForRoot(root), 1); // 只有新加入、位於根目錄的 .localdocsearchignore。
  } finally {
    await closeFixture(item);
  }
});
