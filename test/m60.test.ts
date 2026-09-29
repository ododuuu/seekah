import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INDEX_BUSY_CLIENT_MESSAGE,
  INDEX_RECOVERY_REQUIRED_MESSAGE,
  SQLITE_CANTOPEN_DIRTYWAL,
  SQLITE_READONLY_CANTINIT,
  SQLITE_READONLY_ROLLBACK,
} from "../src/index-errors.js";
import { mcpWithStore } from "../src/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { tuiUserErrorMessage } from "../src/tui.js";
import { autoupdateFailureOutput, formatLiveStatus } from "../src/autoupdate.js";
import { IndexBusyError } from "../src/write-lock.js";
import type { LiveStatus } from "../src/autoupdate-control.js";

function sqliteError(message: string, errcode: number, code?: string): Error {
  return Object.assign(new Error(message), { errcode, ...(code ? { code } : {}) });
}

function liveStatus(recentErrors: string[]): LiveStatus {
  return {
    schemaVersion: 1,
    instanceId: "m60",
    pid: 1,
    mode: "background",
    startedAt: "t0",
    lastHeartbeatAt: "t1",
    phase: "idle",
    settings: { debounceMs: 400, reconcileMs: 30_000 },
    ready: true,
    roots: [],
    pendingCount: 0,
    eventCount: 0,
    localUpdateCount: 0,
    rootScanCount: 0,
    subtreeScanCount: 0,
    queuePendingCount: 0,
    queueDegraded: false,
    recentErrors,
  };
}

function mcpText(result: CallToolResult): string {
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return first.text;
}

test("m60: MCP 工具路徑 busy／recovery／一般錯誤三種文字", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m60-mcp-"));
  const databasePath = path.join(temp, "index.db");
  await writeFile(databasePath, "");

  const busy = await mcpWithStore(databasePath, () => {
    throw sqliteError("database is locked", 5, "SQLITE_BUSY");
  }, () => {
    throw sqliteError("database is locked", 5, "SQLITE_BUSY");
  });
  assert.equal(mcpText(busy), INDEX_BUSY_CLIENT_MESSAGE);
  assert.equal(mcpText(busy).includes("database is locked"), false);

  const recovery = await mcpWithStore(databasePath, () => {
    throw sqliteError("attempt to write a readonly database", SQLITE_READONLY_ROLLBACK);
  }, () => {
    throw sqliteError("attempt to write a readonly database", SQLITE_READONLY_ROLLBACK);
  });
  assert.equal(mcpText(recovery), INDEX_RECOVERY_REQUIRED_MESSAGE);

  const generic = await mcpWithStore(databasePath, () => {
    throw new Error("parser exploded");
  }, () => {
    throw new Error("parser exploded");
  });
  assert.equal(mcpText(generic), "MCP_INTERNAL：無法完成本機工具呼叫。");
  assert.equal(mcpText(generic).includes("parser exploded"), false);
});

test("m60: TUI 與 autoupdate 分類函式", () => {
  const busy = sqliteError("database is locked", 5, "SQLITE_BUSY");
  const recovery776 = sqliteError("attempt to write a readonly database", SQLITE_READONLY_ROLLBACK);
  const recovery1288 = sqliteError("unable to open database file", SQLITE_READONLY_CANTINIT);
  const recovery1294 = sqliteError("unable to open database file", SQLITE_CANTOPEN_DIRTYWAL);
  const generic = new Error("parser exploded");

  assert.equal(tuiUserErrorMessage(busy), INDEX_BUSY_CLIENT_MESSAGE);
  assert.equal(tuiUserErrorMessage(new IndexBusyError()), INDEX_BUSY_CLIENT_MESSAGE);
  assert.equal(tuiUserErrorMessage(recovery776), INDEX_RECOVERY_REQUIRED_MESSAGE);
  assert.equal(tuiUserErrorMessage(recovery1288), INDEX_RECOVERY_REQUIRED_MESSAGE);
  assert.equal(tuiUserErrorMessage(recovery1294), INDEX_RECOVERY_REQUIRED_MESSAGE);
  assert.equal(tuiUserErrorMessage(generic), "parser exploded");

  assert.deepEqual(autoupdateFailureOutput(busy), { code: "INDEX_BUSY", message: INDEX_BUSY_CLIENT_MESSAGE });
  assert.deepEqual(autoupdateFailureOutput(recovery776), {
    code: "INDEX_RECOVERY_REQUIRED",
    message: INDEX_RECOVERY_REQUIRED_MESSAGE,
  });
  assert.deepEqual(autoupdateFailureOutput(generic), { code: "AUTOUPDATE_START_FAILED", message: "parser exploded" });

  const rendered = formatLiveStatus(liveStatus([
    "LIVE_UPDATE_FAILED: database is locked",
    "ROOT_SYNC_FAILED: 根目錄同步失敗",
  ]));
  assert.match(rendered, /INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。/u);
  assert.equal(rendered.includes("database is locked"), false);
  assert.match(rendered, /ROOT_SYNC_FAILED: 根目錄同步失敗/u);
});
