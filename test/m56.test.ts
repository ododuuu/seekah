import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { isSqliteBusy } from "../src/write-lock.js";
import {
  IndexStore,
  MAIN_INITIALIZE_BUSY_TIMEOUT_MS,
  MAIN_WAL_CHECKPOINT_THRESHOLD_BYTES,
  MAIN_WAL_JOURNAL_SIZE_LIMIT_BYTES,
  MAIN_WRITE_BUSY_TIMEOUT_MS,
} from "../src/store.js";

function document(root: string, name: string, content: string, modifiedAtMs: number): DocumentRecord {
  return {
    path: path.join(root, name), filename: name, extension: ".txt", sizeBytes: content.length, modifiedAtMs,
    status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: null, content, locationKind: "line", locationValue: "第 1 行" }],
  };
}

function pragmaValue(db: DatabaseSync, sql: string): string {
  const row = db.prepare(sql).get();
  if (!row || typeof row !== "object") return "";
  return String(Object.values(row)[0] ?? "").toLowerCase();
}

function setRollbackJournal(database: string): void {
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  } finally { db.close(); }
}

async function createIndexedDatabase(prefix: string): Promise<{ temp: string; root: string; database: string; file: string }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, "root");
  const database = path.join(temp, "index.db");
  const file = path.join(root, "note.txt");
  await mkdir(root, { recursive: true });
  await writeFile(file, "初始內容");
  const store = new IndexStore(database);
  try {
    store.registerRoot(root);
    store.upsert(document(root, "note.txt", "初始內容", 1), root);
  } finally { store.close(); }
  return { temp, root, database, file };
}

