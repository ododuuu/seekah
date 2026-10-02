import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultDatabasePath, dataDirectory, IndexStore } from "./store.js";
import { acquireLiveLease, canonicalIndexPath, LiveBusyError } from "./live-lease.js";
import {
  AutoupdateError, createInstanceId, createInstanceToken,
  isPidAlive, readStateFile, removeStateFile, sameSettings, sendControlRequest,
  startControlServer, writeStateFile, type AutoupdateSettings, type AutoupdateStateFile,
  type ControlServer, type LiveStatus, DEFAULT_AUTODIAGNOSE_LIMIT, MAX_AUTODIAGNOSE_LIMIT, resolveAutoupdateDiagnoseLimit,
  liveTimingSummary, type LiveTimingSample,
} from "./autoupdate-control.js";
import { createAutoupdateLog, formatAutoupdateLogLine } from "./autoupdate-log.js";
import { LiveUpdateEngine, resolveAutoupdateReconcile, resolveWatchDebounce, WatchError } from "./live-update.js";
import { describeIndexClientError, sanitizeRecentError } from "./index-errors.js";
import { serializeVersionedJson, serializeVersionedJsonError } from "./status-json.js";
import { isStartupCatchupMode, resolveStartupCatchupMode, type StartupCatchupAction, type StartupCatchupMode } from "./startup-catchup.js";

import { autoupdateStartupDisable, autoupdateStartupEnable, autoupdateStartupStatus } from "./autoupdate-startup.js";
export { AutoupdateError, resolveAutoupdateReconcile };
export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const STOP_WAIT_MS = 30_000;

export interface AutoupdateCliOptions {
  execPath?: string;
  cliPath?: string;
  spawn?: typeof spawn;
  handshakeTimeoutMs?: number;
  stopWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  dataDir?: string;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveCliPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.argv[1]) return path.resolve(process.argv[1]);
  return fileURLToPath(import.meta.url);
}

export function autoupdateFailureOutput(error: unknown): { code: string; message: string } {
  const classified = describeIndexClientError(error);
  if (classified) {
    return {
      code: classified.startsWith("INDEX_BUSY") ? "INDEX_BUSY" : "INDEX_RECOVERY_REQUIRED",
      message: classified,
    };
  }
  if (error instanceof AutoupdateError || error instanceof LiveBusyError) {
    return { code: error.code, message: error.message };
  }
  return { code: "AUTOUPDATE_START_FAILED", message: error instanceof Error ? error.message : "daemon failed" };
}

