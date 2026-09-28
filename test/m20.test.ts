import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { DocumentRecord } from "../src/model.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";

function record(root: string, content: string): DocumentRecord {
  return { path: path.join(root, "large.txt"), filename: "large.txt", extension: ".txt", sizeBytes: content.length,
    modifiedAtMs: 1000, status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: "壓縮標題", content, locationKind: "line", locationValue: "第 1 行" }] };
}

test("M20 stores new block text in compressed chunks and preserves exact search in a very large block", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m20-"));
  const database = path.join(temp, "index.db");
  const content = `${"前".repeat(65_535)}跨區段精確命中${"後".repeat(65_535)}`;
  const store = new IndexStore(database);
  try {
    store.upsert(record(temp, content));
    assert.equal(search(store, "跨區段精確命中").length, 1);
    assert.equal(search(store, "前跨區段").length, 1);
    store.close();
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      // SPEC §52.1: a block larger than the chunk target owns one zstd chunk; no blocks／payload tables exist.
      assert.equal((db.prepare("SELECT count(*) AS count FROM document_chunks").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('blocks', 'document_payloads')").get() as { count: number }).count, 0);
    } finally { db.close(); }
  } finally { try { store.close(); } catch {} await rm(temp, { recursive: true, force: true }); }
});

test("M20 migrates a legacy text block atomically and preserves its search result", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m20-legacy-"));
  const database = path.join(temp, "index.db");
  const legacy = new DatabaseSync(database);
  legacy.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, extension TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL, indexed_at_ms INTEGER NOT NULL, status TEXT NOT NULL, error_code TEXT, error_message TEXT);
    CREATE TABLE blocks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, heading TEXT, content TEXT NOT NULL,
      location_kind TEXT NOT NULL, location_value TEXT NOT NULL, UNIQUE(document_id, ordinal));`);
  legacy.prepare("INSERT INTO documents VALUES (1, ?, 'legacy.txt', '.txt', 1, 1, 1, 'indexed', NULL, NULL)").run(path.join(temp, "legacy.txt"));
  legacy.prepare("INSERT INTO blocks VALUES (1, 1, 0, NULL, '舊索引的完整文字', 'line', '第 1 行')").run();
  legacy.close();
  const store = new IndexStore(database);
  try {
    await store.upgrade();
    assert.equal(search(store, "完整文字").length, 1);
    store.close();
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      // The inline text went through the payload docstore into the chunk store (SPEC §52.4).
      assert.equal((db.prepare("SELECT count(*) AS count FROM document_chunks WHERE document_id = 1").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('blocks', 'document_payloads')").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT value FROM metadata WHERE key = 'content_storage_version'").get() as { value: string }).value, "2");
      assert.equal((db.prepare("SELECT value FROM metadata WHERE key = 'chunk_store_version'").get() as { value: string }).value, "1");
    } finally { db.close(); }
  } finally { try { store.close(); } catch {} await rm(temp, { recursive: true, force: true }); }
});
