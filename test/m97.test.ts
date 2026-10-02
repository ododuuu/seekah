import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { classifyIndexClientError, describeIndexClientError } from "../src/index-errors.js";

function sqliteError(fields: { errcode?: number; code?: string }): Error {
  return Object.assign(new Error("synthetic SQLite error"), fields);
}

test("m97: SQLITE_BUSY_* 子碼與 SQLITE_LOCKED 都分類為 INDEX_BUSY", () => {
  const cases: Array<[string, Error]> = [
    ["SQLITE_BUSY_SNAPSHOT numeric extended code", sqliteError({ errcode: 517 })],
    ["SQLITE_BUSY_TIMEOUT string code", sqliteError({ code: "SQLITE_BUSY_TIMEOUT" })],
    ["SQLITE_LOCKED_SHAREDCACHE numeric extended code", sqliteError({ errcode: 262 })],
    ["SQLITE_LOCKED_VTAB string code", sqliteError({ code: "SQLITE_LOCKED_VTAB" })],
  ];
  for (const [label, error] of cases) {
    assert.equal(classifyIndexClientError(error), "busy", label);
    assert.equal(describeIndexClientError(error), INDEX_BUSY_MESSAGE, label);
  }
});


const cli = path.resolve("dist/src/cli.js");
const INDEX_BUSY_MESSAGE = "INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。";

test("m97: compact 遇主庫 busy 回固定 INDEX_BUSY 且不洩漏 SQLite 原文", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m97-compact-busy-"));
  const root = path.join(temp, "docs");
  const dataDir = path.join(temp, "data");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  let holder: DatabaseSync | undefined;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "note.txt"), "m97 compact busy");
    const indexed = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(indexed.status, 0, indexed.stderr);

    const databasePath = path.join(dataDir, "LocalDocSearch", "index.db");
    holder = new DatabaseSync(databasePath);
    holder.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");

    const compact = spawnSync(process.execPath, [cli, "compact"], { encoding: "utf8", env, timeout: 10_000 });
    assert.equal(compact.status, 3, `${compact.error?.message ?? ""}\nstdout=${compact.stdout}\nstderr=${compact.stderr}`);
    assert.equal(compact.stderr.startsWith(INDEX_BUSY_MESSAGE), true);
    assert.equal(compact.stderr.includes("database is locked"), false);
    assert.equal(compact.stderr.includes("SQLITE_BUSY"), false);
  } finally {
    if (holder) {
      try { holder.exec("ROLLBACK"); } catch { /* 測試失敗清理 */ }
      holder.close();
    }
    await rm(temp, { recursive: true, force: true });
  }
});