export function formatLiveStatus(status: LiveStatus, extra?: { unresponsive?: boolean }): string {
  const lines = [
    extra?.unresponsive ? "自動更新：無回應（stale）" : `自動更新：${status.mode === "foreground" ? "前景監看" : "背景執行中"}`,
    `實例：${status.instanceId}`,
    `模式：${status.mode}`,
    `PID：${status.pid}（僅供診斷，不能單獨作為停止依據）`,
    `啟動時間：${status.startedAt}`,
    `最後健康回應：${status.lastHeartbeatAt}`,
    `目前階段：${status.phase}`,
    `設定：防抖 ${status.settings.debounceMs} ms；完整校正 ${status.settings.reconcileMs} ms；開機補捉 ${status.startupCatchup?.mode ?? resolveStartupCatchupMode(status.settings.startupCatchupMode)}／${status.startupCatchup?.state ?? "none"}`,
    `開機補捉根目錄：${status.startupCatchup?.roots.join("、") ?? "無"}`,
    `待處理：${status.pendingCount}`,
    `基線：事件 ${status.eventCount}；${status.excludedEventCount !== undefined ? `已排除事件 ${status.excludedEventCount}；` : ""}局部更新 ${status.localUpdateCount}；根目錄掃描 ${status.rootScanCount}；子樹掃描 ${status.subtreeScanCount}`,
    `不確定訊號：空檔名 ${status.emptyFilenameEventCount ?? 0}；補掃 ${status.uncertainRescanCount ?? 0}；狀態項目 ${status.uncertainRescanStateCount ?? 0}；最近補掃 ${status.lastUncertainRescanAt ?? "無"}`,
    `工作佇列：待辦 ${status.queuePendingCount}；${status.queueDegraded ? "降級（落盤失敗）" : "正常"}`,
    `最舊待辦：${status.oldestQueuedAt ?? "無"}`,
    `最後事件：${status.lastEvent ? `${status.lastEvent.at} ${status.lastEvent.root}` : "無"}`,
    `最後局部更新：${status.lastLocalUpdate ? `${status.lastLocalUpdate.at} ${status.lastLocalUpdate.path}` : "無"}`,
    `最後完整校正：${status.lastReconcile ? `${status.lastReconcile.at} ${status.lastReconcile.root} 完整=${status.lastReconcile.complete ? "是" : "否"}` : "無"}`,
    `下次完整校正：${status.nextReconcileAt ?? "尚未排程"}`,
    `最近錯誤：${status.recentErrors.length ? status.recentErrors.map(sanitizeRecentError).join("；") : "無"}`,
  ];
  if (status.logError) lines.push(`日誌：${status.logError}`);
  lines.push("根目錄：");
  if (!status.roots.length) lines.push("  （無）");
  for (const root of status.roots) {
    const reconcile = root.reconcile
      ? ` 校正=${root.reconcile.phase}#${root.reconcile.generation} 已檢查=${root.reconcile.checked} 剩餘範圍=${root.reconcile.frontierCount} 讀取失敗=${root.reconcile.readFailures} 延後核對=${root.reconcile.deferredChecks}`
      : "";
    const degraded = root.degradedSubdirectories?.length
      ? ` 降級子目錄=${root.degradedSubdirectories.map(item => `${item.path}（${item.reason}）`).join("、")}`
      : "";
    const timing = root.lastTiming
      ? ` 計時=事件→排程${root.lastTiming.eventToScheduleMs ?? "—"} ms／事件→可搜尋${root.lastTiming.eventToSearchMs ?? "—"} ms／穩定${root.lastTiming.stableWaitMs} ms／列舉${root.lastTiming.enumerateMs} ms／取鎖${root.lastTiming.lockMs} ms／提交${root.lastTiming.commitMs} ms`
      : "";
    lines.push(`  ${root.path} 監看=${root.watch} 範圍=${root.scopeMode ?? "-"} 句柄=${root.handles ?? 0} 待處理=${root.pending}${reconcile}${degraded}${timing}${root.lastError ? ` 錯誤=${root.lastError}` : ""}`);
  }
  return lines.join("\n");
}

export function formatLiveStatusJson(status: LiveStatus, extra?: { stale?: boolean }): string {
  return serializeVersionedJson({
    ...status,
    recentErrors: status.recentErrors.map(sanitizeRecentError),
    stale: extra?.stale ?? false,
  });
}

function diagnosticDepth(value: string): number {
  return value.split(/[\\/]+/u).filter(Boolean).length;
}

function timingSamples(root: LiveStatus["roots"][number]): LiveTimingSample[] {
  if (root.lastTimings?.length) return root.lastTimings.slice();
  return root.lastTiming ? [root.lastTiming] : [];
}

function timingValue(value: number | undefined): string {
  return value === undefined ? "—" : `${value} ms`;
}

