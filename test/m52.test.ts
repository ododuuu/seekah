import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { IndexStore } from "../src/store.js";

const LARGE_DOCUMENT_COUNT = 320_000;
const MAX_READ_ONLY_OPEN_MS = 400;

function scalar(database: string, sql: string, ...parameters: (string | number)[]): unknown {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return Object.values(db.prepare(sql).get(...parameters) ?? {})[0]; }
  finally { db.close(); }
}

function document(root: string, filename: string): DocumentRecord {
  return {
    path: path.join(root, filename), filename, extension: ".txt", sizeBytes: 6, modifiedAtMs: 1,
    status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: null, content: "needle", locationKind: "line", locationValue: "第 1 行" }],
  };
}

async function createLargeDatabase(database: string, keepFlag: boolean): Promise<void> {
  const store = new IndexStore(database);
  store.close();
  const db = new DatabaseSync(database);
  try {
    db.exec("BEGIN");
    const insert = db.prepare(`INSERT INTO documents
      (path, filename, extension, size_bytes, modified_at_ms, indexed_at_ms, status, error_code, error_message, parse_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < LARGE_DOCUMENT_COUNT; index++) {
      const filename = `doc-${String(index).padStart(6, "0")}.txt`;
      insert.run(path.join(path.dirname(database), filename), filename, ".txt", 1, 1, 1, "indexed", null, null, null);
    }
    if (keepFlag) db.exec("INSERT OR REPLACE INTO metadata(key, value) VALUES ('path_order', 'native')");
    else db.exec("DELETE FROM metadata WHERE key = 'path_order'");
    db.exec("COMMIT");
  } finally { db.close(); }
}

test("path_order persists utf16 on supplementary upsert and never downgrades after deletion", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m52-path-order-"));
  const database = path.join(temp, "index.db");
  const filename = "order-😀.txt";
  try {
    const store = new IndexStore(database);
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "native");
    store.upsert(document(temp, filename));
    store.close();
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
    const reopened = new IndexStore(database);
    try { assert.equal(reopened.removeDocument(path.join(temp, filename)), true); }
    finally { reopened.close(); }
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("writable opening backfills path_order once for an older index", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m52-path-order-legacy-"));
  const database = path.join(temp, "index.db");
  try {
    const initial = new IndexStore(database);
    initial.upsert(document(temp, "legacy-😀.txt"));
    initial.close();
    const db = new DatabaseSync(database);
    db.exec("DELETE FROM metadata WHERE key = 'path_order'");
    db.close();
    const upgraded = new IndexStore(database);
    upgraded.close();
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("read-only opening without path_order does not scan a 320k-document table", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m52-path-order-open-"));
  const database = path.join(temp, "index.db");
  try {
    await createLargeDatabase(database, false);
    const started = performance.now();
    const store = new IndexStore(database, { readOnly: true });
    const elapsed = performance.now() - started;
    store.close();
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), undefined);
    assert.ok(elapsed < MAX_READ_ONLY_OPEN_MS, `read-only open took ${elapsed.toFixed(1)} ms`);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
