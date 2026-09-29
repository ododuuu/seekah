import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatLiveStatus } from "../src/autoupdate.js";
import { LiveWorkQueue, workStatePath } from "../src/live-queue.js";
import type { LocalUpdateResult } from "../src/local-update.js";
import { runBackgroundReconcileBatch } from "../src/reconcile.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

async function setupFixture(files: Record<string, string>): Promise<{
  temp: string;
  root: string;
  database: string;
  store: IndexStore;
}> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m49-failed-scope-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const store = new IndexStore(database);
  await sync(root, store);
  return { temp, root, database, store };
}

function incompleteUpdate(filePath: string, root: string, deferred: boolean): LocalUpdateResult {
  return {
    kind: "unstable",
    path: filePath,
    root,
    updated: 0,
    added: 0,
    removed: 0,
    unchanged: 0,
    parserCalls: 0,
    complete: false,
    deferred,
    diagnostics: [{
      stage: "read",
      path: filePath,
      code: deferred ? "FILE_UNSTABLE" : "EACCES",
      message: deferred ? "檔案仍在變動，延後重新核對" : "無法讀取文件，保留既有索引",
    }],
    notices: [],
  };
}

test("M49 background reconciliation counts read failures and deferred checks separately", async () => {
  const fixture = await setupFixture({
    "deferred.txt": "deferred",
    "read-error.txt": "read-error",
    "removed.txt": "removed",
  });
  const queue = new LiveWorkQueue(fixture.database);
  try {
    await rm(path.join(fixture.root, "removed.txt"));
    const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 500,
      maxMs: 60_000,
      applyFileUpdate: async filePath => incompleteUpdate(
        filePath,
        fixture.root,
        path.basename(filePath) === "deferred.txt",
      ),
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.readFailures, [path.join(fixture.root, "read-error.txt")]);
    assert.deepEqual(result.deferredChecks, [path.join(fixture.root, "deferred.txt")]);
    assert.deepEqual(queue.reconcileStatus(fixture.root)?.readFailures, result.readFailures);
    assert.deepEqual(queue.reconcileStatus(fixture.root)?.deferredChecks, result.deferredChecks);
    assert.equal(search(fixture.store, "removed").length, 1);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M49 readable scope with pending work is deferred, not a read failure", async () => {
  const fixture = await setupFixture({ "readable.txt": "readable" });
  const queue = new LiveWorkQueue(fixture.database);
  try {
    queue.acceptPath(fixture.root, "created-during-reconcile.txt");
    const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 500,
      maxMs: 60_000,
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.readFailures, []);
    assert.deepEqual(result.deferredChecks, [fixture.root]);
    assert.equal(queue.reconcileStatus(fixture.root)?.phase, "failed");
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M49 legacy failed_scopes_json arrays remain readable without rebuild", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m49-legacy-"));
  const database = path.join(temp, "index.db");
  const root = path.join(temp, "root");
  const legacyScope = path.join(root, "readable-folder");
  const first = new LiveWorkQueue(database);
  const generation = first.beginReconcile(root, "daemon").generation;
  first.close();

  const raw = new DatabaseSync(workStatePath(database));
  raw.prepare("UPDATE reconcile_state SET phase = 'failed', failed_scopes_json = ? WHERE root = ? AND generation = ?")
    .run(JSON.stringify([legacyScope]), root, generation);
  raw.close();

  const reopened = new LiveWorkQueue(database);
  try {
    const state = reopened.reconcileStatus(root);
    assert.equal(reopened.reopened, true);
    assert.deepEqual(state?.readFailures, [legacyScope]);
    assert.deepEqual(state?.deferredChecks, []);
    assert.equal(state?.phase, "failed");
  } finally {
    reopened.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("M49 autoupdate status names read failures and deferred checks separately", () => {
  const status = formatLiveStatus({
    schemaVersion: 1,
    instanceId: "m49",
    pid: 1,
    mode: "background",
    startedAt: "t0",
    lastHeartbeatAt: "t1",
    phase: "reconciling",
    settings: { debounceMs: 1500, reconcileMs: 21_600_000 },
    ready: true,
    roots: [{
      path: "/docs",
      watch: "active",
      pending: 1,
      scopeMode: "split",
      handles: 2,
      reconcile: {
        generation: 4,
        phase: "failed",
        reason: "daemon",
        checked: 12,
        frontierCount: 0,
        readFailures: 2,
        deferredChecks: 3,
        startedAt: "t2",
        updatedAt: "t3",
      },
    }],
    pendingCount: 1,
    eventCount: 0,
    localUpdateCount: 0,
    rootScanCount: 1,
    subtreeScanCount: 0,
    queuePendingCount: 1,
    queueDegraded: false,
    recentErrors: [],
  });

  assert.match(status, /讀取失敗=2/u);
  assert.match(status, /延後核對=3/u);
  assert.doesNotMatch(status, /失敗scope/u);
});
