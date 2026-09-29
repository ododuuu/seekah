import fs from "node:fs";
import path from "node:path";
import { acquireWriteLock, IndexBusyError } from "./write-lock.js";
import { IGNORE_FILE, IgnoreConfigurationError } from "./ignore.js";
import { isIndexArtifact, type IndexStore } from "./store.js";
import { sync, type SyncOptions, type SyncReport } from "./sync.js";
import {
  applyPathChange, applyFileDelete, applyFileUpdate, commitPreparedFileUpdateLocked, identityKey,
  isIgnoreFile, prepareFileUpdate, sleepMs, UNSTABLE_BACKOFF_MS, WRITER_BACKOFF_MS, withWriterBackoff,
  type LocalUpdateOptions, type LocalUpdateResult, type PreparedFileUpdate,
} from "./local-update.js";
import { coversPath, samePath } from "./root-plan.js";
import { RootError } from "./scanner.js";
import { OperationCancelledError, type ProgressUpdate } from "./progress.js";
import { shouldIgnoreWatchPath } from "./watch-path.js";
import type { LiveMode, LivePhase, LiveRootStatus, LiveStatus, RootWatchState } from "./autoupdate-control.js";
import { DEFAULT_QUEUE_LIMIT, LiveWorkQueue, QueuePersistError, type LiveWorkQueueOptions } from "./live-queue.js";
import { RootExclusion } from "./root-exclusion.js";
import { runBackgroundReconcileBatch, DEFAULT_RECONCILE_BATCH_ENTRIES, DEFAULT_RECONCILE_BATCH_MS } from "./reconcile.js";

export const DEFAULT_DEBOUNCE_MS = 1500;
export const DEFAULT_WATCH_RESCAN_MS = 300_000;
export const DEFAULT_RECONCILE_MS = 21_600_000;
export const QUEUE_LIMIT = DEFAULT_QUEUE_LIMIT;
export const DEFAULT_WATCH_HANDLE_LIMIT = 128;
/** 事件不間斷時，防抖最長等待「防抖時間 × 此倍數」就開始處理（SPEC §53.4）。 */
export const DEBOUNCE_MAX_WAIT_FACTOR = 10;
/** 局部更新每輪上限；輪與輪之間釋放 writer lock（SPEC §54.1）。 */
export const LOCAL_BATCH_MAX_ITEMS = 500;
export const LOCAL_BATCH_MAX_MS = 5_000;
/** 資料夾展開每輪最多讀取的目錄項目數（SPEC §56.1）。 */
export const LOCAL_WALK_MAX_ENTRIES = 2_000;
export const HEARTBEAT_MS = 10_000;
export const ROOT_REFRESH_MS = 10_000;
export const WATCHER_RETRY_MS = [60_000, 300_000, 900_000] as const;

export interface LiveIO {
  write(text: string): void;
  waitForStop(): Promise<void>;
}

export interface LiveUpdateOptions {
  mode: LiveMode;
  debounceMs?: number;
  reconcileMs?: number;
  verbose?: boolean;
  syncNow?: boolean;
  watch?: typeof fs.watch;
  sync?: typeof sync;
  applyFileUpdate?: typeof applyFileUpdate;
  /** 解析函式注入僅供測試準確控制準備階段；正式路徑仍在 writer lock 外執行。 */
  parse?: LocalUpdateOptions["parse"];
  applyFileDelete?: typeof applyFileDelete;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (update: ProgressUpdate) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  instanceId?: string;
  startedAt?: string;
  workQueue?: LiveWorkQueue;
  queueLimit?: number;
  queuePersistHook?: LiveWorkQueueOptions["persistHook"];
  watchHandleLimit?: number;
  reconcileBatchEntries?: number;
  reconcileBatchMs?: number;
  /** 資料夾展開每輪讀取的目錄項目上限；預設 LOCAL_WALK_MAX_ENTRIES（SPEC §56.1）。 */
  localWalkEntries?: number;
}

type LocalWorkItem = { filePath: string; generation: number; relPath: string; expand: boolean };

type LocalBatchResult = {
  updated: number;
  unchanged: number;
  removed: number;
  complete: boolean;
  /** 已確認完成（含延後用盡）的路徑；其餘留在佇列。 */
  finished: Set<string>;
  /** 本輪處理過的路徑（完成或延後），記入輪替的本圈。 */
  attempted: Set<string>;
  deferred: boolean;
  interrupted: boolean;
};

type WatchHandle = {
  path: string;
  recursive: boolean;
  watcher: fs.FSWatcher;
};

type RootState = {
  root: string;
  pending: Set<string>;
  reconcile: boolean;
  dirty: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  firstScheduledAt: number | undefined;
  exclusion: RootExclusion;
  /** 局部更新輪替的本圈已處理路徑（SPEC §55.2）。 */
  sweep: Set<string>;
  /** 進行中的資料夾展開（SPEC §56）；只在記憶體，重啟後重新展開。 */
  walks: Map<string, {
    frontier: string[];
    listing: { dir: string; entries: fs.Dirent[]; next: number } | undefined;
    seen: Set<string>;
    failed: boolean;
  }>;
  watcher?: fs.FSWatcher;
  handles: WatchHandle[];
  scopeMode: "split" | "coarse";
  failed: boolean;
  offline: boolean;
  syncFailed: boolean;
  removed: boolean;
  rescanTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt: number;
  busyAttempt: number;
  lastError?: string;
  lastEventAt?: string;
  lastLocalUpdateAt?: string;
  lastReconcileAt?: string;
  reconcileGeneration?: number;
  reconcileChecked?: number;
  reconcileFrontier?: number;
  reconcileReason?: string;
  reconcileStartedAt?: string;
  reconcileUpdatedAt?: string;
  lastReconcileBatchAt?: number;
};

export class WatchError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "WatchError"; }
}

export function resolveWatchDebounce(ms: number | undefined): number {
  const value = ms ?? DEFAULT_DEBOUNCE_MS;
  if (!Number.isSafeInteger(value) || value < 200 || value > 60_000) {
    throw new WatchError("WATCH_DEBOUNCE_INVALID", "--debounce 必須是 200～60000 的整數毫秒。");
  }
  return value;
}

export function resolveWatchRescan(ms: number | undefined): number {
  const value = ms ?? DEFAULT_WATCH_RESCAN_MS;
  if (!Number.isSafeInteger(value) || (value !== 0 && (value < 1000 || value > 3_600_000))) {
    throw new WatchError("WATCH_RESCAN_INVALID", "--rescan 必須是 1000～3600000 的整數毫秒，或 0 關閉。");
  }
  return value;
}