export function formatLiveDiagnosis(status: LiveStatus, requestedLimit = DEFAULT_AUTODIAGNOSE_LIMIT): string {
  const limit = resolveAutoupdateDiagnoseLimit(requestedLimit);
  const roots = status.roots;
  const allSamples = roots.flatMap(timingSamples);
  const allLatencies = allSamples.flatMap(sample => sample.eventToSearchMs === undefined ? [] : [sample.eventToSearchMs]);
  const latency = liveTimingSummary(allLatencies);
  const watcherErrors = Object.entries(status.watcherErrorCounts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const errorText = watcherErrors.length
    ? watcherErrors.map(([code, count]) => `${code}=${count}`).join("、")
    : "無";
  const lines = [
    "Seekah autoupdate diagnose",
    `模式：${status.mode}；階段：${status.phase}`,
    `根目錄：${roots.length}；事件：${status.eventCount}；局部更新：${status.localUpdateCount}；根目錄掃描：${status.rootScanCount}；子樹掃描：${status.subtreeScanCount}`,
    `不確定訊號：空檔名 ${status.emptyFilenameEventCount ?? 0}；補掃 ${status.uncertainRescanCount ?? 0}；狀態項目 ${status.uncertainRescanStateCount ?? 0}`,
    `watcher 錯誤：${errorText}`,
    `事件→可搜尋延遲：樣本 ${latency.count}；p50 ${latency.p50Ms === undefined ? "—" : `${latency.p50Ms} ms`}；p95 ${latency.p95Ms === undefined ? "—" : `${latency.p95Ms} ms`}；最大 ${latency.maxMs === undefined ? "—" : `${latency.maxMs} ms`}`,
    `最近批次上限：${limit}（daemon 每根最多 ${MAX_AUTODIAGNOSE_LIMIT} 筆）`,
  ];
  for (const [rootIndex, root] of roots.entries()) {
    const samples = timingSamples(root).slice(-limit);
    const rootLatencies = samples.flatMap(sample => sample.eventToSearchMs === undefined ? [] : [sample.eventToSearchMs]);
    const rootLatency = liveTimingSummary(rootLatencies);
    const degraded = root.degradedSubdirectories ?? [];
    const degradedText = degraded.length
      ? degraded.map(item => `深度=${Math.max(0, item.path.split(/[\\/]+/u).filter(Boolean).length - diagnosticDepth(root.path))}`).join("；")
      : "無";
    lines.push(`根目錄 R${rootIndex + 1}：深度=0；監看=${root.watch}；降級子目錄=${degraded.length}`);
    lines.push(`  降級摘要：${degradedText}`);
    lines.push(`  事件→可搜尋延遲：樣本 ${rootLatency.count}；p50 ${rootLatency.p50Ms === undefined ? "—" : `${rootLatency.p50Ms} ms`}；p95 ${rootLatency.p95Ms === undefined ? "—" : `${rootLatency.p95Ms} ms`}；最大 ${rootLatency.maxMs === undefined ? "—" : `${rootLatency.maxMs} ms`}`);
    lines.push(`  最近 lastTiming：${samples.length}/${limit}`);
    for (const sample of samples) {
      lines.push(`    ${sample.at} 事件→排程 ${timingValue(sample.eventToScheduleMs)}；事件→可搜尋 ${timingValue(sample.eventToSearchMs)}；穩定 ${timingValue(sample.stableWaitMs)}；列舉 ${timingValue(sample.enumerateMs)}；取鎖 ${timingValue(sample.lockMs)}；提交 ${timingValue(sample.commitMs)}`);
    }
  }
  return lines.join("\n");
}

async function queryLive(databasePath: string): Promise<{ state: AutoupdateStateFile; status: LiveStatus } | undefined> {
  const state = readStateFile(databasePath);
  if (!state) return undefined;
  const response = await sendControlRequest(state.endpoint, state.token, "status");
  if (!response.ok) {
    throw new AutoupdateError(response.error?.code ?? "AUTOUPDATE_UNRESPONSIVE", response.error?.message ?? "控制通道回應失敗。");
  }
  return { state, status: response.result as LiveStatus };
}

export async function autoupdateCatchup(
  action: StartupCatchupAction,
  databasePath = defaultDatabasePath(),
): Promise<{ code: number; text: string; live: LiveStatus }> {
  const state = readStateFile(databasePath);
  if (!state) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
  const response = await sendControlRequest(state.endpoint, state.token, "startup-catchup", action);
  if (!response.ok) {
    throw new AutoupdateError(response.error?.code ?? "AUTOUPDATE_CATCHUP_FAILED", response.error?.message ?? "開機補捉要求失敗。");
  }
  const live = await queryLive(databasePath);
  if (!live) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "背景自動更新已停止。");
  return { code: 0, text: formatLiveStatus(live.status), live: live.status };
}


function staleError(state: AutoupdateStateFile): AutoupdateError {
  if (isPidAlive(state.pid)) {
    return new AutoupdateError("AUTOUPDATE_UNRESPONSIVE",
      `狀態檔存在且 PID ${state.pid} 仍在，但控制通道無回應；未啟動新程序，也未終止該 PID。`);
  }
  return new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
}

