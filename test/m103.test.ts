import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatLiveDiagnosis } from "../src/autoupdate.js";
import { AutoupdateError, type LiveStatus } from "../src/autoupdate-control.js";

const cli = path.resolve("dist/src/cli.js");

function syntheticStatus(): LiveStatus {
  const lastTimings = Array.from({ length: 32 }, (_, index) => ({
    at: `2026-10-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    eventToScheduleMs: index + 1,
    eventToSearchMs: (index + 1) * 10,
    stableWaitMs: 100 + index,
    enumerateMs: 2 + index,
    lockMs: index % 3,
    commitMs: 5 + index,
  }));
  return {
    schemaVersion: 1,
    instanceId: "m103-instance-secret",
    pid: 1234,
    mode: "background",
    startedAt: "2026-10-02T00:00:00.000Z",
    lastHeartbeatAt: "2026-10-02T00:00:31.000Z",
    phase: "idle",
    settings: { debounceMs: 200, reconcileMs: 900_000 },
    ready: true,
    roots: [{
      path: "C:\\Users\\synthetic\\m103-secret-root",
      watch: "degraded",
      pending: 2,
      scopeMode: "split",
      handles: 3,
      degradedSubdirectories: [{
        path: "C:\\Users\\synthetic\\m103-secret-root\\private\\deep",
        reason: "m103-file-content-secret",
      }],
      emptyFilenameEventCount: 4,
      uncertainRescanCount: 2,
      uncertainRescanStateCount: 1,
      lastTiming: lastTimings.at(-1)!,
      lastTimings,
    },
    {
      path: "C:\\Users\\synthetic\\m103-other-root",
      watch: "active",
      pending: 0,
    }],
    pendingCount: 2,
    eventCount: 40,
    excludedEventCount: 3,
    emptyFilenameEventCount: 4,
    uncertainRescanCount: 2,
    uncertainRescanStateCount: 1,
    localUpdateCount: 30,
    rootScanCount: 1,
    subtreeScanCount: 2,
    queuePendingCount: 2,
    queueDegraded: false,
    recentErrors: ["WATCH_SCOPE_ERROR: m103-file-content-secret"],
    watcherErrorCounts: { WATCH_SCOPE_ERROR: 3, WATCH_ERROR: 1 },
  };
}

test("M103 diagnose formatting is bounded, statistically useful, and path/content safe", () => {
  const status = syntheticStatus();
  const output = formatLiveDiagnosis(status);
  assert.match(output, /Seekah autoupdate diagnose/u);
  assert.match(output, /最近批次上限：20（daemon 每根最多 32 筆）/u);
  assert.match(output, /最近 lastTiming：20\/20/u);
  assert.match(output, /事件→可搜尋延遲：樣本 32；p50 160 ms；p95 310 ms；最大 320 ms/u);
  assert.match(output, /  事件→可搜尋延遲：樣本 20；p50 220 ms；p95 310 ms；最大 320 ms/u);
  assert.match(output, /watcher 錯誤：WATCH_ERROR=1、WATCH_SCOPE_ERROR=3/u);
  assert.match(output, /降級子目錄=1/u);
  assert.match(output, /根目錄 R1：深度=0；監看=degraded；降級子目錄=1/u);
  assert.match(output, /根目錄 R2：深度=0；監看=active；降級子目錄=0/u);
  assert.doesNotMatch(output, /C:\\Users\\synthetic\\m103-secret-root/u);
  assert.doesNotMatch(output, /m103-file-content-secret/u);
  assert.doesNotMatch(output, /instance-secret/u);
  assert.match(output, /降級摘要：深度=2/u);
  assert.doesNotMatch(output, /[0-9a-f]{12,}/iu);
  assert.doesNotMatch(output, /[\\/](?=[A-Za-z_~.])[A-Za-z0-9_.~-]+/u);
  const timingLines = output.split("\n").filter(line => /^    2026-/u.test(line));
  assert.equal(timingLines.length, 20);

  const limited = formatLiveDiagnosis(status, 3);
  assert.match(limited, /最近 lastTiming：3\/3/u);
  assert.equal(limited.split("\n").filter(line => /^    2026-/u.test(line)).length, 3);
  assert.throws(() => formatLiveDiagnosis(status, 33), (error: unknown) => error instanceof AutoupdateError && error.code === "AUTOUPDATE_DIAGNOSE_LIMIT_INVALID");
});

test("M103 autoupdate diagnose is live-only and uses an isolated synthetic daemon", { timeout: 90_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m103-diagnose-"));
  const dataDir = path.join(temp, "data");
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "synthetic.txt"), "m103-synthetic-content");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir };
  let daemonStarted = false;
  try {
    const noDaemon = spawnSync(process.execPath, [cli, "autoupdate", "diagnose", "--data-dir", dataDir], { encoding: "utf8", env, timeout: 10_000 });
    assert.equal(noDaemon.status, 3, noDaemon.stderr);
    assert.match(noDaemon.stderr, /AUTOUPDATE_NOT_RUNNING/u);
    assert.equal(existsSync(path.join(dataDir, "LocalDocSearch", "autoupdate.json")), false);

    const invalidLimit = spawnSync(process.execPath, [cli, "autoupdate", "diagnose", "--limit", "33", "--data-dir", dataDir], { encoding: "utf8", env, timeout: 10_000 });
    assert.equal(invalidLimit.status, 2, invalidLimit.stderr);
    assert.match(invalidLimit.stderr, /AUTOUPDATE_DIAGNOSE_LIMIT_INVALID/u);

    const indexed = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(indexed.status, 0, indexed.stderr);
    const started = spawnSync(process.execPath, [cli, "autoupdate", "start", "--debounce", "200", "--reconcile", "900000", "--data-dir", dataDir], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    daemonStarted = true;

    const liveEventToken = "m103-live-event-token";
    await writeFile(path.join(root, "live-event.txt"), liveEventToken);
    let searchable = false;
    const searchDeadline = Date.now() + 15_000;
    while (Date.now() < searchDeadline) {
      const result = spawnSync(process.execPath, [cli, "search", liveEventToken, "--limit", "5"], { encoding: "utf8", env, timeout: 5_000 });
      if (result.status === 0 && result.stdout.includes(liveEventToken)) {
        searchable = true;
        break;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    assert.equal(searchable, true, "synthetic live event should become searchable before diagnose");
    const diagnosis = spawnSync(process.execPath, [cli, "autoupdate", "diagnose", "--limit", "1", "--data-dir", dataDir], { encoding: "utf8", env, timeout: 10_000 });
    assert.equal(diagnosis.status, 0, diagnosis.stderr);
    assert.match(diagnosis.stdout, /Seekah autoupdate diagnose/u);
    assert.match(diagnosis.stdout, /最近批次上限：1/u);
    assert.match(diagnosis.stdout, /事件→可搜尋延遲：樣本 [1-9]/u);
    assert.doesNotMatch(diagnosis.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(diagnosis.stdout, /m103-synthetic-content/u);
    assert.match(diagnosis.stdout, /根目錄 R1：深度=0/u);
    assert.doesNotMatch(diagnosis.stdout, /[0-9a-f]{12,}/iu);
    assert.doesNotMatch(diagnosis.stdout, /[\\/](?=[A-Za-z_~.])[A-Za-z0-9_.~-]+/u);
  } finally {
    if (daemonStarted) {
      const stopped = spawnSync(process.execPath, [cli, "autoupdate", "stop", "--data-dir", dataDir], { encoding: "utf8", env, timeout: 30_000 });
      assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    }
    await rm(temp, { recursive: true, force: true });
  }
});