export function resolveAutoupdateReconcile(ms: number | undefined): number {
  const value = ms ?? DEFAULT_RECONCILE_MS;
  if (!Number.isSafeInteger(value) || value < 900_000 || value > 86_400_000) {
    throw new WatchError("AUTOUPDATE_RECONCILE_INVALID", "--reconcile 必須是 900000～86400000 的整數毫秒。");
  }
  return value;
}

function absorb(pending: Set<string>, candidate: string): void {
  for (const existing of pending) {
    if (samePath(existing, candidate) || coversPath(existing, candidate)) return;
  }
  for (const existing of [...pending]) {
    if (coversPath(candidate, existing)) pending.delete(existing);
  }
  pending.add(candidate);
}

export class LiveUpdateEngine {
  private readonly states = new Map<string, RootState>();
  private readonly active = new Set<Promise<void>>();
  private readonly readyQueue: string[] = [];
  private stopping = false;
  private running = false;
  private phase: LivePhase = "starting";
  private lastHeartbeatAt: string;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEvent?: { at: string; root: string };
  private lastLocalUpdate?: { at: string; root: string; path: string };
  private lastReconcile?: { at: string; root: string; complete: boolean };
  private eventCount = 0;
  private excludedEventCount = 0;
  /** 路徑連續延後次數；超過 UNSTABLE_BACKOFF_MS.length 即記為不穩定並確認完成。 */
  private readonly deferrals = new Map<string, number>();
  private localUpdateCount = 0;
  private rootScanCount = 0;
  private subtreeScanCount = 0;
  private queueDegraded = false;
  private readonly queue: LiveWorkQueue;
  private readonly ownsQueue: boolean;
  private readonly recentErrors: string[] = [];
  private allFailed!: () => void;
  private readonly failed: Promise<void>;
  readonly abort: AbortController;
  logError = false;

