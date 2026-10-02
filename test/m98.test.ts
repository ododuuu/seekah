import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IndexStore } from "../src/store.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { LiveUpdateEngine } from "../src/live-update.js";
import { INDEX_RECOVERY_REQUIRED_MESSAGE, SQLITE_READONLY_ROLLBACK } from "../src/index-errors.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const INDEX_FAILURE_MESSAGES = {
  SQLITE_CORRUPT: "database disk image is malformed",
  SQLITE_NOTADB: "file is not a database",
} as const;


function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode });
}

function fakeWatch(): typeof fs.watch {
  return (() => {
    const watcher = new EventEmitter() as EventEmitter & { close(): void };
    watcher.close = () => watcher.removeAllListeners();
    return watcher;
  }) as unknown as typeof fs.watch;
}

async function fixture(prefix: string): Promise<{ temp: string; root: string; databasePath: string; store: IndexStore; queue: LiveWorkQueue }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "note.txt"), "m98 live update");
  const store = new IndexStore(databasePath);
  await sync(root, store);
  const queue = new LiveWorkQueue(databasePath);
  return { temp, root, databasePath, store, queue };
}

test("m98: live recovery 錯誤記錄固定 INDEX_RECOVERY_REQUIRED 且不含 SQLite 原文", async () => {
  const fixtureData = await fixture("seekah-m98-live-recovery-");
  const logs: string[] = [];
  try {
    const engine = new LiveUpdateEngine(fixtureData.store, [fixtureData.root], {
      mode: "foreground",
      debounceMs: 200,
      reconcileMs: 1000,
      syncNow: true,
      watch: fakeWatch(),
      workQueue: fixtureData.queue,
      sync: async () => {
        throw sqliteError("attempt to write a readonly database", SQLITE_READONLY_ROLLBACK);
      },
    }, {
      write: line => logs.push(line),
      waitForStop: async () => undefined,
    });

    assert.equal(await engine.run(), 3);
    const status = engine.snapshot();
    assert.equal(status.recentErrors.includes(INDEX_RECOVERY_REQUIRED_MESSAGE), true);
    assert.equal(logs.join("\n").includes("attempt to write a readonly database"), false);
    assert.equal(logs.some(line => line.includes("監看同步失敗")), true);
  } finally {
    fixtureData.queue.close();
    fixtureData.store.close();
    await rm(fixtureData.temp, { recursive: true, force: true });
  }
});

test("m98: SQLITE_CORRUPT 與 SQLITE_NOTADB 記為同步失敗且不分類為 recovery", async () => {
  const cases = [
    { label: "corrupt", errcode: SQLITE_CORRUPT, message: INDEX_FAILURE_MESSAGES.SQLITE_CORRUPT },
    { label: "notadb", errcode: SQLITE_NOTADB, message: INDEX_FAILURE_MESSAGES.SQLITE_NOTADB },
  ] as const;
  for (const testCase of cases) {
    const fixtureData = await fixture(`seekah-m98-${testCase.label}-`);
    const logs: string[] = [];
    try {
      const engine = new LiveUpdateEngine(fixtureData.store, [fixtureData.root], {
        mode: "foreground",
        debounceMs: 200,
        reconcileMs: 1000,
        syncNow: true,
        watch: fakeWatch(),
        workQueue: fixtureData.queue,
        sync: async () => {
          throw sqliteError(testCase.message, testCase.errcode);
        },
      }, {
        write: line => logs.push(line),
        waitForStop: async () => undefined,
      });

      assert.equal(await engine.run(), 3, testCase.label);
      const status = engine.snapshot();
      assert.equal(status.recentErrors.includes(`LIVE_UPDATE_FAILED: ${testCase.message}`), true, testCase.label);
      assert.equal(status.recentErrors.includes(INDEX_RECOVERY_REQUIRED_MESSAGE), false, testCase.label);
      assert.equal(logs.some(line => line.includes("監看同步失敗") && line.includes("保留既有索引")), true, testCase.label);
    } finally {
      fixtureData.queue.close();
      fixtureData.store.close();
      await rm(fixtureData.temp, { recursive: true, force: true });
    }
  }
});