test("m56: WAL 讓 reader 保留舊快照且 Seekah writer 可提交新版本", async () => {
  const fixture = await createIndexedDatabase("seekah-m56-snapshot-");
  const store = new IndexStore(fixture.database);
  const reader = new DatabaseSync(fixture.database);
  try {
    reader.exec("BEGIN");
    assert.equal(pragmaValue(reader, "PRAGMA journal_mode"), "wal");
    assert.equal(pragmaValue(reader, `SELECT modified_at_ms FROM documents WHERE path = '${fixture.file.replaceAll("'", "''")}'`), "1");
    store.upsert(document(fixture.root, "note.txt", "更新內容", 2), fixture.root);
    assert.equal(pragmaValue(reader, `SELECT modified_at_ms FROM documents WHERE path = '${fixture.file.replaceAll("'", "''")}'`), "1");
    reader.exec("COMMIT");
    const fresh = new IndexStore(fixture.database, { readOnly: true });
    try { assert.equal(fresh.getDocument(fixture.file)?.modified_at_ms, 2); }
    finally { fresh.close(); }
  } finally {
    try { reader.exec("ROLLBACK"); } catch { /* 已提交 */ }
    reader.close();
    store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("m56: writable constructor uses the short initialization busy bound", async () => {
  const fixture = await createIndexedDatabase("seekah-m56-init-bound-");
  setRollbackJournal(fixture.database);
  const blocker = new DatabaseSync(fixture.database);
  blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let contended: IndexStore | undefined;
  const warnings: string[] = [];
  try {
    const started = Date.now();
    contended = new IndexStore(fixture.database, { onWarning: message => warnings.push(message) });
    const elapsed = Date.now() - started;
    assert.ok(elapsed <= MAIN_INITIALIZE_BUSY_TIMEOUT_MS + 400, `constructor 等待 ${elapsed} ms 超過短初始化上限`);
    assert.ok(warnings.some(message => message.includes("WAL")));
  } finally {
    contended?.close();
    blocker.exec("ROLLBACK");
    blocker.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("m56: 舊 rollback index 轉 WAL，切換競爭失敗仍可開庫且下次重試", async () => {
  const fixture = await createIndexedDatabase("seekah-m56-switch-");
  setRollbackJournal(fixture.database);
  const before = new DatabaseSync(fixture.database);
  try { assert.equal(pragmaValue(before, "PRAGMA journal_mode"), "delete"); }
  finally { before.close(); }

  const first = new IndexStore(fixture.database);
  first.close();
  const switched = new DatabaseSync(fixture.database);
  try { assert.equal(pragmaValue(switched, "PRAGMA journal_mode"), "wal"); }
  finally { switched.close(); }

  setRollbackJournal(fixture.database);
  const blocker = new DatabaseSync(fixture.database);
  blocker.exec("PRAGMA busy_timeout=0; BEGIN; SELECT COUNT(*) FROM documents");
  const warnings: string[] = [];
  let contended: IndexStore | undefined;
  try {
    contended = new IndexStore(fixture.database, { onWarning: message => warnings.push(message) });
    assert.ok(warnings.some(message => message.includes("WAL")), "切換延後必須留下診斷");
  } finally {
    contended?.close();
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  const afterFailure = new DatabaseSync(fixture.database);
  try { assert.equal(pragmaValue(afterFailure, "PRAGMA journal_mode"), "delete"); }
  finally { afterFailure.close(); }

  const retry = new IndexStore(fixture.database);
  retry.close();
  const afterRetry = new DatabaseSync(fixture.database);
  try { assert.equal(pragmaValue(afterRetry, "PRAGMA journal_mode"), "wal"); }
  finally {
    afterRetry.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("m56: 唯讀 WAL 索引在 sidecar 不存在且資料夾可寫時仍可開啟", async () => {
  const fixture = await createIndexedDatabase("seekah-m56-readonly-");
  const writer = new IndexStore(fixture.database);
  writer.close();
  await rm(`${fixture.database}-wal`, { force: true });
  await rm(`${fixture.database}-shm`, { force: true });
  assert.equal(existsSync(`${fixture.database}-wal`), false);
  assert.equal(existsSync(`${fixture.database}-shm`), false);
  const readonly = new IndexStore(fixture.database, { readOnly: true });
  try { assert.equal(readonly.getDocument(fixture.file)?.filename, "note.txt"); }
  finally {
    readonly.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("m56: 主庫 writer busy 等待有上限並回傳 SQLITE_BUSY", async () => {
  const fixture = await createIndexedDatabase("seekah-m56-bounded-");
  const store = new IndexStore(fixture.database);
  const holder = new DatabaseSync(fixture.database);
  try {
    holder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    const started = Date.now();
    let captured: unknown;
    assert.throws(() => store.upsert(document(fixture.root, "note.txt", "被鎖住的更新", 3), fixture.root), error => {
      captured = error;
      return isSqliteBusy(error);
    });
    assert.ok(captured);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= MAIN_WRITE_BUSY_TIMEOUT_MS - 250, `busy 僅等待 ${elapsed} ms，未達寫入等待下限`);
    assert.ok(elapsed <= MAIN_WRITE_BUSY_TIMEOUT_MS + 1_000, `busy 等待 ${elapsed} ms 超過上限容許範圍`);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("m56: 大型 WAL 寫入後 TRUNCATE checkpoint 將 sidecar 控制在上限內", async () => {
  const fixture = await createIndexedDatabase("seekah-m56-size-");
  const store = new IndexStore(fixture.database);
  const raw = new DatabaseSync(fixture.database);
  try {
    raw.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_size_probe(id INTEGER PRIMARY KEY, payload BLOB); BEGIN IMMEDIATE");
    const insert = raw.prepare("INSERT INTO wal_size_probe(id, payload) VALUES (?, ?)");
    for (let index = 0; index < 180; index++) insert.run(index, Buffer.alloc(32 * 1024, index % 251));
    raw.exec("COMMIT");
    const walPath = `${fixture.database}-wal`;
    assert.ok(existsSync(walPath));
    assert.ok(statSync(walPath).size > MAIN_WAL_JOURNAL_SIZE_LIMIT_BYTES);
    store.checkpointWal({ forceTruncate: true });
    const remaining = existsSync(walPath) ? statSync(walPath).size : 0;
    assert.ok(remaining <= MAIN_WAL_JOURNAL_SIZE_LIMIT_BYTES);
  } finally {
    raw.close();
    store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("m56: 長讀取快照下實際 upsert 的 WAL 可暫時成長，釋放後可回收", { timeout: 120_000 }, async () => {
  const fixture = await createIndexedDatabase("seekah-m56-threshold-");
  const store = new IndexStore(fixture.database);
  const reader = new DatabaseSync(fixture.database);
  try {
    const internal = Reflect.get(store, "db") as DatabaseSync;
    internal.exec("PRAGMA wal_autocheckpoint=0");
    reader.exec("BEGIN");
    reader.prepare("SELECT modified_at_ms FROM documents WHERE path = ?").get(fixture.file);
    let maximum = 0;
    for (let index = 0; index < 56; index++) {
      const content = `${String(index).padStart(8, "0")}${randomBytes(512 * 1024).toString("base64")}`;
      store.upsert(document(fixture.root, "note.txt", content, index + 2), fixture.root);
      store.checkpointWal();
      const walPath = `${fixture.database}-wal`;
      maximum = Math.max(maximum, existsSync(walPath) ? statSync(walPath).size : 0);
    }
    assert.ok(maximum > MAIN_WAL_CHECKPOINT_THRESHOLD_BYTES, `長讀取快照下 WAL 未超過門檻：${maximum} bytes`);
    reader.exec("ROLLBACK");
    reader.close();
    store.checkpointWal({ forceTruncate: true });
    const walPath = `${fixture.database}-wal`;
    const remaining = existsSync(walPath) ? statSync(walPath).size : 0;
    assert.ok(remaining <= MAIN_WAL_JOURNAL_SIZE_LIMIT_BYTES, `釋放讀取快照後 WAL 仍為 ${remaining} bytes`);
  } finally {
    try { reader.exec("ROLLBACK"); } catch { /* 已提交或已關閉 */ }
    try { reader.close(); } catch { /* 已關閉 */ }
    store.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});