  constructor(
    private readonly store: IndexStore,
    roots: readonly string[],
    private readonly options: LiveUpdateOptions,
    private readonly io: LiveIO,
  ) {
    this.lastHeartbeatAt = new Date(this.now()).toISOString();
    this.abort = new AbortController();
    this.failed = new Promise<void>(resolve => { this.allFailed = resolve; });
    this.ownsQueue = !options.workQueue;
    this.queue = options.workQueue ?? new LiveWorkQueue(store.databasePath, {
      now: () => this.now(),
      ...(options.queueLimit !== undefined ? { limit: options.queueLimit } : {}),
      ...(options.queuePersistHook ? { persistHook: options.queuePersistHook } : {}),
    });
    for (const root of roots) this.states.set(root, this.newState(root));
    options.signal?.addEventListener("abort", () => this.requestStop(), { once: true });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get debounceMs(): number {
    return resolveWatchDebounce(this.options.debounceMs);
  }

  private get watchHandleLimit(): number {
    const value = this.options.watchHandleLimit ?? DEFAULT_WATCH_HANDLE_LIMIT;
    return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_WATCH_HANDLE_LIMIT;
  }

  private get reconcileMs(): number {
    return this.options.mode === "background"
      ? resolveAutoupdateReconcile(this.options.reconcileMs)
      : resolveWatchRescan(this.options.reconcileMs);
  }

  private get setTimer(): (fn: () => void, ms: number) => ReturnType<typeof setTimeout> {
    return this.options.setTimer ?? setTimeout;
  }

  private get clearTimer(): (id: ReturnType<typeof setTimeout>) => void {
    return this.options.clearTimer ?? clearTimeout;
  }

  private log(line: string): void {
    this.io.write(line);
    this.options.onLog?.(line);
  }

  private rememberError(code: string, message: string): void {
    this.recentErrors.push(`${code}: ${message}`);
    if (this.recentErrors.length > 20) this.recentErrors.shift();
  }

  private newState(root: string): RootState {
    return {
      root, pending: new Set(), reconcile: false, dirty: false, running: false,
      timer: undefined, firstScheduledAt: undefined, exclusion: this.loadExclusion(root), sweep: new Set(), walks: new Map(), failed: false, offline: false, syncFailed: false, removed: false,
      handles: [], scopeMode: "split",
      rescanTimer: undefined, retryTimer: undefined, retryAttempt: 0, busyAttempt: 0,
    };
  }

  /** 規則檔設定錯誤時只套用內建排除；同步會依既有規則回報根目錄失敗。 */
  private loadExclusion(root: string): RootExclusion {
    try {
      return RootExclusion.loadSync(root, this.store);
    } catch {
      return RootExclusion.builtinOnly(root);
    }
  }

  private isExcluded(state: RootState, absPath: string, isDirectory: boolean): boolean {
    return state.exclusion.excludes(absPath, isDirectory);
  }

  snapshot(): LiveStatus {
    const roots: LiveRootStatus[] = [...this.states.values()].map(state => {
      const reconcile = this.queue.reconcileStatus(state.root);
      return {
        path: state.root,
        watch: this.watchState(state),
        pending: state.pending.size + (state.reconcile ? 1 : 0),
        scopeMode: state.scopeMode,
        handles: state.handles.length,
        ...(state.lastError ? { lastError: state.lastError } : {}),
        ...(reconcile ? {
          reconcile: {
            generation: reconcile.generation,
            phase: reconcile.phase,
            reason: reconcile.reason,
            checked: reconcile.checked,
            frontierCount: reconcile.frontier.length,
            readFailures: reconcile.readFailures.length,
            deferredChecks: reconcile.deferredChecks.length,
            startedAt: new Date(reconcile.startedAtMs).toISOString(),
            updatedAt: new Date(reconcile.updatedAtMs).toISOString(),
          },
        } : {}),
      };
    });
    return {
      schemaVersion: 1,
      instanceId: this.options.instanceId ?? "",
      pid: process.pid,
      mode: this.options.mode,
      startedAt: this.options.startedAt ?? this.lastHeartbeatAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      phase: this.phase,
      settings: { debounceMs: this.debounceMs, reconcileMs: this.reconcileMs },
      ready: this.phase !== "starting",
      roots,
      pendingCount: roots.reduce((sum, item) => sum + item.pending, 0),
      eventCount: this.eventCount,
      excludedEventCount: this.excludedEventCount,
      localUpdateCount: this.localUpdateCount,
      rootScanCount: this.rootScanCount,
      subtreeScanCount: this.subtreeScanCount,
      queuePendingCount: this.queue.pendingCount(),
      queueDegraded: this.queueDegraded,
      ...(this.queue.oldestCreatedAtMs() != null
        ? { oldestQueuedAt: new Date(this.queue.oldestCreatedAtMs()!).toISOString() }
        : {}),
      ...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
      ...(this.lastLocalUpdate ? { lastLocalUpdate: this.lastLocalUpdate } : {}),
      ...(this.lastReconcile ? { lastReconcile: this.lastReconcile } : {}),
      ...(this.lastReconcile && this.reconcileMs
        ? { nextReconcileAt: new Date(Date.parse(this.lastReconcile.at) + this.reconcileMs).toISOString() }
        : {}),
      recentErrors: [...this.recentErrors],
      ...(this.logError ? { logError: "AUTOUPDATE_LOG_ERROR" as const } : {}),
    };
  }

  private watchState(state: RootState): RootWatchState {
    if (state.removed) return "removed";
    if (state.offline) return "offline";
    if (state.failed || this.queueDegraded) return "degraded";
    return "active";
  }

  requestStop(): void {
    this.stopping = true;
    this.phase = "stopping";
    this.abort.abort();
    this.allFailed();
  }

  private enqueueReady(root: string): void {
    if (this.stopping) return;
    if (!this.readyQueue.includes(root)) this.readyQueue.push(root);
    this.pump();
  }

  private pump(): void {
    if (this.stopping || this.running) return;
    const root = this.readyQueue.shift();
    if (!root) {
      this.phase = "idle";
      return;
    }
    const state = this.states.get(root);
    if (!state || state.removed) {
      this.pump();
      return;
    }
    this.launch(state);
  }

  private launch(state: RootState): Promise<void> {
    this.running = true;
    const task = this.runRoot(state);
    this.active.add(task);
    void task.finally(() => {
      this.active.delete(task);
      this.running = false;
      if (!this.stopping) this.pump();
    });
    return task;
  }

  private printReport(report: SyncReport): void {
    this.log(`根目錄：${report.root}；更新 ${report.updated}、未變更 ${report.unchanged}、移除 ${report.removed}；耗時 ${report.elapsedMs} ms；完整：${report.complete ? "是" : "否"}`);
    if (this.options.verbose) {
      for (const notice of report.notices) this.log(`提示：${notice}`);
      for (const error of report.errors) this.log(`文件問題：${error}`);
    }
  }

  private printLocal(root: string, updated: number, unchanged: number, removed: number, elapsedMs: number, complete: boolean): void {
    this.log(`根目錄：${root}；更新 ${updated}、未變更 ${unchanged}、移除 ${removed}；耗時 ${elapsedMs} ms；完整：${complete ? "是" : "否"}`);
  }

  private syncFn(): typeof sync {
    return this.options.sync ?? sync;
  }

  private async runRoot(state: RootState): Promise<void> {
    if (this.stopping || state.removed || (state.failed && this.reconcileMs === 0)) return;
    if (!this.store.roots().includes(state.root)) {
      this.dropRoot(state, true);
      return;
    }
    if (state.running) { state.dirty = true; return; }
    this.running = true;
    state.running = true;
    state.dirty = false;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = undefined;
    if (state.rescanTimer) this.clearTimer(state.rescanTimer);
    state.rescanTimer = undefined;
    if (state.failed) this.attach(state);
    const reconcileRequested = state.reconcile;
    const pending = [...state.pending];
    const queued = this.queue.listPaths(state.root);
    const hasEvents = pending.length > 0 || queued.length > 0;
    const reconcileDue = !state.lastReconcileBatchAt || this.now() - state.lastReconcileBatchAt >= 5_000;
    const initialForegroundSync = this.options.mode !== "background" && this.options.syncNow !== false && !state.lastReconcileAt;
    const batchReconcile = this.options.mode === "background" && reconcileRequested && (!hasEvents || reconcileDue);
    const fullReconcile = reconcileRequested && this.options.mode !== "background";
    if (!reconcileRequested && !hasEvents) {
      state.running = false;
      this.armRescan(state);
      return;
    }
    let exclusionForBatch: RootExclusion | undefined;
    try {
      exclusionForBatch = RootExclusion.loadSync(state.root, this.store);
      state.exclusion = exclusionForBatch;
    } catch {
      state.exclusion = this.loadExclusion(state.root);
      exclusionForBatch = undefined;
    }
    const inner: LocalUpdateOptions = {
      stableMs: this.debounceMs,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.parse ? { parse: this.options.parse } : {}),
      signal: this.abort.signal,
      ...(exclusionForBatch ? { exclusion: exclusionForBatch } : {}),
    };
    const syncOptions: SyncOptions = {
      requireRegistered: true,
      lockHeld: true,
      signal: this.abort.signal,
      ...(this.options.onProgress ? { onProgress: this.options.onProgress } : {}),
    };
    const started = this.now();
    let writerBusy = false;
    let moreLocal = false;
    let release: (() => void) | undefined;
    try {
      if (batchReconcile) {
        this.phase = "reconciling";
        const existing = this.queue.reconcileStatus(state.root);
        if (!existing || existing.phase !== "active") this.rootScanCount++;
        const result = await runBackgroundReconcileBatch(state.root, this.store, this.queue, {
          signal: this.abort.signal,
          ...(this.options.now ? { now: this.options.now } : {}),
          ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
          maxEntries: this.options.reconcileBatchEntries ?? DEFAULT_RECONCILE_BATCH_ENTRIES,
          maxMs: this.options.reconcileBatchMs ?? DEFAULT_RECONCILE_BATCH_MS,
        });
        state.reconcileGeneration = result.generation;
        state.reconcileChecked = result.checked;
        state.reconcileFrontier = result.frontierCount;
        const current = this.queue.reconcileStatus(state.root);
        if (current) {
          state.reconcileReason = current.reason;
          state.reconcileStartedAt = new Date(current.startedAtMs).toISOString();
          state.reconcileUpdatedAt = new Date(current.updatedAtMs).toISOString();
        }
        state.lastReconcileBatchAt = this.now();
        state.reconcile = !result.done || result.pendingAfter;
        state.syncFailed = !result.complete;
        if (result.done) {
          this.lastReconcile = { at: new Date(this.now()).toISOString(), root: state.root, complete: result.complete };
          state.lastReconcileAt = this.lastReconcile.at;
        }
        this.log(`背景校正：${state.root}；檢查 ${result.checked}；更新 ${result.updated}；移除 ${result.removed}；剩餘範圍 ${result.frontierCount}；完整：${result.complete ? "是" : "否"}`);
        state.busyAttempt = 0;
      } else if (fullReconcile) {
        try {
          release = acquireWriteLock(this.store.databasePath);
        } catch (error) {
          if (error instanceof IndexBusyError) {
            this.log(`INDEX_BUSY：${state.root}：稍後重試同步。`);
            writerBusy = true;
            state.dirty = true;
            state.reconcile = true;
            return;
          }
          throw error;
        }
        if (!this.store.roots().includes(state.root)) {
          this.dropRoot(state, true);
          return;
        }
        this.phase = "reconciling";
        this.rootScanCount++;
        const upTo = this.queue.maxGeneration(state.root);
        const report = await this.syncFn()(state.root, this.store, syncOptions);
        state.syncFailed = !report.complete;
        this.printReport(report);
        this.lastReconcile = { at: new Date(this.now()).toISOString(), root: state.root, complete: report.complete };
        state.lastReconcileAt = this.lastReconcile.at;
        this.ackUpTo(state.root, upTo);
        if (!state.dirty) state.reconcile = false;
        else if (!initialForegroundSync) {
          state.pending.clear();
          state.reconcile = true;
        } else {
          state.reconcile = false;
        }
      } else {
        this.phase = "updating";
        const work: LocalWorkItem[] = queued.length
          ? queued.map(item => ({ filePath: path.resolve(state.root, item.relPath), generation: item.generation, relPath: item.relPath, expand: item.reason === "expand" }))
          : pending.map(filePath => ({ filePath, generation: 0, relPath: path.relative(state.root, filePath), expand: false }));
        // 輪替（SPEC §55.2）：先處理本圈尚未處理過的待辦，全部處理過一次後開始下一圈。
        const queuedPaths = new Set(work.map(item => item.filePath));
        state.sweep = new Set([...state.sweep].filter(item => queuedPaths.has(item)));
        let order = work.filter(item => !state.sweep.has(item.filePath));
        if (!order.length) {
          state.sweep.clear();
          order = work;
        }
        // 同一圈內事件待辦先於資料夾展開出來的待辦（SPEC §56.1），各自仍先進先出。
        order = [...order.filter(item => !item.expand), ...order.filter(item => item.expand)];
        const batch = await this.applyLocalBatch(state, order.slice(0, LOCAL_BATCH_MAX_ITEMS), inner, syncOptions);
        for (const item of batch.attempted) state.sweep.add(item);
        state.pending = new Set([...state.pending].filter(item => !batch.finished.has(item)));
        moreLocal = batch.interrupted || order.length > LOCAL_BATCH_MAX_ITEMS;
        if (batch.deferred) state.dirty = true;
        this.printLocal(state.root, batch.updated, batch.unchanged, batch.removed, Math.round((this.now() - started) * 100) / 100, batch.complete);
        if (!batch.complete) state.syncFailed = true;
      }
    } catch (error) {
      if (error instanceof OperationCancelledError) {
        state.dirty = true;
      } else if (error instanceof IndexBusyError) {
        this.log(`INDEX_BUSY：${state.root}：稍後重試同步。`);
        writerBusy = true;
        state.dirty = true;
        if (batchReconcile || fullReconcile) state.reconcile = true;
        else for (const item of pending) absorb(state.pending, item);
      } else if (error instanceof RootError || error instanceof IgnoreConfigurationError) {
        state.syncFailed = true;
        state.offline = true;
        this.log(`監看同步失敗：${state.root}：根目錄同步失敗，保留既有索引`);
        this.rememberError("ROOT_SYNC_FAILED", error.message);
      } else {
        state.syncFailed = true;
        this.log(`監看同步失敗：${state.root}：根目錄同步失敗，保留既有索引`);
        this.rememberError("LIVE_UPDATE_FAILED", error instanceof Error ? error.message : "未知錯誤");
      }
    } finally {
      release?.();
      state.running = false;
      this.refreshRoots();
      if (writerBusy) this.scheduleBusy(state);
      else {
        // 同一批沒處理完的待辦立即接續，不再等防抖（SPEC §54.1）。
        if (moreLocal) this.scheduleNow(state);
        else if (state.dirty || state.pending.size || state.reconcile) {
          if (state.reconcile && batchReconcile && !state.dirty) this.scheduleNow(state);
          else this.schedule(state);
        }
        this.armRescan(state);
      }
    }
  }

