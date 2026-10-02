import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("dist/src/cli.js");

type CliResult = ReturnType<typeof spawnSync>;

function run(env: NodeJS.ProcessEnv, ...args: string[]): CliResult {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

function parseObject(result: CliResult): Record<string, unknown> {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, String(result.stderr));
  return JSON.parse(String(result.stdout)) as Record<string, unknown>;
}

function stdout(result: CliResult): string {
  return String(result.stdout);
}

function stderr(result: CliResult): string {
  return String(result.stderr);
}

function commandError(result: CliResult): string {
  return `${stderr(result)}${stdout(result)}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} 應為物件`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} 應為陣列`);
  return value as unknown[];
}

function required(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) assert.ok(Object.hasOwn(value, key), `${label} 缺少欄位 ${key}`);
}

async function fixture(): Promise<{ temp: string; root: string; env: NodeJS.ProcessEnv }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m104-"));
  const root = path.join(temp, "synthetic-root");
  const dataDir = path.join(temp, "synthetic-data");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "visible.txt"), "m104 visible status JSON\n", "utf8");
  await writeFile(path.join(root, "skipped.txt"), "m104 skipped by user rule\n", "utf8");
  await writeFile(path.join(root, ".localdocsearchignore"), "skipped.txt\n", "utf8");
  return { temp, root, env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir } };
}

test("M104 status --json exposes a versioned complete status contract and keeps human output", async () => {
  const { temp, root, env } = await fixture();
  try {
    const indexed = run(env, "index", root);
    assert.equal(indexed.status, 0, stderr(indexed));

    const human = run(env, "status");
    assert.equal(human.status, 0, stderr(human));
    assert.match(stdout(human), /讀取索引狀態/u);
    assert.match(stdout(human), /逐規則略過：/u);
    assert.match(stdout(human), /既有索引排除清理：/u);
    assert.match(stdout(human), /排除摘要：/u);
    assert.doesNotMatch(stdout(human), /^\s*\{/u);

    const json = parseObject(run(env, "status", "--json"));
    required(json, [
      "schemaVersion", "databasePath", "readOnly", "format", "textUpgrade", "storage", "roots",
      "counts", "documentIssues", "extensionStats", "options",
    ], "status");
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.readOnly, true);
    assert.equal(typeof json.databasePath, "string");

    const format = object(json.format, "status.format");
    required(format, [
      "contentStorageVersion", "payloadBloomVersion", "ngramIndexVersion", "ngramCompletedDocuments",
      "ngramTablesReady", "blockIndexVersion", "blockIndexCompletedDocuments", "chunkStoreVersion",
      "chunkStoreCompletedDocuments", "legacySearchStructures", "needsUpgrade", "completedDocuments",
      "totalDocuments", "mappingIndexReady", "textUpgradePending", "textUpgradeByExtension",
    ], "status.format");
    const textUpgrade = object(json.textUpgrade, "status.textUpgrade");
    required(textUpgrade, ["pending", "byExtension", "note"], "status.textUpgrade");
    assert.equal(typeof textUpgrade.note, "string");

    const storage = object(json.storage, "status.storage");
    required(storage, ["files", "totalBytes", "incomplete", "approximate"], "status.storage");
    const files = array(storage.files, "status.storage.files");
    assert.ok(files.length > 0);
    required(object(files[0], "status.storage.files[0]"), ["label", "suffix", "path", "bytes", "missing", "unknown"], "status.storage.files[0]");

    const roots = array(json.roots, "status.roots");
    assert.equal(roots.length, 1);
    const rootStatus = object(roots[0], "status.roots[0]");
    required(rootStatus, ["path", "lastAttemptedSync", "lastSuccessfulSync", "lastSyncComplete", "recentSync", "exclusion"], "status.roots[0]");
    const recentSync = object(rootStatus.recentSync, "status.roots[0].recentSync");
    required(recentSync, ["summary", "diagnostics", "errors", "notices"], "status.roots[0].recentSync");
    for (const key of ["diagnostics", "errors", "notices"]) {
      const list = object(recentSync[key], `status.roots[0].recentSync.${key}`);
      required(list, ["items", "total", "truncated"], `status.roots[0].recentSync.${key}`);
      array(list.items, `status.roots[0].recentSync.${key}.items`);
    }
    const exclusion = object(rootStatus.exclusion, "status.roots[0].exclusion");
    required(exclusion, ["policy", "summary"], "status.roots[0].exclusion");
    required(object(exclusion.policy, "status.roots[0].exclusion.policy"), ["root", "rules", "ignoreFiles"], "status.roots[0].exclusion.policy");
    assert.equal(typeof exclusion.summary, "string");

    const documentIssues = object(json.documentIssues, "status.documentIssues");
    required(documentIssues, ["total", "items"], "status.documentIssues");
    array(documentIssues.items, "status.documentIssues.items");
    const extensionStats = object(json.extensionStats, "status.extensionStats");
    required(extensionStats, ["included", "items"], "status.extensionStats");
    assert.equal(extensionStats.included, false);
    assert.deepEqual(extensionStats.items, []);
    required(object(json.options, "status.options"), ["issues", "types"], "status.options");

    const detailed = parseObject(run(env, "status", "--json", "--issues", "--types"));
    const detailedOptions = object(detailed.options, "status.options");
    assert.equal(detailedOptions.issues, true);
    assert.equal(detailedOptions.types, true);
    const detailedStats = object(detailed.extensionStats, "status.extensionStats");
    assert.equal(detailedStats.included, true);
    assert.ok(array(detailedStats.items, "status.extensionStats.items").length > 0);
    const summary = object(object(array(detailed.roots, "status.roots")[0], "status.roots[0]").recentSync, "status.roots[0].recentSync").summary;
    assert.ok(summary !== null && typeof summary === "object", "應保留最近同步摘要");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("M104 autoupdate status --json exposes the LiveStatus fields and stops its synthetic daemon", async () => {
  const { temp, root, env } = await fixture();
  let started = false;
  try {
    const indexed = run(env, "index", root);
    assert.equal(indexed.status, 0, stderr(indexed));

    const start = run(env, "autoupdate", "start", "--debounce", "200", "--reconcile", "900000");
    assert.equal(start.status, 0, commandError(start));
    started = true;

    const human = run(env, "autoupdate", "status");
    assert.equal(human.status, 0, stderr(human));
    assert.match(stdout(human), /自動更新：/u);
    assert.doesNotMatch(stdout(human), /^\s*\{/u);

    const json = parseObject(run(env, "autoupdate", "status", "--json"));
    required(json, [
      "schemaVersion", "instanceId", "pid", "mode", "startedAt", "lastHeartbeatAt", "phase", "settings",
      "startupCatchup", "ready", "roots", "pendingCount", "eventCount", "localUpdateCount", "rootScanCount",
      "subtreeScanCount", "queuePendingCount", "queueDegraded", "recentErrors", "stale",
    ], "autoupdate status");
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.mode, "background");
    assert.equal(typeof json.instanceId, "string");
    assert.equal(typeof json.pid, "number");
    assert.equal(json.stale, false);
    for (const key of ["emptyFilenameEventCount", "uncertainRescanCount", "uncertainRescanStateCount"]) {
      if (Object.hasOwn(json, key)) assert.equal(typeof json[key], "number", `autoupdate.${key} 應為數字`);
    }
    required(object(json.settings, "autoupdate.settings"), ["debounceMs", "reconcileMs"], "autoupdate.settings");
    required(object(json.startupCatchup, "autoupdate.startupCatchup"), ["mode", "state", "roots"], "autoupdate.startupCatchup");
    const liveRoots = array(json.roots, "autoupdate.roots");
    const liveRoot = object(liveRoots[0], "autoupdate.roots[0]");
    if (Object.hasOwn(liveRoot, "lastTiming")) object(liveRoot.lastTiming, "autoupdate.roots[0].lastTiming");
    if (Object.hasOwn(liveRoot, "lastTimings")) array(liveRoot.lastTimings, "autoupdate.roots[0].lastTimings");
    if (Object.hasOwn(json, "watcherErrorCounts")) object(json.watcherErrorCounts, "autoupdate.watcherErrorCounts");
    array(json.recentErrors, "autoupdate.recentErrors");
  } finally {
    if (started) {
      const stopped = run(env, "autoupdate", "stop");
      assert.equal(stopped.status, 0, commandError(stopped));
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("M104 JSON status failures remain versioned", async () => {
  const { temp, env } = await fixture();
  try {
    const status = run(env, "status", "--json");
    assert.equal(status.status, 3, commandError(status));
    const statusJson = JSON.parse(stdout(status)) as Record<string, unknown>;
    assert.equal(statusJson.schemaVersion, 1);
    assert.deepEqual(statusJson.error, {
      code: "INDEX_NOT_FOUND",
      message: "索引尚未建立；請先執行 docsearch index <root>。",
    });

    const autoupdate = run(env, "autoupdate", "status", "--json");
    assert.equal(autoupdate.status, 3, commandError(autoupdate));
    const autoupdateJson = JSON.parse(stdout(autoupdate)) as Record<string, unknown>;
    assert.equal(autoupdateJson.schemaVersion, 1);
    assert.equal((object(autoupdateJson.error, "autoupdate.error").code), "AUTOUPDATE_NOT_RUNNING");
    assert.equal(typeof (object(autoupdateJson.error, "autoupdate.error").message), "string");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
