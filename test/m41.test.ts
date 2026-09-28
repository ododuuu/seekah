import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { OperationCancelledError, type ProgressUpdate } from "../src/progress.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { createLegacyStore } from "./legacy-index.js";

// SPEC §51: indexed foreign keys, markers only during migration, batched removal.

function count(databasePath: string, sql: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return Number(Object.values(db.prepare(sql).get()!)[0]); } finally { db.close(); }
}

const ftsTables = ["search_chunk_trigrams", "search_chunk_unigrams", "search_chunk_bigrams", "search_filename_trigrams",
  "search_filename_unigrams", "search_filename_bigrams", "search_heading_trigrams", "search_heading_unigrams", "search_heading_bigrams"];

function rowCounts(databasePath: string): Record<string, number> {
  return Object.fromEntries(["documents", "document_chunks", "block_meta", "search_headings",
    "index_migration_documents", ...ftsTables].map(table => [table, count(databasePath, `SELECT count(*) FROM ${table}`)]));
}

function record(root: string, filename: string, blocks: [string | null, string][]): DocumentRecord {
  return { path: path.join(root, filename), filename, extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
    status: blocks.length ? "indexed" : "unsupported", errorCode: null, errorMessage: null,
    blocks: blocks.map(([heading, content], ordinal) => ({ ordinal, heading, content, locationKind: "line", locationValue: `${ordinal}` })) };
}

/** Every foreign key whose child columns are not the leading columns of an index (or the rowid). */
function unindexedForeignKeys(databasePath: string): string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'").all() as { name: string }[])
      .map(row => row.name);
    const missing: string[] = [];
    for (const table of tables) {
      const keys = new Map<number, string[]>();
      for (const key of db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { id: number; seq: number; from: string }[]) {
        (keys.get(key.id) ?? keys.set(key.id, []).get(key.id)!)[key.seq] = key.from;
      }
      if (!keys.size) continue;
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; pk: number }[];
      const primary = columns.filter(column => column.pk > 0);
      const rowidAlias = primary.length === 1 && primary[0]!.type.toUpperCase() === "INTEGER" ? primary[0]!.name : null;
      const leading = (db.prepare(`PRAGMA index_list("${table}")`).all() as { name: string }[])
        .map(index => (db.prepare(`PRAGMA index_info("${index.name}")`).all() as { seqno: number; name: string }[])
          .sort((a, b) => a.seqno - b.seqno).map(column => column.name));
      for (const from of keys.values()) {
        const covered = (from.length === 1 && from[0] === rowidAlias)
          || leading.some(index => from.every((column, position) => index[position] === column));
        if (!covered) missing.push(`${table}(${from.join(", ")})`);
      }
    }
    return missing;
  } finally { db.close(); }
}

