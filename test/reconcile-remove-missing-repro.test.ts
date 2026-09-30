import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { runBackgroundReconcileBatch, type BackgroundReconcileResult } from "../src/reconcile.js";

interface Fixture {
  temp: string;
  root: string;
  database: string;
  store: IndexStore;
  files: string[];
}

function nestedFiles(count: number, directory = path.join("nested", "level")): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    path.join(directory, `document-${String(index).padStart(2, "0")}.txt`),
    `內容-${index}\n`,
  ]));
}

async function createFixture(files: Record<string, string>): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-reconcile-frontier-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  const store = new IndexStore(database);
  await sync(root, store);
  return {
    temp,
    root,
    database,
    store,
    files: Object.keys(files).map(relativePath => path.join(root, relativePath)),
  };
}

async function closeFixture(fixture: Pick<Fixture, "temp" | "store">, queue?: LiveWorkQueue): Promise<void> {
  queue?.close();
  fixture.store.close();
  await rm(fixture.temp, { recursive: true, force: true });
}

async function runToCompletion(root: string, store: IndexStore, queue: LiveWorkQueue): Promise<BackgroundReconcileResult> {
  let result!: BackgroundReconcileResult;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await runBackgroundReconcileBatch(root, store, queue, {
      maxEntries: 10_000,
      maxMs: 60_000,
      sleep: async () => undefined,
    });
    if (result.done) return result;
  }
  throw new Error("背景校正未在測試期限內完成");
}

async function sourceSnapshot(files: string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const filePath of files) snapshot.set(filePath, await readFile(filePath, "utf8"));
  return snapshot;
}

async function assertSourceSnapshot(snapshot: Map<string, string>): Promise<void> {
  for (const [filePath, content] of snapshot) {
    assert.equal(await readFile(filePath, "utf8"), content, `來源文件被改動：${filePath}`);
  }
}

function completionSummary(result: BackgroundReconcileResult, store: IndexStore, root: string, files: string[]) {
  return {
    checked: result.checked,
    done: result.done,
    complete: result.complete,
    removed: result.removed,
    frontierCount: result.frontierCount,
    pendingAfter: result.pendingAfter,
    readFailures: result.readFailures,
    deferredChecks: result.deferredChecks,
    documentCount: store.documentCountForRoot(root),
    indexed: files.map(filePath => store.getDocument(filePath) !== undefined),
  };
}

test("25 份 nested 文件完成背景校正時不會誤刪索引或來源", async () => {
  const fixture = await createFixture(nestedFiles(25));
  const queue = new LiveWorkQueue(fixture.database);
  const before = await sourceSnapshot(fixture.files);
  try {
    const result = await runToCompletion(fixture.root, fixture.store, queue);

    assert.equal(result.done, true);
    assert.equal(result.complete, true);
    assert.equal(result.removed, 0);
    assert.equal(fixture.store.documentCountForRoot(fixture.root), 25);
    for (const filePath of fixture.files) assert.ok(fixture.store.getDocument(filePath), `索引列遺失：${filePath}`);
    await assertSourceSnapshot(before);
  } finally {
    await closeFixture(fixture, queue);
  }
});

test("nested subtree 真正消失的文件仍會被移除", async () => {
  const fixture = await createFixture(nestedFiles(7));
  const queue = new LiveWorkQueue(fixture.database);
  const disappeared = fixture.files[3]!;
  try {
    await rm(disappeared);
    const result = await runToCompletion(fixture.root, fixture.store, queue);

    assert.equal(result.done, true);
    assert.equal(result.complete, true);
    assert.equal(result.removed, 1);
    assert.equal(fixture.store.getDocument(disappeared), undefined);
    assert.equal(fixture.store.documentCountForRoot(fixture.root), 6);
    for (const filePath of fixture.files.filter(filePath => filePath !== disappeared)) {
      assert.ok(fixture.store.getDocument(filePath), `仍存在的索引列遺失：${filePath}`);
    }
  } finally {
    await closeFixture(fixture, queue);
  }
});

test("子目錄中斷後重啟，接續結果等同不中斷校正", async () => {
  const files = nestedFiles(12);
  const interrupted = await createFixture(files);
  const interruptedQueue = new LiveWorkQueue(interrupted.database);
  const first = await runBackgroundReconcileBatch(interrupted.root, interrupted.store, interruptedQueue, {
    maxEntries: 5,
    maxMs: 60_000,
  });
  assert.equal(first.done, false);
  assert.equal(first.frontierCount, 3);
  interruptedQueue.close();
  interrupted.store.close();

  const resumedStore = new IndexStore(interrupted.database);
  const resumedQueue = new LiveWorkQueue(interrupted.database);
  try {
    const resumed = await runToCompletion(interrupted.root, resumedStore, resumedQueue);

    const uninterrupted = await createFixture(files);
    const uninterruptedQueue = new LiveWorkQueue(uninterrupted.database);
    try {
      const baseline = await runToCompletion(uninterrupted.root, uninterrupted.store, uninterruptedQueue);
      assert.deepEqual(
        completionSummary(resumed, resumedStore, interrupted.root, interrupted.files),
        completionSummary(baseline, uninterrupted.store, uninterrupted.root, uninterrupted.files),
      );
    } finally {
      await closeFixture(uninterrupted, uninterruptedQueue);
    }
  } finally {
    await closeFixture({ temp: interrupted.temp, store: resumedStore }, resumedQueue);
  }
});

test("子目錄 readdir 失敗時保留該子樹既有索引", async () => {
  const fixture = await createFixture({
    ...nestedFiles(6, path.join("blocked", "level")),
    [path.join("available", "file.txt")]: "仍可讀取\n",
  });
  const queue = new LiveWorkQueue(fixture.database);
  const blockedDirectory = path.resolve(fixture.root, "blocked", "level");
  const readdirOwner = fs.promises as unknown as {
    readdir: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReaddir = readdirOwner.readdir;
  readdirOwner.readdir = async (...args: unknown[]) => {
    if (path.resolve(String(args[0])) === blockedDirectory) {
      const error = new Error("拒絕讀取測試子目錄") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return Reflect.apply(originalReaddir, fs.promises, args);
  };
  try {
    const result = await runToCompletion(fixture.root, fixture.store, queue);

    assert.equal(result.done, true);
    assert.equal(result.complete, false);
    assert.equal(result.removed, 0);
    assert.ok(result.readFailures.some(filePath => filePath === blockedDirectory));
    assert.equal(fixture.store.documentCountForRoot(fixture.root), 7);
    for (const filePath of fixture.files) assert.ok(fixture.store.getDocument(filePath), `讀取失敗時索引列遺失：${filePath}`);
  } finally {
    readdirOwner.readdir = originalReaddir;
    await closeFixture(fixture, queue);
  }
});
