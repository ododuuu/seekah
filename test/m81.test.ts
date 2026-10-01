import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptySkippedCounts } from "../src/model.js";
import { indexStatus } from "../src/mcp-tools.js";
import { readExclusionPolicies } from "../src/exclusion-visibility.js";
import { clearIndexStatusCache } from "../src/index-status-cache.js";
import { IndexStore } from "../src/store.js";
import { createWorkbench } from "../src/workbench.js";
interface RootStatusForTest {
  errors: string[];
  notices: string[];
  summary?: {
    reconcileGeneration?: number;
    exclusionCleanup?: { removed: number; pending: number };
  } | null;
}

interface Fixture {
  temp: string;
  root: string;
  databasePath: string;
  store: IndexStore;
}

async function createFixture(): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m81-status-"));
  const root = path.join(temp, "root");
  await mkdir(root, { recursive: true });
  const databasePath = path.join(temp, "data", "LocalDocSearch", "index.db");
  return { temp, root, databasePath, store: new IndexStore(databasePath) };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  try { fixture.store.close(); } catch { /* already closed */ }
  clearIndexStatusCache();
  await rm(fixture.temp, { recursive: true, force: true });
}

function firstRootStatus(status: { roots: RootStatusForTest[] }): RootStatusForTest {
  const root = status.roots[0];
  assert.ok(root, "狀態必須包含測試根目錄");
  return root;
}

async function touchIgnoreFile(filePath: string, content: string, timestamp: number): Promise<void> {
  await writeFile(filePath, content, "utf8");
  const time = new Date(timestamp);
  await utimes(filePath, time, time);
}

function pendingIndexHold(): Promise<void> {
  // This promise intentionally stays pending; /api/index/stop releases the worker through its abort signal.
  return new Promise<void>(() => {});
}

test("M81 indexStatus cache hit 與冷讀取等價且回應物件互不污染", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.recordSync(fixture.root, false, ["old error"], ["old notice"]);
    clearIndexStatusCache();
    const cold = indexStatus(fixture.store);
    assert.deepEqual(Object.keys(cold).sort(), ["counts", "databasePath", "exclusions", "format", "readOnly", "roots"]);
    const expected = structuredClone(cold);
    const cachedRoot = firstRootStatus(cold);
    cachedRoot.errors[0] = "caller mutation";
    cachedRoot.notices.push("caller mutation");
    const warm = indexStatus(fixture.store);
    assert.deepEqual(warm, expected);
    clearIndexStatusCache();
    const uncachedAgain = indexStatus(fixture.store);
    assert.deepEqual(uncachedAgain, expected);
  } finally {
    await closeFixture(fixture);
  }
});

test("M81 sync、reconcile 與 root 變更會使 indexStatus cache 失效", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.recordSync(fixture.root, false, ["before"], []);
    firstRootStatus(indexStatus(fixture.store));
    fixture.store.recordSync(fixture.root, false, ["after"], []);
    assert.deepEqual(firstRootStatus(indexStatus(fixture.store)).errors, ["after"]);

    fixture.store.recordReconcileSummary(fixture.root, 7, {
      ...emptySkippedCounts(),
      byRule: { "user:secret": 2 },
    }, { removed: 3, pending: 1 });
    const reconciled = firstRootStatus(indexStatus(fixture.store));
    assert.equal(reconciled.summary?.reconcileGeneration, 7);
    assert.deepEqual(reconciled.summary?.exclusionCleanup, { removed: 3, pending: 1 });

    const secondRoot = path.join(fixture.temp, "second-root");
    await mkdir(secondRoot);
    fixture.store.registerRoot(secondRoot);
    assert.equal(indexStatus(fixture.store).roots.length, 2);
  } finally {
    await closeFixture(fixture);
  }
});