  /**
   * SPEC §63：批次只在觀察 metadata 與逐份準備時不持有 writer lock；
   * 每份完成準備後才短暫取得鎖，重新確認 identity，再提交並釋放鎖。
   */
  private async applyLocalBatch(
    state: RootState,
    work: LocalWorkItem[],
    inner: LocalUpdateOptions,
    syncOptions: SyncOptions,
  ): Promise<LocalBatchResult> {
    const result: LocalBatchResult = {
      updated: 0, unchanged: 0, removed: 0, complete: true, finished: new Set(), attempted: new Set(), deferred: false, interrupted: false,
    };
    const finish = (item: LocalWorkItem, applied?: { updated: number; unchanged: number; removed: number; complete: boolean; path: string }) => {
      if (applied) {
        result.updated += applied.updated;
        result.unchanged += applied.unchanged;
        result.removed += applied.removed;
        result.complete = result.complete && applied.complete;
        if (applied.path) {
          this.lastLocalUpdate = { at: new Date(this.now()).toISOString(), root: state.root, path: applied.path };
          state.lastLocalUpdateAt = this.lastLocalUpdate.at;
        }
      }
      this.deferrals.delete(item.filePath);
      result.finished.add(item.filePath);
      result.attempted.add(item.filePath);
      if (item.generation > 0) this.ackPath(state.root, item.relPath, item.generation);
    };
    const defer = (item: LocalWorkItem) => {
      const count = (this.deferrals.get(item.filePath) ?? 0) + 1;
      if (count > UNSTABLE_BACKOFF_MS.length) {
        // 與原本退避用盡相同：保留既有索引並確認完成，之後的新事件會重新排入。
        finish(item, { updated: 0, unchanged: 0, removed: 0, complete: false, path: "" });
        return;
      }
      this.deferrals.set(item.filePath, count);
      result.deferred = true;
      result.attempted.add(item.filePath);
    };

    if (!this.store.roots().includes(state.root)) {
      this.dropRoot(state, true);
      return result;
    }
    const candidates: { item: LocalWorkItem; key: string }[] = [];
    let walkBudget = this.options.localWalkEntries ?? LOCAL_WALK_MAX_ENTRIES;
    for (const item of work) {
      if (this.stopping && !this.options.applyFileUpdate) { result.interrupted = true; break; }
      if (this.isExcluded(state, item.filePath, false)) { finish(item); continue; }
      let info: fs.Stats | undefined;
      try { info = await fs.promises.lstat(item.filePath); } catch { info = undefined; }
      if (info?.isDirectory() && !info.isSymbolicLink() && !samePath(item.filePath, state.root)) {
        if (this.isExcluded(state, item.filePath, true)) { finish(item); continue; }
        const walked = await this.expandDirectory(state, item.filePath, walkBudget);
        walkBudget = walked.budgetLeft;
        // 展開寫入的檔案待辦要由下一輪處理，所以一律立即接續。
        result.interrupted = true;
        if (walked.done) finish(item);
        else result.attempted.add(item.filePath);
        continue;
      }
      if (!info || !info.isFile()) {
        // 不存在、根目錄、連結與其他類型沿用單一路徑處理（刪除、整根校正、略過）。
        finish(item, await this.applyOne(state, item.filePath, inner, syncOptions));
        continue;
      }
      candidates.push({ item, key: identityKey(info) });
    }
    if (!candidates.length) return result;

    await (this.options.sleep ?? sleepMs)(this.debounceMs);
    // 處理時間上限從穩定等待之後起算：事件湧入時觀察階段本身可能就要數秒（SPEC §54.1）。
    const processStarted = this.now();
    const apply = this.options.applyFileUpdate;
    // 僅保留既有測試/注入 hook 的停止等待契約；正式 prepared 路徑停止後不再提交。
    const allowLegacyStop = Boolean(apply);
    let processed = 0;
    for (const { item, key } of candidates) {
      // 停止時不再開始下一份；目前 prepared 只存在此迭代範圍，避免累積文件。
      if ((this.stopping && !allowLegacyStop) || (processed > 0 && this.now() - processStarted >= LOCAL_BATCH_MAX_MS)) { result.interrupted = true; break; }
      processed++;
      let second: fs.Stats | undefined;
      try { second = await fs.promises.lstat(item.filePath); } catch { second = undefined; }
      if (!second) {
        finish(item, await this.applyOne(state, item.filePath, inner, syncOptions));
        continue;
      }
      if (identityKey(second) !== key) { defer(item); continue; }
      this.localUpdateCount++;
      if (apply) {
        const update = await withWriterBackoff(this.store.databasePath, inner, () => apply(item.filePath, state.root, this.store, {
          ...inner, lockHeld: true, stableMs: 0, deferUnstable: true,
        }));
        if (this.stopping && !allowLegacyStop) { result.interrupted = true; break; }
        if (update.deferred) { defer(item); continue; }
        finish(item, { updated: update.updated, unchanged: update.unchanged, removed: update.removed, complete: update.complete, path: item.filePath });
        continue;
      }

      // 不建立 prepared[]：一次只保留目前這份 DocumentRecord，提交後才進下一份。
      const prepared = await prepareFileUpdate(item.filePath, state.root, this.store, {
        ...inner, stableMs: 0, deferUnstable: true,
      }, second);
      if (this.stopping) { result.interrupted = true; break; }
      if (prepared.kind === "result") {
        if (prepared.result.deferred) defer(item);
        else finish(item, {
          updated: prepared.result.updated, unchanged: prepared.result.unchanged,
          removed: prepared.result.removed, complete: prepared.result.complete, path: prepared.result.path,
        });
        continue;
      }
      const update = await this.commitPrepared(prepared, inner);
      if (this.stopping) { result.interrupted = true; break; }
      if (update.deferred) { defer(item); continue; }
      finish(item, { updated: update.updated, unchanged: update.unchanged, removed: update.removed, complete: update.complete, path: item.filePath });
    }
    return result;
  }

