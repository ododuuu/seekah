import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveWorkQueue } from "../src/live-queue.js";
import { runBackgroundReconcileBatch } from "../src/reconcile.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";

async function setupFixture(numFiles: number): Promise<{
  temp: string; root: string; database: string; store: IndexStore; files: string[];
}> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m53-batch-"));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  await mkdir(root, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < numFiles; i++) {
    const name = `f${i.toString().padStart(3, "0")}.txt`;
    const target = path.join(root, name);
    await writeFile(target, `content-${i} 中文測試\n`, "utf8");
    files.push(target);
  }
  const store = new IndexStore(database);
  await sync(root, store);
  return { temp, root, database, store, files };
}

test("M53 batch checkpoint reduces tx count (persistHook)", async () => {
  const N = 220;
  const fixture = await setupFixture(N);
  const queue = new LiveWorkQueue(fixture.database, {
    persistHook: (op, phase) => {
      if (phase === "before-commit" && op === "upsert") {
        (globalThis as any).__m53Tx = ((globalThis as any).__m53Tx || 0) + 1;
      }
    },
  });
  try {
    (globalThis as any).__m53Tx = 0;
    const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 10000, maxMs: 120000,
    });
    const tx = (globalThis as any).__m53Tx || 0;
    assert.equal(result.checked, N);
    assert.equal(result.complete, true);
    assert.ok(tx < Math.max(10, Math.floor(N / 5)), `tx drop, got ${tx}`);
    assert.ok(tx < N);
  } finally {
    queue.close(); fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M53 mid-batch interrupt + restart: at-least-once, no loss, no mis-delete", async () => {
  const N = 12;
  const fixture = await setupFixture(N);
  let q1 = new LiveWorkQueue(fixture.database);
  let partial;
  try {
    partial = await runBackgroundReconcileBatch(fixture.root, fixture.store, q1, {
      maxEntries: 5, maxMs: 60000,
    });
    assert.ok(partial.checked > 0 && partial.checked < N);
    assert.ok((partial as any).frontierCount > 0);
  } finally { q1.close(); }
  const q2 = new LiveWorkQueue(fixture.database);
  try {
    const full = await runBackgroundReconcileBatch(fixture.root, fixture.store, q2, {
      maxEntries: 10000, maxMs: 120000,
    });
    assert.equal(full.checked, N);
    assert.equal(full.complete, true);
    assert.equal(full.frontierCount, 0);
    for (let i = 0; i < N; i += 3) {
      const hits = search(fixture.store, `content-${i}`);
      assert.ok(hits.length >= 1);
    }
  } finally {
    q2.close(); fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M53 removeMissing requires prior flush: mis-delete without commit before remove", async () => {
  const N = 5;
  const fixture = await setupFixture(N);
  const queue = new LiveWorkQueue(fixture.database);
  const orig = (queue as any).saveReconcileSteps ? (queue as any).saveReconcileSteps.bind(queue) : null;
  (queue as any).saveReconcileSteps = () => { /* noop -> no durable seen -> mis remove */ };
  try {
    const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 10000, maxMs: 60000,
    });
    assert.ok(result.removed >= N);
    const hits = search(fixture.store, "content-");
    assert.equal(hits.length, 0);
  } finally {
    if (orig) (queue as any).saveReconcileSteps = orig;
    queue.close(); fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M53 normal flush keeps files (no mis-delete)", async () => {
  const N = 5;
  const fixture = await setupFixture(N);
  const queue = new LiveWorkQueue(fixture.database);
  try {
    const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 10000, maxMs: 60000,
    });
    assert.equal(result.removed, 0);
    assert.equal(result.complete, true);
    assert.ok(search(fixture.store, "content-0").length >= 1);
  } finally {
    queue.close(); fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M53 checkpoint time from last flush not startedAt: time jump after first does not cause per-item tx", async () => {
  const N = 5;
  const fixture = await setupFixture(N);
  let txCount = 0;
  let nowCalls = 0;
  const mockNow = () => {
    nowCalls++;
    if (nowCalls === 1) return 0; // only for initial startedAt
    return 3000; // large delta for all subsequent now() calls
  };
  const queue = new LiveWorkQueue(fixture.database, {
    now: mockNow,
    persistHook: (op, phase) => {
      if (phase === "before-commit" && op === "upsert") txCount++;
    },
  });
  try {
    const result = await runBackgroundReconcileBatch(fixture.root, fixture.store, queue, {
      maxEntries: 10000,
      maxMs: 60000,
      now: mockNow,
    });
    assert.equal(result.checked, N);
    // fix (lastFlush): time check triggers flush only first time, then last updated, no more time flushes per item
    // bad (startedAt): every item after will see large delta, flush inside per item -> tx > N
    assert.ok(txCount <= N, `should not degenerate to per-item on time, got tx=${txCount}`);
  } finally {
    queue.close();
    fixture.store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});