function staleStatus(state: AutoupdateStateFile, message: string): LiveStatus {
  return {
    schemaVersion: 1,
    instanceId: state.instanceId,
    pid: state.pid,
    mode: state.mode,
    startedAt: state.startedAt,
    lastHeartbeatAt: "",
    phase: "stopping",
    settings: state.settings,
    startupCatchup: { mode: resolveStartupCatchupMode(state.settings.startupCatchupMode), state: "none", roots: [] },
    ready: false,
    roots: [],
    pendingCount: 0,
    eventCount: 0,
    localUpdateCount: 0,
    rootScanCount: 0,
    subtreeScanCount: 0,
    queuePendingCount: 0,
    queueDegraded: false,
    recentErrors: [message],
  };
}

export async function autoupdateStatus(databasePath = defaultDatabasePath()): Promise<{ code: number; text: string; live?: LiveStatus; stale?: boolean }> {
  const state = readStateFile(databasePath);
  if (!state) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
  try {
    const live = await queryLive(databasePath);
    if (!live) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
    return { code: 0, text: formatLiveStatus(live.status), live: live.status, stale: false };
  } catch (error) {
    if (error instanceof AutoupdateError && (error.code === "AUTOUPDATE_NOT_RUNNING" || error.code === "AUTOUPDATE_UNRESPONSIVE")) {
      if (isPidAlive(state.pid)) {
        const live = staleStatus(state, error.message);
        return {
          code: 3,
          text: `${formatLiveStatus(live, { unresponsive: true })}\nAUTOUPDATE_UNRESPONSIVE：控制通道無回應。`,
          live,
          stale: true,
        };
      }
      return {
        code: 3,
        text: `AUTOUPDATE_NOT_RUNNING：沒有正在執行的自動更新。\n殘留狀態：instance=${state.instanceId} pid=${state.pid}（程序已不存在）`,
        stale: true,
      };
    }
    throw error;
  }
}

export async function autoupdateDiagnose(
  databasePath = defaultDatabasePath(),
  requestedLimit = DEFAULT_AUTODIAGNOSE_LIMIT,
): Promise<{ code: number; text: string; live: LiveStatus }> {
  const limit = resolveAutoupdateDiagnoseLimit(requestedLimit);
  const live = await queryLive(databasePath);
  if (!live) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
  return { code: 0, text: formatLiveDiagnosis(live.status, limit), live: live.status };
}

export async function autoupdateStop(
  databasePath = defaultDatabasePath(),
  options: AutoupdateCliOptions = {},
): Promise<{ code: number; text: string }> {
  const state = readStateFile(databasePath);
  if (!state) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
  let status: LiveStatus | undefined;
  try {
    const live = await queryLive(databasePath);
    status = live?.status;
  } catch (error) {
    if (error instanceof AutoupdateError) throw staleError(state);
    throw error;
  }
  if (!status) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。");
  if (status.mode === "foreground") {
    throw new AutoupdateError("AUTOUPDATE_FOREGROUND_ACTIVE", "前景監看請在原終端按 Ctrl+C 結束，不能從另一個程序遠端停止。");
  }
  const stop = await sendControlRequest(state.endpoint, state.token, "stop");
  if (!stop.ok) {
    throw new AutoupdateError(stop.error?.code ?? "AUTOUPDATE_UNRESPONSIVE", stop.error?.message ?? "停止要求失敗。");
  }
  const waitMs = options.stopWaitMs ?? STOP_WAIT_MS;
  const sleep = options.sleep ?? sleepMs;
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    try {
      await sendControlRequest(state.endpoint, state.token, "ping", 1000);
    } catch {
      return { code: 0, text: `已停止背景自動更新：${state.instanceId}` };
    }
    await sleep(200);
  }
  throw new AutoupdateError("AUTOUPDATE_STOP_PENDING", "已發出停止要求，但程序尚未在 30 秒內安全結束；未終止 Node 程序，也未刪除 journal／WAL。", 3);
}

async function waitForHandshake(
  databasePath: string,
  expected?: { instanceId?: string },
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = sleepMs,
): Promise<LiveStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const live = await queryLive(databasePath);
      if (live?.status.ready && (!expected?.instanceId || live.status.instanceId === expected.instanceId)) return live.status;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(100);
  }
  throw new AutoupdateError("AUTOUPDATE_START_FAILED",
    `背景程序已啟動但未能在時限內完成控制通道握手。${last ? ` ${last.message}` : ""}`, 4);
}