  /**
   * SPEC §56：資料夾待辦逐步展開成逐檔待辦，每輪最多讀取 `budget` 個目錄項目。
   * 完成且沒有讀取失敗時，才把索引中未看到、且確認已不存在的文件排入刪除。
   */
  private async expandDirectory(state: RootState, dir: string, budget: number): Promise<{ done: boolean; budgetLeft: number }> {
    let walk = state.walks.get(dir);
    if (!walk) {
      walk = { frontier: [dir], listing: undefined, seen: new Set(), failed: false };
      state.walks.set(dir, walk);
      this.subtreeScanCount++;
    }
    while ((walk.listing || walk.frontier.length) && budget > 0) {
      if (this.stopping) return { done: false, budgetLeft: budget };
      if (!walk.listing) {
        // readdir 一次回傳整份清單；讀到一半的清單留在展開狀態，下一輪從中斷處接續。
        const current = walk.frontier.pop()!;
        try {
          walk.listing = { dir: current, entries: await fs.promises.readdir(current, { withFileTypes: true }), next: 0 };
        } catch {
          walk.failed = true;
          continue;
        }
      }
      const listing = walk.listing;
      while (listing.next < listing.entries.length && budget > 0) {
        const entry = listing.entries[listing.next++]!;
        budget--;
        const full = path.join(listing.dir, entry.name);
        if (entry.isSymbolicLink() || shouldIgnoreWatchPath(full, state.root)) continue;
        if (entry.isDirectory()) {
          if (!this.isExcluded(state, full, true)) walk.frontier.push(full);
          continue;
        }
        if (!entry.isFile() || this.isExcluded(state, full, false) || isIndexArtifact(full, this.store.databasePath)) continue;
        walk.seen.add(full);
        if (!this.persistPath(state, full, "expand")) return { done: true, budgetLeft: budget };
      }
      if (listing.next >= listing.entries.length) walk.listing = undefined;
      if (this.overflowRoot(state)) {
        // 超過佇列上限：改由背景校正處理整根，展開不必繼續（SPEC §56.1）。
        state.walks.clear();
        this.markReconcile(state);
        return { done: true, budgetLeft: budget };
      }
    }
    if (walk.listing || walk.frontier.length) return { done: false, budgetLeft: budget };
    state.walks.delete(dir);
    if (walk.failed) return { done: true, budgetLeft: budget };
    for (const indexed of this.store.documentPathsUnder(state.root, dir)) {
      if (walk.seen.has(indexed)) continue;
      try {
        await fs.promises.lstat(indexed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") this.persistPath(state, indexed, "expand");
      }
    }
    return { done: true, budgetLeft: budget };
  }

  private async commitPrepared(prepared: PreparedFileUpdate, options: LocalUpdateOptions): Promise<LocalUpdateResult> {
    const release = acquireWriteLock(this.store.databasePath);
    try {
      return await commitPreparedFileUpdateLocked(prepared, this.store, {
        ...options, lockHeld: true, stableMs: 0, deferUnstable: true,
      });
    } finally {
      release();
    }
  }

  private async applyOne(
    state: RootState,
    filePath: string,
    localOpts: LocalUpdateOptions,
    syncOptions: SyncOptions,
  ): Promise<{ updated: number; unchanged: number; removed: number; complete: boolean; path: string }> {
    return withWriterBackoff(this.store.databasePath, localOpts, async () => {
      const locked = { ...localOpts, lockHeld: true };
      let info: fs.Stats | undefined;
      try {
        info = await fs.promises.lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.localUpdateCount++;
          const del = await (this.options.applyFileDelete ?? applyFileDelete)(filePath, state.root, this.store, locked);
          return { updated: 0, unchanged: 0, removed: del.removed, complete: del.complete, path: filePath };
        }
        this.localUpdateCount++;
        const change = await applyPathChange(filePath, state.root, this.store, locked);
        return { updated: change.updated, unchanged: change.unchanged, removed: change.removed, complete: change.complete, path: filePath };
      }
      if (info.isSymbolicLink()) return { updated: 0, unchanged: 0, removed: 0, complete: true, path: filePath };
      if (info.isDirectory()) {
        if (this.isExcluded(state, filePath, true)) return { updated: 0, unchanged: 0, removed: 0, complete: true, path: "" };
        if (samePath(filePath, state.root)) this.rootScanCount++;
        else this.subtreeScanCount++;
        const report = await this.syncFn()(filePath, this.store, { ...syncOptions, lockHeld: true, requireRegistered: false });
        this.lastReconcile = { at: new Date(this.now()).toISOString(), root: state.root, complete: report.complete };
        return { updated: report.updated, unchanged: report.unchanged, removed: report.removed, complete: report.complete, path: filePath };
      }
      this.localUpdateCount++;
      const update = await (this.options.applyFileUpdate ?? applyFileUpdate)(filePath, state.root, this.store, locked);
      return { updated: update.updated, unchanged: update.unchanged, removed: update.removed, complete: update.complete, path: filePath };
    });
  }

