import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { DocumentRecord } from "../src/model.js";
import { OperationCancelledError } from "../src/progress.js";
import { createSearchResultSet, search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { clearBlockIndex, createLegacyStore } from "./legacy-index.js";

function document(root: string, name: string, content: string): DocumentRecord {
  return { path: path.join(root, name), filename: name, extension: ".txt", sizeBytes: content.length, modifiedAtMs: 1,
    status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: `${name} 標題`, content, locationKind: "line", locationValue: "第 1 行" }] };
}

/** A pre-0.38.0 index: complete legacy Bloom／postings, no block index yet. */
function makePending(database: string, root: string, count = 2, repeat = 40_000): string[] {
  const store = createLegacyStore(database);
  for (let index = 0; index < count; index++) store.upsert(document(root, `${index}.txt`, `保留的正文 ${index} ${"內容".repeat(repeat)}`));
  store.close();
  clearBlockIndex(database);
  const db = new DatabaseSync(database);
  const payloads = (db.prepare("SELECT hex(payload) AS payload FROM document_payloads ORDER BY document_id, ordinal").all() as { payload: string }[]).map(row => row.payload);
  db.close();
  return payloads;
}

function scalar(db: DatabaseSync, sql: string): unknown {
  return Object.values(db.prepare(sql).get() ?? {})[0];
}

test("0.38.0 read-only status and search never migrate a pre-block index", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m24-readonly-"));
  const database = path.join(temp, "index.db");
  try {
    makePending(database, temp, 1);
    const store = new IndexStore(database, { readOnly: true });
    try {
      const format = store.formatStatus();
      assert.equal(format.needsUpgrade, true);
      assert.equal(format.blockIndexVersion, null);
      assert.equal(format.blockIndexCompletedDocuments, 0);
      assert.equal(format.legacySearchStructures, true);
      assert.equal(format.totalDocuments, 1);
      assert.equal(search(store, "保留的正文 0").length, 1);
      assert.equal(store.lastSearchTrace()?.candidateStrategy, "postings");
    } finally { store.close(); }
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT value FROM metadata WHERE key = 'block_index_version'"), undefined);
      assert.equal(scalar(db, "SELECT count(*) FROM index_migration_documents WHERE version = 'block_index_1'"), 0);
      assert.equal(scalar(db, "SELECT count(*) FROM sqlite_master WHERE name = 'document_blooms'"), 1);
    } finally { db.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("0.38.0 block index migration preserves payload bytes, resumes, then drops legacy structures", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m24-resume-"));
  const database = path.join(temp, "index.db");
  try {
    // More documents than one 256-document migration batch.
    const before = makePending(database, temp, 300, 1_000);
    const first = new IndexStore(database);
    const controller = new AbortController();
    try {
      await assert.rejects(first.upgrade({ signal: controller.signal, onProgress: progress => {
        if (progress.stage === "upgrade" && (progress.current ?? 0) > 0) controller.abort();
      } }), OperationCancelledError);
      // Legacy search still serves the partly migrated index.
      assert.equal(first.formatStatus().needsUpgrade, true);
      assert.equal(search(first, "保留的正文 299").length, 1);
    } finally { first.close(); }
    let db = new DatabaseSync(database, { readOnly: true });
    const committed = Number(scalar(db, "SELECT count(*) FROM index_migration_documents WHERE version = 'block_index_1'"));
    assert.ok(committed > 0 && committed < 300, `committed ${committed}`);
    assert.equal(scalar(db, "SELECT value FROM metadata WHERE key = 'block_index_version'"), undefined);
    db.close();

    const resumed = new IndexStore(database);
    try {
      await resumed.upgrade();
      assert.equal(createSearchResultSet(resumed, "保留的正文").total, 300);
      assert.equal(resumed.lastSearchTrace()?.candidateStrategy, "block-index");
      assert.equal(resumed.formatStatus().legacySearchStructures, false);
    } finally { resumed.close(); }
    db = new DatabaseSync(database, { readOnly: true });
    try {
      const after = (db.prepare("SELECT hex(payload) AS payload FROM document_payloads ORDER BY document_id, ordinal").all() as { payload: string }[]).map(row => row.payload);
      assert.deepEqual(after, before);
      assert.equal(scalar(db, "SELECT value FROM metadata WHERE key = 'block_index_version'"), "1");
      // Completion drops the per-document markers in the same transaction (SPEC §51.2).
      assert.equal(scalar(db, "SELECT count(*) FROM index_migration_documents WHERE version = 'block_index_1'"), 0);
      assert.equal(scalar(db, "SELECT value FROM metadata WHERE key = 'payload_bloom_version'"), undefined);
      assert.equal(scalar(db, "SELECT count(*) FROM sqlite_master WHERE name IN ('document_blooms', 'document_payload_blooms', 'search_unigrams', 'search_trigrams')"), 0);
    } finally { db.close(); }
    // Reopening a migrated index does not recreate the legacy tables.
    new IndexStore(database).close();
    db = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT count(*) FROM sqlite_master WHERE name = 'document_blooms'"), 0);
    } finally { db.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("M23 fix status reads committed data during a real main-database write", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m24-status-"));
  const data = path.join(temp, "data");
  const directory = path.join(data, "LocalDocSearch");
  const database = path.join(directory, "index.db");
  await mkdir(directory, { recursive: true });
  const store = new IndexStore(database);
  store.registerRoot(temp);
  store.upsert(document(temp, "ready.txt", "已提交內容"), temp);
  store.close();
  const code = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    db.prepare("UPDATE documents SET indexed_at_ms = indexed_at_ms + 1").run();
    console.log('READY');
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, database], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const [ready] = await once(child.stdout, "data");
    assert.match(String(ready), /READY/);
    const result = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "status"], {
      env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: data }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.error, undefined, `${result.error?.message ?? ""}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /讀取索引狀態/);
    assert.match(result.stdout, /儲存格式升級：已完成/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("M23 fix reports a hot journal and the next writer recovers it", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m24-recovery-"));
  const data = path.join(temp, "data");
  const directory = path.join(data, "LocalDocSearch");
  const database = path.join(directory, "index.db");
  await mkdir(directory, { recursive: true });
  const store = new IndexStore(database);
  store.registerRoot(temp);
  store.upsert(document(temp, "safe.txt", "提交前內容"), temp);
  store.close();
  const code = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN IMMEDIATE');
    db.prepare("UPDATE documents SET status = 'error'").run();
    const insert = db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)");
    for (let index = 0; index < 2000; index++) insert.run('uncommitted-' + index, 'x'.repeat(4096));
    console.log('READY');
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, database], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(existsSync(`${database}-journal`), true);
    const status = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "status"], {
      env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: data }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(status.error, undefined, `${status.error?.message ?? ""}\nstdout: ${status.stdout}\nstderr: ${status.stderr}`);
    assert.equal(status.status, 3, status.stderr);
    assert.match(status.stdout, /讀取索引狀態/);
    assert.match(status.stderr, /INDEX_RECOVERY_REQUIRED/);
    const recovered = new IndexStore(database);
    try { assert.equal(recovered.counts().indexed, 1); }
    finally { recovered.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(temp, { recursive: true, force: true });
  }
});