export async function autoupdateStart(
  settings: AutoupdateSettings,
  databasePath = defaultDatabasePath(),
  options: AutoupdateCliOptions = {},
): Promise<{ code: number; text: string }> {
  if (!existsSync(databasePath)) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "索引尚未建立；請先執行 docsearch index <root>。");
  const store = new IndexStore(databasePath, { readOnly: true });
  let roots: string[] = [];
  try { roots = store.roots(); }
  finally { store.close(); }
  if (!roots.length) throw new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有可監看的根目錄；請先執行 index <root>。");

  const existing = readStateFile(databasePath);
  if (existing) {
    try {
      const live = await queryLive(databasePath);
      if (live) {
        if (live.status.mode === "foreground") {
          throw new AutoupdateError("AUTOUPDATE_FOREGROUND_ACTIVE",
            `前景監看正在執行（${live.status.instanceId}）。請在原終端按 Ctrl+C 後再 start。`);
        }
        if (sameSettings(live.status.settings, settings)) {
          return { code: 0, text: `背景自動更新已在執行\n${formatLiveStatus(live.status)}` };
        }
        throw new AutoupdateError("AUTOUPDATE_ALREADY_RUNNING",
          `背景自動更新已在執行（${live.status.instanceId}），設定不同。請先 autoupdate stop 再 start，不會暗中改動執行中的程序。`);
      }
    } catch (error) {
      if (error instanceof AutoupdateError && (error.code === "AUTOUPDATE_FOREGROUND_ACTIVE" || error.code === "AUTOUPDATE_ALREADY_RUNNING")) throw error;
      if (isPidAlive(existing.pid)) throw staleError(existing);
      removeStateFile(databasePath);
    }
  }

  const execPath = options.execPath ?? process.execPath;
  const cliPath = resolveCliPath(options.cliPath);
  const childArgs = [
    cliPath, "autoupdate", "--daemon",
    "--database-path", path.resolve(databasePath),
    "--debounce", String(settings.debounceMs),
    "--reconcile", String(settings.reconcileMs),
    ...(settings.startupCatchupMode ? ["--startup-catchup", settings.startupCatchupMode] : []),
    ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
  ];
  const child = (options.spawn ?? spawn)(execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
  try {
    const status = await waitForHandshake(databasePath, {}, options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS, options.sleep ?? sleepMs);
    return { code: 0, text: `已啟動背景自動更新\n${formatLiveStatus(status)}` };
  } catch (error) {
    if (error instanceof AutoupdateError) throw error;
    const failure = autoupdateFailureOutput(error);
    throw new AutoupdateError("AUTOUPDATE_START_FAILED", failure.message, 4);
  }
}

export async function autoupdateStartForWorkbench(
  databasePath = defaultDatabasePath(),
  options: AutoupdateCliOptions = {},
): Promise<{ code: number; text: string }> {
  const store = new IndexStore(databasePath, { readOnly: true });
  let settings: { debounceMs: number; reconcileMs: number };
  try {
    settings = store.autoupdateSettings();
  } finally {
    store.close();
  }
  return autoupdateStart({ ...settings, startupCatchupMode: "auto" }, databasePath, options);
}

