import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveUpdateEngine } from "../src/live-update.js";
import { LiveWorkQueue } from "../src/live-queue.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { workbenchHtml } from "../src/workbench-app.js";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("M77 等待 startup catchup 狀態逾時。");
}

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const liveSource = readFileSync(path.resolve("src/live-update.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function section(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0, `找不到區段起點：${start}`);
  assert.ok(endAt > startAt, `找不到區段終點：${end}`);
  return source.slice(startAt, endAt);
}

function assertStartupCatchupContract(html: string): void {
  for (const mode of ["ask", "auto", "off"]) assert.match(html, new RegExp(`"${mode}"`, "u"));
  for (const id of [
    "settings-startup-catchup-mode", "startup-catchup-banner", "startup-catchup-start", "startup-catchup-later",
    "startup-catchup-skip", "startup-catchup-disable", "startup-catchup-status", "startup-catchup-warning",
  ]) assert.match(html, new RegExp(id, "u"), `缺少 ${id}`);
  for (const label of ["立即補捉", "稍後提醒", "略過本次", "關閉開機補捉"]) assert.match(html, new RegExp(label, "u"));
  assert.match(html, /\/api\/autoupdate\/catchup/u);
  assert.match(html, /startupCatchupMode/u);
  assert.match(html, /String\.fromCharCode\(92\)/u);
  assert.match(html, /大量檔案、耗用磁碟與 CPU/u);
  assert.match(html, /statusRevision/u);
  assert.match(html, /preserveSettingResponses\(indexStatus, revision\)/u);
  assert.match(html, /state\.startupCatchupActionFailed = true/u);
  assert.match(html, /state\.startupCatchupMode = previous/u);
  assert.match(html, /aria-busy/u);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/u);
}

test("M77 workbench 提供 ask／auto／off、四個鍵盤動作與失敗回復契約", () => {
  const html = workbenchHtml("m77-contract");
  assertStartupCatchupContract(html);
  const refresh = section(html, "async function refreshStatus()", "async function runIndex(");
  assert.doesNotMatch(refresh, /performStartupCatchupAction\("start"\)/u, "狀態刷新不可偷偷開始補捉。" );
  const saveMode = section(html, "async function saveStartupCatchupMode(mode)", "async function performStartupCatchupAction(action)");
  assert.match(saveMode, /state\.startupCatchupSaving = true/u);
  assert.match(saveMode, /state\.startupCatchupMode = previous/u);
  assert.match(saveMode, /syncAutoupdateControls\(\)/u);
  const warning = section(workbenchSource, "function startupCatchupHasVolumeRoot", "function applyAutoupdateResponse");
  assert.match(warning, /root\.path/u);
  const preserve = section(workbenchSource, "function preserveSettingResponses", "function validStartupCatchupMode");
  assert.match(preserve, /startupCatchupMode/u);
});

test("M77 live queue 只略過 downtime gap，保留明確路徑事件", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m77-queue-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const databasePath = path.join(temp, "index.db");
  const root = path.join(temp, "資料根目錄");
  const first = new LiveWorkQueue(databasePath);
  first.close();
  const queue = new LiveWorkQueue(databasePath);
  try {
    queue.markDowntimeGap(root);
    queue.acceptPath(root, "明確事件.txt");
    assert.equal(queue.hasDowntimeGap(root), true);
    queue.skipDowntimeGap(root);
    assert.equal(queue.hasDowntimeGap(root), false);
    assert.deepEqual(queue.listPaths(root).map(item => item.relPath), ["明確事件.txt"]);
  } finally {
    queue.close();
  }
});

test("M77 startupCatchupMode 舊 metadata 預設 auto 並可持久化 ask／off", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m77-store-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const databasePath = path.join(temp, "index.db");
  const initial = new IndexStore(databasePath);
  assert.equal(initial.startupCatchupMode(), "auto");
  initial.setStartupCatchupMode("ask");
  initial.close();
  const ask = new IndexStore(databasePath);
  assert.equal(ask.startupCatchupMode(), "ask");
  ask.setStartupCatchupMode("off");
  ask.close();
  const off = new IndexStore(databasePath);
  assert.equal(off.startupCatchupMode(), "off");
  off.close();
});

