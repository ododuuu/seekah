import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TextBlock } from "../src/model.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createLegacyStore } from "./legacy-index.js";

// Real wall-clock timer required for this integration test (rule exception): fake timers do not
// affect SQLite's actual lock state or cause node:sqlite to return genuine errcode BUSY/LOCKED
// on BEGIN from second connection. Delay is inside retry window to exercise the path.
const line = (ordinal: number, content: string): TextBlock => ({ ordinal, heading: null, content, locationKind: "line", locationValue: `第 ${ordinal + 1} 行` });

test("m48: migration (chunk store upgrade) retries on SQLITE_BUSY when main db write lock held by second conn, succeeds after release", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m48-busy-"));
  const databasePath = path.join(temp, "index.db");
  // create legacy (pre-chunk) that will require migrateChunkStore on upgrade
  const prep = createLegacyStore(databasePath);
  try {
    prep.registerRoot(temp);
    prep.upsert({
      path: path.join(temp, "doc.txt"),
      filename: "doc.txt",
      extension: ".txt",
      sizeBytes: 10,
      modifiedAtMs: 1000,
      status: "indexed",
      errorCode: null,
      errorMessage: null,
      blocks: [line(0, "忙碌重試測試 busy retry migration")],
    }, temp);
  } finally {
    prep.close();
  }

  const store = new IndexStore(databasePath);
  try {
    // hold write lock on main db (coord .writer lock is separate; upgrade will acquire coord ok)
    const holder = new DatabaseSync(databasePath);
    holder.exec("BEGIN IMMEDIATE");
    let released = false;
    const releaser = (async () => {
      // release inside retry window (first delays 0/100/300)
      await new Promise<void>(r => setTimeout(r, 180));
      holder.exec("ROLLBACK");
      holder.close();
      released = true;
    })();
    // should encounter BUSY on runTx, retry, succeed once released
    await store.upgrade();
    await releaser;
    assert.ok(released);
    const fmt = store.formatStatus();
    assert.equal(fmt.chunkStoreVersion, "1");
    assert.equal(fmt.needsUpgrade, false);
    const hits = search(store, "忙碌");
    assert.ok(hits.length >= 1);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