test("every foreign key child column leads an index on fresh and migrated indexes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m41-fk-"));
  try {
    const fresh = path.join(temp, "fresh.db");
    new IndexStore(fresh).close();
    assert.deepEqual(unindexedForeignKeys(fresh), []);

    const migrated = path.join(temp, "migrated.db");
    const root = path.join(temp, "docs");
    const legacy = createLegacyStore(migrated);
    try {
      legacy.registerRoot(root);
      legacy.upsert(record(root, "a.txt", [["章", "alpha 內容"]]), root);
      assert.deepEqual(unindexedForeignKeys(migrated), []);
      await legacy.upgrade();
    } finally { legacy.close(); }
    assert.deepEqual(unindexedForeignKeys(migrated), []);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("migration markers exist only while a migration runs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m41-markers-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "index.db");
  try {
    const store = new IndexStore(databasePath);
    try {
      store.registerRoot(root);
      for (let index = 0; index < 5; index++) store.upsert(record(root, `${index}.txt`, [[null, `token-${index}`]]), root);
      assert.equal(count(databasePath, "SELECT count(*) FROM index_migration_documents"), 0);
      assert.equal(store.formatStatus().chunkStoreCompletedDocuments, 5);
    } finally { store.close(); }

    // Markers left behind by finished migrations (as 0.38.0 did) are purged on writer open.
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec(`INSERT INTO index_migration_documents(version, document_id) SELECT 'chunk_store_1', id FROM documents;
        INSERT INTO index_migration_documents(version, document_id) SELECT 'content_storage_2', id FROM documents;`);
    } finally { raw.close(); }
    const readOnly = new IndexStore(databasePath, { readOnly: true });
    try { assert.equal(readOnly.formatStatus().chunkStoreCompletedDocuments, 5); } finally { readOnly.close(); }
    assert.equal(count(databasePath, "SELECT count(*) FROM index_migration_documents"), 10);
    new IndexStore(databasePath).close();
    assert.equal(count(databasePath, "SELECT count(*) FROM index_migration_documents"), 0);

    // An unfinished migration keeps its markers so it can resume.
    const legacyPath = path.join(temp, "legacy.db");
    const legacy = createLegacyStore(legacyPath);
    try {
      legacy.registerRoot(root);
      legacy.upsert(record(root, "a.txt", [[null, "alpha"]]), root);
      assert.equal(count(legacyPath, "SELECT count(*) FROM index_migration_documents WHERE version = 'chunk_store_1'"), 1);
      await legacy.upgrade();
      assert.equal(count(legacyPath, "SELECT count(*) FROM index_migration_documents"), 0);
      legacy.upsert(record(root, "b.txt", [[null, "beta"]]), root);
      assert.equal(count(legacyPath, "SELECT count(*) FROM index_migration_documents"), 0);
      assert.equal(legacy.formatStatus().chunkStoreCompletedDocuments, 2);
    } finally { legacy.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("removeMissing commits in batches, reports progress and resumes after cancellation", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m41-remove-"));
  const root = path.join(temp, "docs");
  const once = path.join(temp, "once.db");
  const resumed = path.join(temp, "resumed.db");
  const fill = (store: IndexStore) => {
    store.registerRoot(root);
    store.upsert(record(root, "keep.txt", [["保留", "keep-token"]]), root);
    for (let index = 0; index < 1_050; index++) store.upsert(record(root, `gone-${index}.bin`, []), root);
    for (let index = 0; index < 50; index++) {
      store.upsert(record(root, `gone-${index}.txt`, [["刪除章", `gone-token ${index}`], [null, "第二段 gone-token"]]), root);
    }
  };
  const keep = new Set([path.join(root, "keep.txt")]);
  try {
    // Filling costs one commit per document; build it once and copy it.
    const filled = new IndexStore(once);
    try { fill(filled); } finally { filled.close(); }
    await copyFile(once, resumed);
    const first = new IndexStore(once);
    try {
      const updates: ProgressUpdate[] = [];
      assert.deepEqual(await first.removeMissing(keep, root, undefined, [], { onProgress: update => updates.push(update) }),
        { removed: 1_100, protected: 0 });
      assert.deepEqual(updates.map(update => [update.stage, update.message, update.current, update.total]),
        [0, 1_000, 1_100].map(current => ["write", "刪除校正", current, 1_100]));
      assert.equal(search(first, "gone-token").length, 0);
      assert.equal(search(first, "刪除章").length, 0);
      assert.equal(search(first, "keep-token").length, 1);
    } finally { first.close(); }

    const second = new IndexStore(resumed);
    try {
      const controller = new AbortController();
      await assert.rejects(second.removeMissing(keep, root, undefined, [], {
        signal: controller.signal,
        onProgress: update => { if (update.current === 1_000) controller.abort(); },
      }), (error: unknown) => {
        assert.ok(error instanceof OperationCancelledError);
        assert.deepEqual(error.partial, { removed: 1_000, protected: 0 });
        return true;
      });
      assert.equal(count(resumed, "SELECT count(*) FROM documents"), 101);
      assert.deepEqual(await second.removeMissing(keep, root), { removed: 100, protected: 0 });
    } finally { second.close(); }
    assert.deepEqual(rowCounts(resumed), rowCounts(once));
    assert.equal(count(resumed, "SELECT count(*) FROM documents"), 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("sync reports removal progress and keeps committed batches when cancelled", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m41-sync-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "index.db");
  try {
    await mkdir(path.join(root, "excluded"), { recursive: true });
    await writeFile(path.join(root, "keep.dat"), "keep");
    for (let index = 0; index < 1_050; index++) await writeFile(path.join(root, "excluded", `${index}.dat`), "x");
    const store = new IndexStore(databasePath);
    try {
      await sync(root, store);
      assert.equal(count(databasePath, "SELECT count(*) FROM documents"), 1_051);
      await writeFile(path.join(root, ".localdocsearchignore"), "/excluded/\n");

      const controller = new AbortController();
      await assert.rejects(sync(root, store, {
        signal: controller.signal,
        onProgress: update => { if (update.message === "刪除校正" && update.current === 1_000) controller.abort(); },
      }), (error: unknown) => {
        assert.ok(error instanceof OperationCancelledError);
        assert.equal((error.partial as { removed: number }).removed, 1_000);
        return true;
      });
      assert.equal(count(databasePath, "SELECT count(*) FROM documents WHERE path LIKE '%excluded%'"), 50);

      const updates: ProgressUpdate[] = [];
      const report = await sync(root, store, { onProgress: update => { if (update.message === "刪除校正") updates.push(update); } });
      assert.equal(report.removed, 50);
      assert.deepEqual(updates.map(update => [update.current, update.total]), [[0, 50], [50, 50]]);
      assert.equal(count(databasePath, "SELECT count(*) FROM documents WHERE path LIKE '%excluded%'"), 0);
    } finally { store.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