test("M81 ignore file 建立、修改與刪除會使排除政策 cache 失效", async () => {
  const fixture = await createFixture();
  const ignoreFile = path.join(fixture.root, ".localdocsearchignore");
  try {
    fixture.store.registerRoot(fixture.root);
    const initial = readExclusionPolicies(fixture.store);
    assert.equal(initial[0]?.ignoreFiles[0]?.exists, false);

    await touchIgnoreFile(ignoreFile, "secret/\n", Date.now() + 2_000);
    const created = readExclusionPolicies(fixture.store);
    assert.equal(created[0]?.ignoreFiles[0]?.exists, true);
    assert.deepEqual(created[0]?.ignoreFiles[0]?.patterns, ["secret/"]);

    await touchIgnoreFile(ignoreFile, "private/\n", Date.now() + 4_000);
    const modified = readExclusionPolicies(fixture.store);
    assert.deepEqual(modified[0]?.ignoreFiles[0]?.patterns, ["private/"]);

    await rm(ignoreFile);
    const deleted = readExclusionPolicies(fixture.store);
    assert.equal(deleted[0]?.ignoreFiles[0]?.exists, false);
    assert.deepEqual(deleted[0]?.ignoreFiles[0]?.patterns, []);
  } finally {
    await closeFixture(fixture);
  }
});

test("M81 /api/index-progress 只回傳 indexing／autoupdate 且與完整狀態同步", async () => {
  const fixture = await createFixture();
  const handle = await createWorkbench({
    databasePath: fixture.databasePath,
    token: "m81-token",
    secret: Buffer.alloc(32, 81),
    environment: {},
    tempParent: fixture.temp,
    indexHold: pendingIndexHold,
    startupOptions: { platform: "linux" },
  });
  try {
    fixture.store.registerRoot(fixture.root);
    const origin = handle.url.split("/#")[0]!;
    const headers = { "X-LocalDocSearch-Token": handle.token, origin };
    const [fullResponse, progressResponse] = await Promise.all([
      fetch(`${origin}/api/index-status`, { headers }),
      fetch(`${origin}/api/index-progress`, { headers }),
    ]);
    assert.equal(fullResponse.status, 200);
    assert.equal(progressResponse.status, 200);
    const full = await fullResponse.json() as { indexing: unknown; autoupdate: unknown };
    const progress = await progressResponse.json() as Record<string, unknown> & { indexing?: unknown; autoupdate?: unknown };
    assert.deepEqual(Object.keys(progress).sort(), ["autoupdate", "indexing"]);
    assert.deepEqual(progress.indexing, full.indexing);
    assert.deepEqual(progress.autoupdate, full.autoupdate);
    assert.equal("roots" in progress, false);
    assert.equal("errors" in progress, false);
    assert.equal("exclusions" in progress, false);
    assert.equal("format" in progress, false);

    const settingsResponse = await fetch(`${origin}/api/settings`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ deleteConfirmation: false, totalMode: "exact" }),
    });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json() as { deleteConfirmation: boolean; totalMode: string };
    assert.equal(settings.deleteConfirmation, false);
    assert.equal(settings.totalMode, "exact");
    const refreshedResponse = await fetch(`${origin}/api/index-status`, { headers });
    const refreshed = await refreshedResponse.json() as { deleteConfirmation: boolean; totalMode: string };
    assert.equal(refreshed.deleteConfirmation, false);
    assert.equal(refreshed.totalMode, "exact");

    const startResponse = await fetch(`${origin}/api/index`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startResponse.status, 202);
    const started = await startResponse.json() as { indexing?: { state?: string } };
    assert.equal(started.indexing?.state, "running");
    const runningProgress = await (await fetch(`${origin}/api/index-progress`, { headers })).json() as {
      indexing?: { state?: string };
    };
    assert.equal(runningProgress.indexing?.state, "running");
    const stopResponse = await fetch(`${origin}/api/index/stop`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(stopResponse.status, 200);
    const stopped = await stopResponse.json() as { indexing?: { state?: string } };
    assert.equal(stopped.indexing?.state, "stopped");
    const stoppedProgress = await (await fetch(`${origin}/api/index-progress`, { headers })).json() as {
      indexing?: { state?: string };
    };
    assert.equal(stoppedProgress.indexing?.state, "stopped");
  } finally {
    await handle.close();
    await closeFixture(fixture);
  }
});