export async function runAutoupdateDaemon(
  settings: AutoupdateSettings,
  databasePath = defaultDatabasePath(),
): Promise<number> {
  const canonical = canonicalIndexPath(databasePath);
  const dataDir = dataDirectory(canonical);
  const log = createAutoupdateLog(dataDir);
  const instanceId = createInstanceId();
  const token = createInstanceToken();
  const startedAt = new Date().toISOString();
  let releaseLease: (() => void) | undefined;
  let server: ControlServer | undefined;
  let store: IndexStore | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => finish();
  try {
    try {
      releaseLease = acquireLiveLease(databasePath);
    } catch (error) {
      if (error instanceof LiveBusyError) return 3;
      throw error;
    }
    store = new IndexStore(databasePath);
    const roots = store.roots();
    if (!roots.length) return 3;
    const engine = new LiveUpdateEngine(store, roots, {
      mode: "background",
      debounceMs: settings.debounceMs,
      reconcileMs: settings.reconcileMs,
      startupCatchupMode: resolveStartupCatchupMode(settings.startupCatchupMode),
      instanceId,
      startedAt,
      onLog: line => log.write(formatAutoupdateLogLine({ phase: "log", message: line })),
    }, {
      write: line => log.write(formatAutoupdateLogLine({ phase: "io", message: line })),
      waitForStop: () => stopped,
    });
    const markLog = () => { engine.logError = log.failed; };
    server = await startControlServer({
      databasePath,
      token,
      instanceId,
      mode: "background",
      getStatus: () => {
        markLog();
        return engine.snapshot();
      },
      onStop: stop,
      onStartupCatchup: action => engine.startupCatchupAction(action),
      allowRemoteStop: true,
    });
    writeStateFile({
      schemaVersion: 1,
      databasePath: canonical,
      instanceId,
      pid: process.pid,
      token,
      endpoint: server.endpoint,
      startedAt,
      settings,
      mode: "background",
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    log.write(formatAutoupdateLogLine({ phase: "start", message: "handshake ready", ...(roots[0] ? { root: roots[0] } : {}), count: roots.length }));
    const code = await engine.run();
    log.write(formatAutoupdateLogLine({ phase: "stop", code: "OK", count: code }));
    return code;
  } catch (error) {
    const failure = autoupdateFailureOutput(error);
    log.write(formatAutoupdateLogLine({
      phase: "error",
      code: failure.code,
      message: failure.message,
    }));
    return 4;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (server) await server.close();
    const current = readStateFile(databasePath);
    if (current?.pid === process.pid && current.instanceId === instanceId) removeStateFile(databasePath);
    releaseLease?.();
    store?.close();
  }
}

export async function runAutoupdateCommand(args: readonly string[], options: AutoupdateCliOptions = {}): Promise<number> {
  let debounce: number | undefined;
  let reconcile: number | undefined;
  let startupCatchupMode: StartupCatchupMode | undefined;
  let diagnoseLimit: number | undefined;
  let dataDir: string | undefined;
  let databasePathOption: string | undefined;
  let json = false;
  let daemon = false;
  const positional: string[] = [];
  try {
    for (let index = 0; index < args.length; index++) {
      const option = args[index]!;
      if (option === "--json") {
        if (json) throw new Error("不可重複指定 --json。");
        json = true;
      }
      else if (option === "--daemon") daemon = true;
      else if (option === "--debounce") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("--debounce 缺少毫秒數。");
        debounce = resolveWatchDebounce(Number(value));
      } else if (option === "--reconcile") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("--reconcile 缺少毫秒數。");
        reconcile = resolveAutoupdateReconcile(Number(value));
      } else if (option === "--startup-catchup") {
        const value = args[++index];
        if (!value || !isStartupCatchupMode(value)) throw new Error("--startup-catchup 必須是 ask、auto 或 off。");
        startupCatchupMode = value;
      } else if (option === "--limit") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("--limit 缺少筆數。");
        diagnoseLimit = resolveAutoupdateDiagnoseLimit(Number(value));
      } else if (option === "--data-dir") {
        if (dataDir !== undefined) throw new Error("不可重複指定 --data-dir。");
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("--data-dir 缺少資料目錄。");
        dataDir = path.resolve(value);
      } else if (option === "--database-path") {
        if (databasePathOption !== undefined) throw new Error("不可重複指定內部 database path。");
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("內部 database path 缺少值。");
        databasePathOption = path.resolve(value);
      } else if (option.startsWith("--") || !option.trim()) {
        throw new Error("用法：docsearch autoupdate start [--debounce <毫秒>] [--reconcile <毫秒>] [--startup-catchup <ask|auto|off>] [--data-dir <資料目錄>]\n        docsearch autoupdate status [--json] [--data-dir <資料目錄>]\n        docsearch autoupdate diagnose [--limit <1～32>] [--data-dir <資料目錄>]\n        docsearch autoupdate stop [--data-dir <資料目錄>]\n        docsearch autoupdate startup enable|disable|status");
      } else positional.push(option);
    }
    if (daemon) {
      if (json) throw new Error("--json 只用於 autoupdate status。");
      if (positional.length || diagnoseLimit !== undefined) throw new Error("內部 --daemon 不接受其他子命令或 --limit。");
      return await runAutoupdateDaemon({
        debounceMs: resolveWatchDebounce(debounce),
        reconcileMs: resolveAutoupdateReconcile(reconcile),
        startupCatchupMode: resolveStartupCatchupMode(startupCatchupMode),
      }, databasePathOption ?? (dataDir ? path.join(dataDir, "LocalDocSearch", "index.db") : defaultDatabasePath()));
    }
    if (databasePathOption !== undefined) throw new Error("內部 database path 只供 daemon 使用。");
    const action = positional[0];
    const startupAction = action === "startup" ? positional[1] : undefined;
    if (action === "startup") {
      if (positional.length !== 2 || !startupAction || !["enable", "disable", "status"].includes(startupAction)) {
        throw new Error("用法：docsearch autoupdate startup enable|disable|status");
      }
    } else if (positional.length !== 1 || !action || !["start", "status", "diagnose", "stop"].includes(action)) {
      throw new Error("用法：docsearch autoupdate start [--debounce <毫秒>] [--reconcile <毫秒>] [--startup-catchup <ask|auto|off>] [--data-dir <資料目錄>]\n        docsearch autoupdate status [--json] [--data-dir <資料目錄>]\n        docsearch autoupdate diagnose [--limit <1～32>] [--data-dir <資料目錄>]\n        docsearch autoupdate stop [--data-dir <資料目錄>]\n        docsearch autoupdate startup enable|disable|status");
    }
    if (json && action !== "status") throw new Error("--json 只用於 autoupdate status。");
    if (diagnoseLimit !== undefined && action !== "diagnose") {
      throw new Error("只有 autoupdate diagnose 可指定 --limit。");
    }
    if ((action === "status" || action === "diagnose" || action === "stop" || action === "startup")
      && (debounce !== undefined || reconcile !== undefined || startupCatchupMode !== undefined)) {
      throw new Error(`autoupdate ${action} 不接受 --debounce／--reconcile／--startup-catchup。`);
    }
    const databasePath = dataDir ? path.join(dataDir, "LocalDocSearch", "index.db") : defaultDatabasePath();
    if (action === "startup") {
      const startupOptions = { ...options, databasePath };
      const result = startupAction === "enable"
        ? await autoupdateStartupEnable(startupOptions)
        : startupAction === "disable"
          ? autoupdateStartupDisable(startupOptions)
          : autoupdateStartupStatus(startupOptions);
      console.log(result.text);
      return result.code;
    }
    if (action === "start") {
      const result = await autoupdateStart({
        debounceMs: resolveWatchDebounce(debounce),
        reconcileMs: resolveAutoupdateReconcile(reconcile),
        ...(startupCatchupMode ? { startupCatchupMode } : {}),
      }, databasePath, { ...options, ...(dataDir ? { dataDir } : {}) });
      console.log(result.text);
      return result.code;
    }
    if (action === "status") {
      const result = await autoupdateStatus(databasePath);
      if (json) {
        console.log(result.live
          ? formatLiveStatusJson(result.live, result.stale === undefined ? undefined : { stale: result.stale })
          : serializeVersionedJsonError("AUTOUPDATE_NOT_RUNNING", result.text));
      } else {
        console.log(result.text);
      }
      return result.code;
    }
    if (action === "diagnose") {
      const result = await autoupdateDiagnose(databasePath, diagnoseLimit);
      console.log(result.text);
      return result.code;
    }
    const result = await autoupdateStop(databasePath, options);
    console.log(result.text);
    return result.code;
  } catch (error) {
    if (json) {
      if (error instanceof AutoupdateError) {
        console.log(serializeVersionedJsonError(error.code, `${error.code}：${error.message}`));
        return error.exitCode;
      }
      if (error instanceof WatchError) {
        console.log(serializeVersionedJsonError(error.code, `${error.code}：${error.message}`));
        return 2;
      }
      const failure = autoupdateFailureOutput(error);
      console.log(serializeVersionedJsonError(failure.code, failure.message));
      return failure.code === "INDEX_BUSY" || failure.code === "INDEX_RECOVERY_REQUIRED" ? 3 : 2;
    }
    if (error instanceof AutoupdateError) {
      console.error(`${error.code}：${error.message}`);
      return error.exitCode;
    }
    if (error instanceof WatchError) {
      console.error(`${error.code}：${error.message}`);
      return 2;
    }
    const failure = autoupdateFailureOutput(error);
    console.error(failure.message);
    return failure.code === "INDEX_BUSY" || failure.code === "INDEX_RECOVERY_REQUIRED" ? 3 : 2;
  }
}