test("m98: work DB 孤兒清理失敗時 engine 記錄後繼續，說明孤兒狀態仍可能保留", async () => {
  const fixtureData = await fixture("seekah-m98-cleanup-");
  const logs: string[] = [];
  const cleanup = fixtureData.queue as unknown as {
    cleanupOrphanRoots: (activeRoots: readonly string[]) => never;
  };
  cleanup.cleanupOrphanRoots = () => {
    throw sqliteError("attempt to write a readonly database", SQLITE_READONLY_ROLLBACK);
  };
  try {
    const engine = new LiveUpdateEngine(fixtureData.store, [fixtureData.root], {
      mode: "foreground",
      syncNow: false,
      watch: fakeWatch(),
      workQueue: fixtureData.queue,
    }, {
      write: line => logs.push(line),
      waitForStop: async () => undefined,
    });
    const status = engine.snapshot();
    assert.equal(status.recentErrors.includes(INDEX_RECOVERY_REQUIRED_MESSAGE), true);
    assert.equal(logs.join("\n").includes("attempt to write a readonly database"), false);
    assert.equal(logs.some(line => line.includes("工作佇列清理孤兒根目錄失敗") && line.includes("孤兒工作狀態仍可能保留")), true);
  } finally {
    fixtureData.queue.close();
    fixtureData.store.close();
    await rm(fixtureData.temp, { recursive: true, force: true });
  }
});

test("m98: cleanup 失敗保留實際孤兒 row，搜尋隔離孤兒根且保留活躍根文件", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m98-orphan-rows-"));
  const activeRoot = path.join(temp, "active");
  const orphanRoot = path.join(temp, "orphan");
  const activeFile = path.join(activeRoot, "active.txt");
  const orphanFile = path.join(orphanRoot, "orphan.txt");
  const databasePath = path.join(temp, "index.db");
  let store: IndexStore | undefined;
  let queue: LiveWorkQueue | undefined;
  try {
    await mkdir(activeRoot, { recursive: true });
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(activeFile, "m98-active-needle");
    await writeFile(orphanFile, "m98-orphan-needle");
    store = new IndexStore(databasePath);
    await sync(activeRoot, store);
    await sync(orphanRoot, store);
    assert.equal(search(store, "m98-active-needle").some(result => result.path === activeFile), true);
    assert.equal(search(store, "m98-orphan-needle").some(result => result.path === orphanFile), true);

    store.removeRoot(orphanRoot);
    assert.equal(store.roots().includes(orphanRoot), false);
    queue = new LiveWorkQueue(databasePath);
    queue.acceptPath(orphanRoot, "orphan.txt");
    queue.close();
    queue = undefined;

    let failCleanup = true;
    const failingQueue = new LiveWorkQueue(databasePath, {
      persistHook: (operation, phase) => {
        if (failCleanup && operation === "ack" && phase === "before-commit") {
          failCleanup = false;
          throw new Error("m98 cleanup failure");
        }
      },
    });
    const logs: string[] = [];
    try {
      const engine = new LiveUpdateEngine(store, [activeRoot], {
        mode: "foreground",
        syncNow: false,
        startupCatchupMode: "auto",
        watch: fakeWatch(),
        workQueue: failingQueue,
      }, {
        write: line => logs.push(line),
        waitForStop: async () => undefined,
      });
      assert.equal(failCleanup, false);

      assert.equal(failingQueue.list(orphanRoot).some(item => item.relPath === "orphan.txt"), true);
      assert.equal(await engine.run(), 0);
      assert.equal(failingQueue.list(orphanRoot).some(item => item.relPath === "orphan.txt"), true);
      assert.equal(search(store, "m98-orphan-needle").some(result => result.path === orphanFile), false);
      assert.equal(search(store, "m98-active-needle").some(result => result.path === activeFile), true);
      assert.equal(store.documentCountForRoot(activeRoot), 1);
      assert.equal(logs.some(line => line.includes("工作佇列清理孤兒根目錄失敗") && line.includes("孤兒工作狀態仍可能保留")), true);
    } finally {
      failingQueue.close();
    }
  } finally {
    queue?.close();
    store?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