  private scheduleBusy(state: RootState): void {
    if (this.stopping || state.removed) return;
    const delay = WRITER_BACKOFF_MS[Math.min(state.busyAttempt, WRITER_BACKOFF_MS.length - 1)]!;
    state.busyAttempt++;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      this.enqueueReady(state.root);
    }, delay);
  }

  /** 0 ms 計時器：背景校正下一批或局部更新下一輪。 */
  private scheduleNow(state: RootState): void {
    if (this.stopping || state.removed || state.running) return;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      this.enqueueReady(state.root);
    }, 0);
  }

  private schedule(state: RootState): void {
    if (this.stopping || state.removed || (state.failed && this.reconcileMs === 0)) return;
    state.dirty = true;
    if (state.running) return;
    if (state.timer) this.clearTimer(state.timer);
    const now = this.now();
    state.firstScheduledAt ??= now;
    const remaining = state.firstScheduledAt + this.debounceMs * DEBOUNCE_MAX_WAIT_FACTOR - now;
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      state.firstScheduledAt = undefined;
      this.enqueueReady(state.root);
    }, Math.max(0, Math.min(this.debounceMs, remaining)));
  }

  private armRescan(state: RootState): void {
    if (!this.reconcileMs || this.stopping || state.removed || state.running) return;
    if (state.rescanTimer) this.clearTimer(state.rescanTimer);
    state.rescanTimer = this.setTimer(() => {
      state.rescanTimer = undefined;
      if (this.options.verbose || this.options.mode === "background") this.log(`定期校正：${state.root}`);
      state.reconcile = true;
      this.enqueueReady(state.root);
    }, this.reconcileMs);
  }

  private armWatcherRetry(state: RootState): void {
    if (this.options.mode !== "background" || this.stopping || state.removed) return;
    if (state.retryTimer) this.clearTimer(state.retryTimer);
    const delay = WATCHER_RETRY_MS[Math.min(state.retryAttempt, WATCHER_RETRY_MS.length - 1)]!;
    state.retryAttempt++;
    state.retryTimer = this.setTimer(() => {
      state.retryTimer = undefined;
      this.attach(state);
    }, delay);
  }

  private dropRoot(state: RootState, announce: boolean): void {
    state.removed = true;
    if (state.timer) this.clearTimer(state.timer);
    if (state.rescanTimer) this.clearTimer(state.rescanTimer);
    if (state.retryTimer) this.clearTimer(state.retryTimer);
    state.pending.clear();
    try { this.queue.isolateRoot(state.root); } catch (error) { this.onQueueFailure(state, error); }
    this.closeHandles(state);
    if (announce) {
      const parent = this.store.findMergedParent(state.root);
      this.log(parent
        ? `已停止監看已合併的根目錄：${state.root}；請以新根 ${parent} 重新啟動監看。`
        : `已停止監看移除的根目錄：${state.root}`);
    }
    if ([...this.states.values()].every(item => item.removed)) this.allFailed();
  }

  private failRoot(state: RootState, error: unknown): void {
    if (state.failed || this.stopping) return;
    state.failed = true;
    state.lastError = error instanceof Error ? error.message : "未知錯誤";
    if (state.timer) this.clearTimer(state.timer);
    state.timer = undefined;
    this.closeHandles(state);
    this.log(`監看錯誤：${state.root}：${state.lastError}`);
    this.rememberError("WATCH_ERROR", state.lastError);
    if (this.reconcileMs) {
      this.log(`降級定期掃描：${state.root}（${this.reconcileMs} ms 後校正並重試監看）`);
      this.armRescan(state);
      this.armWatcherRetry(state);
    } else if ([...this.states.values()].every(item => item.failed || item.removed)) this.allFailed();
  }

  private attach(state: RootState): void {
    const recovering = state.failed;
    this.closeHandles(state);
    const children = this.listChildDirectories(state);
    const needed = 1 + children.length;
    const available = this.watchHandleLimit - this.totalHandles();
    if (needed > available) {
      this.attachCoarse(state, recovering, `句柄上限 ${this.watchHandleLimit}`);
      return;
    }
    try {
      this.attachSplit(state, children, recovering);
    } catch (error) {
      this.closeHandles(state);
      this.attachCoarse(state, recovering, error instanceof Error ? error.message : "分割監看失敗");
    }
  }

  private attachSplit(state: RootState, children: string[], recovering: boolean): void {
    this.attachWatch(state, state.root, false);
    for (const child of children) this.attachWatch(state, child, true);
    state.scopeMode = "split";
    state.failed = false;
    state.offline = false;
    state.retryAttempt = 0;
    this.logWatch(state, recovering);
    if (recovering && this.options.mode === "background") {
      state.reconcile = true;
      this.schedule(state);
    }
  }

  private attachCoarse(state: RootState, recovering: boolean, reason: string): void {
    try {
      this.closeHandles(state);
      this.attachWatch(state, state.root, true);
      state.scopeMode = "coarse";
      state.failed = false;
      state.offline = false;
      state.retryAttempt = 0;
      this.log(`${recovering ? "監看恢復" : "監看中"}：${state.root}（範圍 coarse，句柄 ${state.handles.length}，防抖 ${this.debounceMs} ms；${reason}）`);
      if (recovering && this.options.mode === "background") {
        state.reconcile = true;
        this.schedule(state);
      }
    } catch (error) {
      try {
        const info = fs.statSync(state.root);
        if (!info.isDirectory()) state.offline = true;
      } catch { state.offline = true; }
      if (!state.failed) this.failRoot(state, error);
    }
  }

  private attachWatch(state: RootState, dir: string, recursive: boolean): WatchHandle {
    const watchFn = this.options.watch ?? fs.watch;
    const watcher = watchFn(dir, { recursive }, (event, filename) => {
      if (this.stopping || state.failed || state.removed) return;
      this.handleEvent(state, filename, dir, event);
    });
    const handle: WatchHandle = { path: dir, recursive, watcher };
    watcher.on("error", error => {
      if (samePath(dir, state.root)) this.failRoot(state, error);
      else this.failHandle(state, handle, error);
    });
    state.handles.push(handle);
    if (samePath(dir, state.root)) state.watcher = watcher;
    return handle;
  }

  private logWatch(state: RootState, recovering: boolean): void {
    this.log(`${recovering ? "監看恢復" : "監看中"}：${state.root}（範圍 ${state.scopeMode}，句柄 ${state.handles.length}，防抖 ${this.debounceMs} ms）`);
  }

  private totalHandles(): number {
    let total = 0;
    for (const item of this.states.values()) total += item.handles.length;
    return total;
  }

  private closeHandles(state: RootState): void {
    for (const handle of state.handles) {
      try { handle.watcher.close(); } catch { /* 回收失效句柄 */ }
    }
    state.handles = [];
    delete state.watcher;
  }

  private listChildDirectories(state: RootState): string[] {
    const root = state.root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const children: string[] = [];
    for (const entry of entries) {
      if (shouldIgnoreWatchPath(entry.name, root)) continue;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const child = path.join(root, entry.name);
      if (this.isExcluded(state, child, true)) continue;
      children.push(child);
    }
    return children;
  }

  private failHandle(state: RootState, handle: WatchHandle, error: unknown): void {
    if (state.removed || this.stopping) return;
    const message = error instanceof Error ? error.message : "未知錯誤";
    this.log(`監看錯誤：${handle.path}：${message}`);
    this.rememberError("WATCH_SCOPE_ERROR", message);
    this.persistPath(state, handle.path);
    absorb(state.pending, handle.path);
    this.schedule(state);
    try { handle.watcher.close(); } catch { /* ignore */ }
    state.handles = state.handles.filter(item => item !== handle);
    if (samePath(handle.path, state.root)) {
      this.failRoot(state, error);
      return;
    }
    try {
      this.attachWatch(state, handle.path, true);
    } catch {
      this.closeHandles(state);
      this.attachCoarse(state, false, "子範圍失敗");
      this.persistScope(state, "scope-fallback");
      this.markReconcile(state);
      this.schedule(state);
    }
  }

  private ensureChildWatch(state: RootState, dir: string): void {
    if (state.scopeMode !== "split") return;
    if (state.handles.some(handle => samePath(handle.path, dir))) return;
    if (this.totalHandles() >= this.watchHandleLimit) {
      this.closeHandles(state);
      this.attachCoarse(state, false, "句柄上限");
      this.persistScope(state, "scope-fallback");
      this.markReconcile(state);
      this.schedule(state);
      return;
    }
    try {
      this.attachWatch(state, dir, true);
    } catch {
      // 短暫存在的目錄在 attach 前已消失：路徑已排入待辦核對，不必退回 coarse（SPEC §53.2）。
      if (!fs.existsSync(dir)) return;
      this.closeHandles(state);
      this.attachCoarse(state, false, "新目錄 attach 失敗");
      this.persistScope(state, "scope-fallback");
      this.markReconcile(state);
      this.schedule(state);
    }
  }

  private releaseChildWatch(state: RootState, dir: string): void {
    const handle = state.handles.find(item => samePath(item.path, dir));
    if (!handle || samePath(handle.path, state.root)) return;
    this.persistPath(state, dir);
    absorb(state.pending, dir);
    this.schedule(state);
    try { handle.watcher.close(); } catch { /* ignore */ }
    state.handles = state.handles.filter(item => item !== handle);
  }

  /**
   * 資料夾的 `change` 只代表其中項目變動，而那些項目已各自產生事件；內容已在監看範圍內時
   * 掃描整個子樹是重複工作（SPEC §55）。移入的資料夾以 `rename` 回報，仍須掃描。
   */
  private contentAlreadyWatched(state: RootState, dir: string): boolean {
    if (state.scopeMode === "coarse") return true;
    if (!samePath(path.dirname(dir), state.root)) return true;
    return state.handles.some(handle => handle.recursive && samePath(handle.path, dir));
  }

  private handleEvent(
    state: RootState,
    filename: string | Buffer | null | undefined,
    watchDir = state.root,
    eventType: fs.WatchEventType = "rename",
  ): void {
    const label = filename ? String(filename) : "";
    if (label && shouldIgnoreWatchPath(label, watchDir)) return;
    const abs = label ? path.resolve(watchDir, label) : undefined;
    if (abs && this.isExcluded(state, abs, false)) {
      this.excludedEventCount++;
      return;
    }
    let info: fs.Stats | undefined;
    let missing = false;
    if (abs) {
      try { info = fs.lstatSync(abs); } catch { missing = true; }
      // 只排除目錄的規則（例如 `/AppData/`）需要知道路徑本身是目錄。
      if (info?.isDirectory() && this.isExcluded(state, abs, true)) {
        this.excludedEventCount++;
        return;
      }
      if (eventType === "change" && info?.isDirectory() && !info.isSymbolicLink()
        && !samePath(abs, state.root) && this.contentAlreadyWatched(state, abs)) return;
    }
    this.eventCount++;
    const at = new Date(this.now()).toISOString();
    state.lastEventAt = at;
    this.lastEvent = { at, root: state.root };
    if (this.options.verbose) this.log(`變更：${watchDir}${label ? path.sep + label : ""} @${this.now()}`);
    if (!label) {
      if (samePath(watchDir, state.root)) {
        this.persistScope(state, "unknown-filename");
        this.markReconcile(state);
      } else {
        this.persistPath(state, watchDir);
        absorb(state.pending, watchDir);
      }
      this.schedule(state);
      return;
    }
    if (!abs || (!coversPath(state.root, abs) && !samePath(state.root, abs))) return;
    if (samePath(abs, state.root) || isIgnoreFile(abs) || path.basename(abs) === IGNORE_FILE) {
      if (!samePath(abs, state.root)) {
        // 規則變更：依新規則重建 split 監看範圍，整根校正補上交接窗口（SPEC §53.2）。
        state.exclusion = this.loadExclusion(state.root);
        this.attach(state);
      }
      this.persistScope(state, "root-or-ignore");
      this.markReconcile(state);
      this.schedule(state);
      return;
    }
    if (missing) this.releaseChildWatch(state, abs);
    if (info?.isDirectory() && !info.isSymbolicLink() && samePath(path.dirname(abs), state.root)) {
      this.ensureChildWatch(state, abs);
    }
    if (!this.persistPath(state, abs)) return;
    absorb(state.pending, abs);
    if (this.overflowRoot(state)) this.markReconcile(state);
    this.schedule(state);
  }

  private persistPath(state: RootState, abs: string, reason: "event" | "expand" = "event"): boolean {
    try {
      this.queue.acceptPath(state.root, path.relative(state.root, abs), reason);
      return true;
    } catch (error) {
      this.onQueueFailure(state, error);
      return false;
    }
  }

  private persistScope(state: RootState, reason: string): void {
    try { this.queue.markDirtyScope(state.root, reason); }
    catch (error) { this.onQueueFailure(state, error); }
  }

  private overflowRoot(state: RootState): boolean {
    try { return this.queue.overflowIfNeeded(state.root); }
    catch (error) {
      this.onQueueFailure(state, error);
      return false;
    }
  }

  private ackPath(root: string, relPath: string, generation: number): void {
    try { this.queue.ack(root, relPath, generation); }
    catch (error) {
      this.queueDegraded = true;
      this.rememberError("QUEUE_ACK_FAILED", error instanceof Error ? error.message : "ack 失敗");
    }
  }

  private ackUpTo(root: string, generation: number): void {
    try { this.queue.ackUpTo(root, generation); }
    catch (error) {
      this.queueDegraded = true;
      this.rememberError("QUEUE_ACK_FAILED", error instanceof Error ? error.message : "ack 失敗");
    }
  }

  private onQueueFailure(state: RootState, error: unknown): void {
    this.queueDegraded = true;
    const message = error instanceof QueuePersistError || error instanceof Error ? error.message : "工作佇列無法落盤。";
    this.rememberError("QUEUE_PERSIST_FAILED", message);
    this.failRoot(state, error instanceof Error ? error : new QueuePersistError(message));
  }

  private hydrateFromQueue(): void {
    for (const state of this.states.values()) {
      if (this.queue.reopened) {
        try { this.queue.markDowntimeGap(state.root); }
        catch (error) { this.onQueueFailure(state, error); continue; }
        state.reconcile = true;
      } else if (this.queue.hasScope(state.root)) state.reconcile = true;
      for (const item of this.queue.listPaths(state.root)) {
        absorb(state.pending, path.resolve(state.root, item.relPath));
      }
    }
  }

  private markReconcile(state: RootState): void {
    state.reconcile = true;
    state.pending.clear();
  }

  refreshRoots(): void {
    if (this.stopping) return;
    const live = this.store.roots();
    for (const state of this.states.values()) {
      if (!live.includes(state.root) && !state.removed) this.dropRoot(state, true);
    }
    if (this.options.mode !== "background") return;
    for (const root of live) {
      if (this.states.has(root)) continue;
      const state = this.newState(root);
      this.states.set(root, state);
      this.attach(state);
      state.reconcile = true;
      this.schedule(state);
    }
  }

  private armHeartbeat(): void {
    if (this.options.mode !== "background" || this.stopping) return;
    if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.setTimer(() => {
      this.lastHeartbeatAt = new Date(this.now()).toISOString();
      this.armHeartbeat();
    }, HEARTBEAT_MS);
  }

  private armRootRefresh(): void {
    if (this.options.mode !== "background" || this.stopping) return;
    if (this.refreshTimer) this.clearTimer(this.refreshTimer);
    this.refreshTimer = this.setTimer(() => {
      this.refreshRoots();
      this.armRootRefresh();
    }, ROOT_REFRESH_MS);
  }

  async run(): Promise<number> {
    if (!this.states.size) throw new WatchError("WATCH_NO_ROOTS", "沒有可監看的根目錄；請先執行 index <root>。");
    const stop = Promise.resolve().then(() => this.io.waitForStop()).finally(() => { this.stopping = true; this.phase = "stopping"; });
    try {
      for (const state of this.states.values()) this.attach(state);
      if (!this.reconcileMs && [...this.states.values()].every(state => state.failed)) {
        throw new WatchError("WATCH_ALL_FAILED", "所有根目錄都無法監看。");
      }
      this.phase = "idle";
      this.lastHeartbeatAt = new Date(this.now()).toISOString();
      this.armHeartbeat();
      this.armRootRefresh();
      this.hydrateFromQueue();
      if (this.options.syncNow !== false) {
        for (const state of this.states.values()) {
          if (this.stopping) break;
          if (state.failed && !this.reconcileMs) continue;
          this.log(`啟動同步：${state.root}`);
          state.reconcile = true;
          this.running = true;
          try { await this.runRoot(state); }
          finally { this.running = false; }
        }
      } else {
        for (const state of this.states.values()) {
          if (this.stopping) break;
          if (!state.reconcile && !state.pending.size) continue;
          this.running = true;
          try { await this.runRoot(state); }
          finally { this.running = false; }
        }
      }
      for (const state of this.states.values()) this.armRescan(state);
      this.log(this.reconcileMs ? `定期校正間隔：${this.reconcileMs} ms（同步完成後起算）。` : "定期校正已關閉。");
      if (this.options.mode === "foreground") this.log("按 Ctrl+C 結束監看。");
      await Promise.race([stop, this.failed]);
    } finally {
      this.stopping = true;
      this.phase = "stopping";
      if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer);
      if (this.refreshTimer) this.clearTimer(this.refreshTimer);
      for (const state of this.states.values()) {
        if (state.timer) this.clearTimer(state.timer);
        if (state.rescanTimer) this.clearTimer(state.rescanTimer);
        if (state.retryTimer) this.clearTimer(state.retryTimer);
        this.closeHandles(state);
      }
      await Promise.allSettled(this.active);
      if (this.ownsQueue) this.queue.close();
    }
    return [...this.states.values()].some(state => !state.removed && (state.failed || state.syncFailed || this.queueDegraded)) ? 3 : 0;
  }
}

export async function runLiveUpdate(
  store: IndexStore,
  roots: readonly string[],
  options: LiveUpdateOptions,
  io: LiveIO,
): Promise<number> {
  return new LiveUpdateEngine(store, roots, options, io).run();
}