test("M77 daemon ask／auto／off 狀態與 off 明確事件行為", async t => {
  for (const mode of ["ask", "auto", "off"] as const) {
    const temp = await mkdtemp(path.join(os.tmpdir(), `lds-m77-${mode}-`));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const root = path.join(temp, "資料根目錄");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "seed.txt"), "M77_SEED\n");
    const store = new IndexStore(path.join(temp, "index.db"));
    const stop = deferred();
    let queue: LiveWorkQueue | undefined;
    let running: Promise<number> | undefined;
    try {
      await sync(root, store);
      const initialQueue = new LiveWorkQueue(store.databasePath);
      initialQueue.close();
      queue = new LiveWorkQueue(store.databasePath);
      const watcher = new EventEmitter() as EventEmitter & { close(): void };
      watcher.close = () => {};
      const watch = ((_watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
        const callback = (typeof opts === "function" ? opts : listener) as ((event: fs.WatchEventType, filename: string | null) => void) | undefined;
        watcher.on("watch-event", (event, filename) => callback?.(event as fs.WatchEventType, filename as string | null));
        return watcher;
      }) as unknown as typeof fs.watch;
      const ready = deferred();
      const engine = new LiveUpdateEngine(store, [store.roots()[0]!], {
        mode: "background",
        debounceMs: 200,
        reconcileMs: 900_000,
        syncNow: false,
        startupCatchupMode: mode,
        sleep: async () => {},
        watch,
      }, {
        write: line => { if (line.startsWith("監看中：")) ready.resolve(); },
        waitForStop: () => stop.promise,
      });
      running = engine.run();
      await ready.promise;
      if (mode === "ask") {
        assert.equal(engine.snapshot().startupCatchup?.state, "pending");
        assert.equal(queue.hasDowntimeGap(root), true);
        const started = engine.startupCatchupAction("start");
        assert.ok(started.state === "running" || started.state === "complete");
        await waitUntil(() => engine.snapshot().startupCatchup?.state === "complete");
        assert.equal(queue.hasDowntimeGap(root), false);
      } else if (mode === "auto") {
        await waitUntil(() => engine.snapshot().startupCatchup?.state === "complete");
        assert.equal(queue.hasDowntimeGap(root), false);
      } else {
        assert.equal(engine.snapshot().startupCatchup?.state, "skipped");
        assert.equal(queue.hasDowntimeGap(root), false);
        await writeFile(path.join(root, "off-explicit.txt"), "M77_OFF_EXPLICIT\n");
        watcher.emit("watch-event", "change", "off-explicit.txt");
        await waitUntil(() => search(store, "M77_OFF_EXPLICIT").length === 1);
      }
    } finally {
      stop.resolve();
      if (running) await running;
      queue?.close();
      store.close();
    }
  }
});

test("M77 反向移除四動作、策略選擇或 catchup API 時契約會失敗", () => {
  const html = workbenchHtml("m77-reverse");
  const withoutAction = html.replaceAll("startup-catchup-start", "removed-startup-action");
  assert.throws(() => assertStartupCatchupContract(withoutAction));
  const withoutApi = html.replaceAll("/api/autoupdate/catchup", "/api/autoupdate/removed");
  assert.throws(() => assertStartupCatchupContract(withoutApi));
  const withoutRestore = html.replace("state.startupCatchupMode = previous;", "state.startupCatchupMode = state.startupCatchupMode;");
  assert.throws(() => assertStartupCatchupContract(withoutRestore));
});

test("M77 live engine、smoke 與文件契約保留三態行為入口", () => {
  assert.match(liveSource, /startupCatchupAction\(action:/u);
  assert.match(liveSource, /startupCatchupMode === "auto"/u);
  assert.match(liveSource, /startupCatchupMode === "off"/u);
  assert.match(liveSource, /startupCatchupState = "pending"/u);
  assert.match(liveSource, /queue\.skipDowntimeGap\(state\.root\)/u);
  assert.match(liveSource, /queue\.listPaths\(state\.root\)/u);
  assert.match(smokeSource, /startupCatchup|startup-catchup/u);
  assert.match(smokeSource, /立即補捉|稍後提醒|略過本次|關閉開機補捉/u);
  assert.match(smokeSource, /delayNextIndexStatusMs = 2500/u);
});
