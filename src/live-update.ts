import fs from "node:fs";
import path from "node:path";
import { acquireWriteLock, IndexBusyError, isSqliteBusy } from "./write-lock.js";
import { describeIndexClientError } from "./index-errors.js";
import { IGNORE_FILE, IgnoreConfigurationError } from "./ignore.js";
import { isIndexArtifact, type IndexStore } from "./store.js";
import { sync, type SyncOptions, type SyncReport } from "./sync.js";
import {
  applyPathChange, applyFileDelete, applyFileUpdate, commitPreparedFileUpdateLocked, commitPreparedFileUpdatesLocked, identityKey,
  isIgnoreFile, prepareFileUpdate, sleepMs, UNSTABLE_BACKOFF_MS, WRITER_BACKOFF_MS, withWriterBackoff,
  type LocalUpdateOptions, type LocalUpdateResult, type PreparedFileUpdate,
} from "./local-update.js";
import { coversPath, runtimePathPlatform, samePath } from "./root-plan.js";
import { RootError } from "./scanner.js";
import { OperationCancelledError, throwIfAborted, type ProgressUpdate } from "./progress.js";
import { shouldIgnoreWatchPath } from "./watch-path.js";
import type { LiveMode, LivePhase, LiveRootStatus, LiveStatus, LiveTimingSample, RootWatchState } from "./autoupdate-control.js";
import { DEFAULT_QUEUE_LIMIT, LiveWorkQueue, QueuePersistError, type LiveWorkQueueOptions } from "./live-queue.js";
import { RootExclusion } from "./root-exclusion.js";
import { runBackgroundReconcileBatch, DEFAULT_RECONCILE_BATCH_ENTRIES, DEFAULT_RECONCILE_BATCH_MS } from "./reconcile.js";
import { resolveStartupCatchupMode, type StartupCatchupAction, type StartupCatchupMode, type StartupCatchupState } from "./startup-catchup.js";

export const DEFAULT_DEBOUNCE_MS = 1500;
export const DEFAULT_WATCH_RESCAN_MS = 300_000;
export const DEFAULT_RECONCILE_MS = 21_600_000;
export const QUEUE_LIMIT = DEFAULT_QUEUE_LIMIT;
export const DEFAULT_WATCH_HANDLE_LIMIT = 128;
/** 事件不間斷時，防抖最長等待「防抖時間 × 此倍數」就開始處理（SPEC §53.4）。 */
export const DEBOUNCE_MAX_WAIT_FACTOR = 10;
/** 背景校正批次之間的公平到期時間（SPEC §68.1）。 */
export const BACKGROUND_RECONCILE_INTERVAL_MS = 5_000;
/** 局部更新每輪上限；輪與輪之間釋放 writer lock（SPEC §54.1）。 */
export const LOCAL_BATCH_MAX_ITEMS = 500;
export const LOCAL_BATCH_MAX_MS = 5_000;
/** 穩定候選超過一批時，保留最新的尾端工作；其餘名額取最舊工作（SPEC §73、D105）。 */
const LOCAL_BATCH_NEWEST_ITEMS = 100;
/** 已準備文件群組在一次 writer lock 內提交的數量與準備時間上限（SPEC §63）。 */
export const LOCAL_PREPARED_GROUP_MAX_ITEMS = 50;
export const LOCAL_PREPARED_GROUP_MAX_MS = 250;
/** 群組持鎖內的主庫 busy 短重試；用盡後交給 root catch，不在 writer lock 內無限等待。 */
export const PREPARED_COMMIT_BUSY_RETRY_MS = [50, 100] as const;
/** 同時保留的已準備文件文字預算；超過時先提交目前群組（SPEC §63）。 */
export const LOCAL_PREPARED_MAX_TEXT_CHARS = 8_000_000;
/** 資料夾展開每輪最多讀取的目錄項目數（SPEC §56.1）。 */
export const LOCAL_WALK_MAX_ENTRIES = 2_000;
export const HEARTBEAT_MS = 10_000;
export const ROOT_REFRESH_MS = 10_000;
export const WATCHER_RETRY_MS = [60_000, 300_000, 900_000] as const;
/** 空檔名事件的預設同一 watchDir 冷卻時間。 */
export const UNKNOWN_FILENAME_RESCAN_COOLDOWN_MS = 5_000;
/** 空檔名補掃的視窗與每一視窗上限。 */
export const UNKNOWN_FILENAME_RESCAN_WINDOW_MS = 60_000;
export const UNKNOWN_FILENAME_RESCAN_MAX_PER_WINDOW = 4;
/** 達到視窗上限後的有限退避。 */
export const UNKNOWN_FILENAME_RESCAN_BACKOFF_MS = [5_000, 15_000, 60_000] as const;
/** 每根目錄保留的空檔名 watchDir 狀態上限；超出時以最久未使用項目淘汰。 */
export const MAX_UNCERTAIN_RESCAN_STATES_PER_ROOT = 1024;
type UncertainRescanState = {
  windowStartedAt: number;
  accepted: number;
  nextAllowedAt: number;
  backoffIndex: number;
};

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
  startupCatchupMode?: StartupCatchupMode;
  watch?: typeof fs.watch;
  /** watcher callback 的同步 lstat 注入點；正式路徑使用 fs.lstatSync，測試可計數。 */
  lstatSync?: typeof fs.lstatSync;
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
  /** 空檔名補掃測試／部署可調的有界參數；未指定時使用 §86 預設值。 */
  uncertainRescanCooldownMs?: number;
  uncertainRescanWindowMs?: number;
  uncertainRescanMaxPerWindow?: number;
  uncertainRescanBackoffMs?: readonly number[];
  /** 資料夾展開的 readdir 注入點；正式路徑使用 fs.promises.readdir，測試可模擬暫時不可讀。 */
  readdir?: (directory: fs.PathLike) => Promise<fs.Dirent[]>;
}

type StableObservation = { at: number };
type LocalWorkItem = { filePath: string; generation: number; relPath: string; expand: boolean; stableSince?: StableObservation };

function localWorkKey(item: Pick<LocalWorkItem, "filePath" | "generation">): string {
  return `${item.filePath}\u0000${item.generation}`;
}

type PreparedLocalItem = {
  item: LocalWorkItem;
  prepared: PreparedFileUpdate;
  textChars: number;
};

function preparedDocumentCharacters(prepared: PreparedFileUpdate): number {
  if (prepared.kind !== "file" || !prepared.document) return 0;
  let characters = 0;
  for (const block of prepared.document.blocks) {
    characters += block.content.length + (block.heading?.length ?? 0);
  }
  return characters;
}

type LocalBatchTiming = {
  stableWaitMs: number;
  enumerateMs: number;
  lockMs: number;
  commitMs: number;
};

type LocalBatchResult = {
  updated: number;
  unchanged: number;
  removed: number;
  complete: boolean;
  /** 已確認完成（含延後用盡）的路徑；其餘留在佇列。 */
  finished: Set<string>;
  /** 本輪處理過的工作項（完成或延後），記入輪替的本圈。 */
  attempted: Set<string>;
  deferred: boolean;
  interrupted: boolean;
  timing: LocalBatchTiming;
  /** 本批已提交部分完成後，交給 root catch 的原始 busy 錯誤。 */
  busy?: unknown;
};

class PreparedBatchBusyError extends Error {
  constructor(
    readonly completed: readonly LocalUpdateResult[],
    readonly busyError: unknown,
  ) {
    super("prepared local update group exhausted its bounded SQLite busy retries");
    this.name = "PreparedBatchBusyError";
  }
}

type WatchHandle = {
  path: string;
  recursive: boolean;
  watcher: fs.FSWatcher;
};

type RootState = {
  root: string;
  pending: Set<string>;
  reconcile: boolean;
  /** 校正批次處理過同時存在的事件後，下一輪優先走 local branch（SPEC §68.1）。 */
  localPriority: boolean;
  dirty: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  firstScheduledAt: number | undefined;
  firstEventClock?: number;
  /** 事件／工作佇列項目進入穩定觀察的時間；只存在記憶體。 */
  stableSince: Map<string, StableObservation>;
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
  reconcileSkippedByRule?: Record<string, number>;
  exclusionCleanup?: { removed: number; pending: number };
  lastReconcileBatchAt?: number;
  degradedChildren: Map<string, string>;
  uncertainRescans: Map<string, UncertainRescanState>;
  emptyFilenameEventCount: number;
  uncertainRescanCount: number;
  lastUncertainRescanAt?: string;
  lastTiming?: LiveTimingSample;
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

function absorb(pending: Set<string>, candidate: string, stableSince?: Map<string, StableObservation>): void {
  for (const existing of pending) {
    if (samePath(existing, candidate)) return;
    if (coversPath(existing, candidate)) {
      stableSince?.delete(candidate);
      return;
    }
  }
  for (const existing of [...pending]) {
    if (coversPath(candidate, existing)) {
      pending.delete(existing);
      stableSince?.delete(existing);
    }
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
  /** 路徑目前被延後的工作項 generation；新 generation 不繼承舊延後狀態。 */
  private readonly deferredGenerations = new Map<string, number>();
  private localUpdateCount = 0;
  private rootScanCount = 0;
  private subtreeScanCount = 0;
  private emptyFilenameEventCount = 0;
  private uncertainRescanCount = 0;
  private lastUncertainRescanAt?: string;

  private queueDegraded = false;
  private readonly startupCatchupMode: StartupCatchupMode;
  private startupCatchupState: StartupCatchupState = "none";
  private readonly startupCatchupRoots = new Set<string>();
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
    this.startupCatchupMode = resolveStartupCatchupMode(options.startupCatchupMode);
    this.lastHeartbeatAt = new Date(this.now()).toISOString();
    this.abort = new AbortController();
    this.failed = new Promise<void>(resolve => { this.allFailed = resolve; });
    this.ownsQueue = !options.workQueue;
    this.queue = options.workQueue ?? new LiveWorkQueue(store.databasePath, {
      now: () => this.now(),
      ...(options.queueLimit !== undefined ? { limit: options.queueLimit } : {}),
      ...(options.queuePersistHook ? { persistHook: options.queuePersistHook } : {}),
    });
    const activeRoots = store.roots();
    try {
      const cleanup = this.queue.cleanupOrphanRoots(activeRoots);
      if (cleanup.roots > 0) {
        this.log(`工作佇列清理孤兒根目錄：根 ${cleanup.roots}；work_items ${cleanup.workItems}；reconcile_state ${cleanup.reconcileStates}；reconcile_seen ${cleanup.reconcileSeen}`);
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "工作佇列清理失敗。";
      const displayMessage = describeIndexClientError(error) ?? rawMessage;
      this.log(`工作佇列清理孤兒根目錄失敗：${displayMessage}；孤兒工作狀態仍可能保留，待辦／最舊時間可能暫時受污染；下一次 engine 啟動會再試。`);
      this.rememberError("QUEUE_CLEANUP_FAILED", rawMessage, error);
    }
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
  private get uncertainRescanCooldownMs(): number {
    const value = this.options.uncertainRescanCooldownMs ?? UNKNOWN_FILENAME_RESCAN_COOLDOWN_MS;
    return Number.isSafeInteger(value) && value >= 0 ? value : UNKNOWN_FILENAME_RESCAN_COOLDOWN_MS;
  }

  private get uncertainRescanWindowMs(): number {
    const value = this.options.uncertainRescanWindowMs ?? UNKNOWN_FILENAME_RESCAN_WINDOW_MS;
    return Number.isSafeInteger(value) && value > 0 ? value : UNKNOWN_FILENAME_RESCAN_WINDOW_MS;
  }

  private get uncertainRescanMaxPerWindow(): number {
    const value = this.options.uncertainRescanMaxPerWindow ?? UNKNOWN_FILENAME_RESCAN_MAX_PER_WINDOW;
    return Number.isSafeInteger(value) && value > 0 ? value : UNKNOWN_FILENAME_RESCAN_MAX_PER_WINDOW;
  }

  private get uncertainRescanBackoffMs(): readonly number[] {
    const value = this.options.uncertainRescanBackoffMs;
    return value && value.length > 0 && value.every(item => Number.isSafeInteger(item) && item >= 0)
      ? value
      : UNKNOWN_FILENAME_RESCAN_BACKOFF_MS;
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

  private rememberError(code: string, message: string, error?: unknown): void {
    const classified = describeIndexClientError(error ?? message);
    this.recentErrors.push(classified ?? `${code}: ${message}`);
    if (this.recentErrors.length > 20) this.recentErrors.shift();
  }

  private newState(root: string): RootState {
    return {
      root, pending: new Set(), reconcile: false, localPriority: false, dirty: false, running: false,
      timer: undefined, firstScheduledAt: undefined, exclusion: this.loadExclusion(root), stableSince: new Map(), sweep: new Set(), walks: new Map(), failed: false, offline: false, syncFailed: false, removed: false,
      handles: [], scopeMode: "split",
      rescanTimer: undefined, retryTimer: undefined, retryAttempt: 0, busyAttempt: 0,
      degradedChildren: new Map(), uncertainRescans: new Map(), emptyFilenameEventCount: 0, uncertainRescanCount: 0,
    };
  }

  /** 規則檔設定錯誤時只套用內建排除；同步會依既有規則回報根目錄失敗。 */
  private loadExclusion(root: string): RootExclusion {
    try {
      return RootExclusion.loadSync(root, this.store);
    } catch {
      return RootExclusion.builtinOnly(root, this.store.databasePath);
    }
  }

  private isExcluded(state: RootState, absPath: string, isDirectory: boolean, isLink = false): boolean {
    return state.exclusion.excludes(absPath, isDirectory, isLink);
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
        degradedSubdirectories: [...state.degradedChildren.entries()].map(([childPath, reason]) => ({ path: childPath, reason })),
        emptyFilenameEventCount: state.emptyFilenameEventCount,
        uncertainRescanCount: state.uncertainRescanCount,
        uncertainRescanStateCount: state.uncertainRescans.size,
        ...(state.lastUncertainRescanAt ? { lastUncertainRescanAt: state.lastUncertainRescanAt } : {}),
        ...(state.lastTiming ? { lastTiming: { ...state.lastTiming } } : {}),
        ...(state.reconcileSkippedByRule ? { skippedByRule: { ...state.reconcileSkippedByRule } } : {}),
        ...(state.exclusionCleanup ? { exclusionCleanup: { ...state.exclusionCleanup } } : {}),
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
      settings: { debounceMs: this.debounceMs, reconcileMs: this.reconcileMs, startupCatchupMode: this.startupCatchupMode },
      startupCatchup: { mode: this.startupCatchupMode, state: this.startupCatchupState, roots: [...this.startupCatchupRoots] },
      ready: this.phase !== "starting",
      roots,
      pendingCount: roots.reduce((sum, item) => sum + item.pending, 0),
      eventCount: this.eventCount,
      excludedEventCount: this.excludedEventCount,
      emptyFilenameEventCount: this.emptyFilenameEventCount,
      uncertainRescanCount: this.uncertainRescanCount,
      uncertainRescanStateCount: roots.reduce((sum, root) => sum + (root.uncertainRescanStateCount ?? 0), 0),
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
      ...(this.lastUncertainRescanAt ? { lastUncertainRescanAt: this.lastUncertainRescanAt } : {}),
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
    if (state.failed || state.degradedChildren.size > 0 || this.queueDegraded) return "degraded";
    return "active";
  }

  requestStop(): void {
    this.stopping = true;
    this.phase = "stopping";
    this.abort.abort();
    this.allFailed();
  }

  startupCatchupAction(action: StartupCatchupAction): { mode: StartupCatchupMode; state: StartupCatchupState; roots: string[] } {
    if (this.options.mode !== "background") {
      throw new WatchError("AUTOUPDATE_FOREGROUND_ACTIVE", "前景監看請在原終端按 Ctrl+C 結束，不能從另一個程序補捉。");
    }
    if (action === "skip") {
      for (const root of this.startupCatchupRoots) this.queue.skipDowntimeGap(root);
      this.startupCatchupState = "skipped";
      return { mode: this.startupCatchupMode, state: this.startupCatchupState, roots: [...this.startupCatchupRoots] };
    }
    if (this.startupCatchupMode === "off") {
      throw new WatchError("AUTOUPDATE_CATCHUP_DISABLED", "開機補捉目前已關閉。");
    }
    if (this.startupCatchupState !== "pending") {
      return { mode: this.startupCatchupMode, state: this.startupCatchupState, roots: [...this.startupCatchupRoots] };
    }
    this.startupCatchupState = "running";
    for (const state of this.states.values()) {
      if (!this.startupCatchupRoots.has(state.root)) continue;
      if (!this.queue.hasDowntimeGap(state.root) && !this.queue.hasScope(state.root)) continue;
      state.reconcile = true;
      state.dirty = true;
      this.enqueueReady(state.root);
    }
    this.refreshStartupCatchupState();
    return { mode: this.startupCatchupMode, state: this.startupCatchupState, roots: [...this.startupCatchupRoots] };
  }

  private refreshStartupCatchupState(): void {
    if (this.startupCatchupState !== "running") return;
    const complete = [...this.startupCatchupRoots].every(root => {
      const state = this.states.get(root);
      return !this.queue.hasDowntimeGap(root) && (!state || !state.reconcile);
    });
    if (complete) this.startupCatchupState = "complete";
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
    const skipped = Object.entries(report.skipped.byRule ?? {}).filter(([, count]) => count > 0);
    if (skipped.length) this.log(`排除略過：${skipped.map(([id, count]) => `${id}=${count}`).join("、")}`);
    if (report.exclusionCleanup) {
      this.log(`既有排除索引清理：已移除 ${report.exclusionCleanup.removed}；待移除 ${report.exclusionCleanup.pending}`);
    }
    if (this.options.verbose) {
      for (const notice of report.notices) this.log(`提示：${notice}`);
      for (const error of report.errors) this.log(`文件問題：${error}`);
    }
  }

  private printLocal(root: string, updated: number, unchanged: number, removed: number, elapsedMs: number, complete: boolean): void {
    this.log(`根目錄：${root}；更新 ${updated}、未變更 ${unchanged}、移除 ${removed}；耗時 ${elapsedMs} ms；完整：${complete ? "是" : "否"}`);
  }
  private recordLocalTiming(state: RootState, eventClock: number | undefined, scheduleClock: number, timing: LocalBatchTiming): void {
    const sample: LiveTimingSample = {
      at: new Date(this.now()).toISOString(),
      ...(eventClock === undefined ? {} : {
        eventToScheduleMs: Math.round((scheduleClock - eventClock) * 100) / 100,
      }),
      stableWaitMs: Math.round(timing.stableWaitMs * 100) / 100,
      enumerateMs: Math.round(timing.enumerateMs * 100) / 100,
      lockMs: Math.round(timing.lockMs * 100) / 100,
      commitMs: Math.round(timing.commitMs * 100) / 100,
    };
    state.lastTiming = sample;
    if (this.options.verbose) {
      this.log(`局部更新計時：事件→排程 ${sample.eventToScheduleMs ?? "—"} ms；穩定等待 ${sample.stableWaitMs} ms；列舉 ${sample.enumerateMs} ms；取鎖 ${sample.lockMs} ms；提交 ${sample.commitMs} ms`);
    }
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
    const firstEventClock = state.firstEventClock;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = undefined;
    if (state.rescanTimer) this.clearTimer(state.rescanTimer);
    state.rescanTimer = undefined;
    if (state.failed) this.attach(state);
    const reconcileRequested = state.reconcile;
    const pending = [...state.pending];
    const queued = this.queue.listPaths(state.root);
    const hasEvents = pending.length > 0 || queued.length > 0;
    if (!hasEvents) state.localPriority = false;
    const reconcileDue = !state.lastReconcileBatchAt
      || this.now() - state.lastReconcileBatchAt >= BACKGROUND_RECONCILE_INTERVAL_MS;
    const forceLocal = state.localPriority && hasEvents;
    const initialForegroundSync = this.options.mode !== "background" && this.options.syncNow !== false && !state.lastReconcileAt;
    const batchReconcile = this.options.mode === "background" && reconcileRequested
      && (!hasEvents || (reconcileDue && !forceLocal));
    const fullReconcile = reconcileRequested && this.options.mode !== "background" && !forceLocal;
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
      ...(exclusionForBatch ? { exclusion: exclusionForBatch } : {}),
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
          exclusion: state.exclusion,
          ...(this.options.now ? { now: this.options.now } : {}),
          ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
          maxEntries: this.options.reconcileBatchEntries ?? DEFAULT_RECONCILE_BATCH_ENTRIES,
          maxMs: this.options.reconcileBatchMs ?? DEFAULT_RECONCILE_BATCH_MS,
        });
        state.reconcileGeneration = result.generation;
        state.reconcileChecked = result.checked;
        state.reconcileFrontier = result.frontierCount;
        state.reconcileSkippedByRule = { ...result.skipped.byRule };
        state.exclusionCleanup = { ...result.exclusionCleanup };
        const current = this.queue.reconcileStatus(state.root);
        if (current) {
          state.reconcileReason = current.reason;
          state.reconcileStartedAt = new Date(current.startedAtMs).toISOString();
          state.reconcileUpdatedAt = new Date(current.updatedAtMs).toISOString();
        }
        state.lastReconcileBatchAt = this.now();
        state.reconcile = !result.done || result.pendingAfter;
        state.localPriority = hasEvents || state.dirty;
        state.syncFailed = !result.complete;
        if (result.done) {
          this.lastReconcile = { at: new Date(this.now()).toISOString(), root: state.root, complete: result.complete };
          state.lastReconcileAt = this.lastReconcile.at;
        }
        const skipped = Object.entries(result.skipped.byRule).filter(([, count]) => count > 0);
        const skippedNotice = skipped.length ? `；排除略過 ${skipped.map(([id, count]) => `${id}=${count}`).join("、")}` : "";
        this.log(`背景校正：${state.root}；檢查 ${result.checked}；更新 ${result.updated}；移除 ${result.removed}；剩餘範圍 ${result.frontierCount}；完整：${result.complete ? "是" : "否"}${skippedNotice}；既有排除索引清理已移除 ${result.exclusionCleanup.removed}、待移除 ${result.exclusionCleanup.pending}`);
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
          state.stableSince.clear();
          state.reconcile = true;
        } else {
          state.reconcile = false;
        }
      } else {
        this.phase = "updating";
        const work: LocalWorkItem[] = queued.length
          ? queued.map(item => {
            const filePath = path.resolve(state.root, item.relPath);
            return {
              filePath,
              generation: item.generation,
              relPath: item.relPath,
              expand: item.reason === "expand",
              ...(state.stableSince.has(filePath) ? { stableSince: state.stableSince.get(filePath)! } : {}),
            };
          })
          : pending.map(filePath => ({
            filePath,
            generation: 0,
            relPath: path.relative(state.root, filePath),
            expand: false,
            ...(state.stableSince.has(filePath) ? { stableSince: state.stableSince.get(filePath)! } : {}),
          }));
        // 輪替（SPEC §55.2）：先處理本圈尚未處理過的待辦，全部處理過一次後開始下一圈。
        // 以 path + generation 識別工作項，避免同一路徑的新事件沿用舊 generation 的本圈標記。
        const queuedKeys = new Set(work.map(localWorkKey));
        state.sweep = new Set([...state.sweep].filter(item => queuedKeys.has(item)));
        let order = work.filter(item => !state.sweep.has(localWorkKey(item)));
        if (!order.length) {
          state.sweep.clear();
          order = work;
        }
        // 同一圈內事件待辦先於資料夾展開出來的待辦（SPEC §56.1）。
        order = [...order.filter(item => !item.expand), ...order.filter(item => item.expand)];
        const candidateCount = order.length;
        const scheduleClock = performance.now();
        const batch = await this.applyLocalBatch(state, this.selectLocalWork(order, LOCAL_BATCH_MAX_ITEMS), inner, syncOptions);
        this.recordLocalTiming(state, firstEventClock, scheduleClock, batch.timing);
        delete state.firstEventClock;
        for (const item of batch.attempted) state.sweep.add(item);
        state.pending = new Set([...state.pending].filter(item => !batch.finished.has(item)));
        if (batch.busy) throw batch.busy;
        moreLocal = batch.interrupted || batch.deferred || candidateCount > LOCAL_BATCH_MAX_ITEMS;
        if (batch.deferred) state.dirty = true;
        this.printLocal(state.root, batch.updated, batch.unchanged, batch.removed, Math.round((this.now() - started) * 100) / 100, batch.complete);
        if (!batch.complete) state.syncFailed = true;
        if (state.localPriority) state.localPriority = false;
      }
    } catch (error) {
      if (error instanceof OperationCancelledError) {
        state.dirty = true;
      } else if (error instanceof IndexBusyError || isSqliteBusy(error)) {
        this.log(`INDEX_BUSY：${state.root}：稍後重試同步。`);
        writerBusy = true;
        state.dirty = true;
        if (batchReconcile || fullReconcile) state.reconcile = true;
        else for (const item of pending) {
          if (state.pending.has(item)) absorb(state.pending, item, state.stableSince);
        }
      } else if (error instanceof RootError || error instanceof IgnoreConfigurationError) {
        state.syncFailed = true;
        state.offline = true;
        this.log(`監看同步失敗：${state.root}：根目錄同步失敗，保留既有索引`);
        this.rememberError("ROOT_SYNC_FAILED", error.message, error);
      } else {
        state.syncFailed = true;
        this.log(`監看同步失敗：${state.root}：根目錄同步失敗，保留既有索引`);
        this.rememberError("LIVE_UPDATE_FAILED", error instanceof Error ? error.message : "未知錯誤", error);
      }
    } finally {
      release?.();
      state.running = false;
      this.refreshStartupCatchupState();
      this.refreshRoots();
      if (writerBusy) this.scheduleBusy(state);
      else {
        // 同一批沒處理完的待辦立即接續，不再等防抖（SPEC §54.1）。
        if (moreLocal) this.scheduleNow(state);
        else if (state.localPriority || state.dirty || state.pending.size || state.reconcile) {
          if (batchReconcile && state.localPriority) this.scheduleNow(state);
          else if (state.reconcile && batchReconcile && !state.dirty) this.scheduleNow(state);
          else this.schedule(state);
        }
        this.armRescan(state);
      }
    }
  }

  /**
   * 局部候選在同一類別內採穩定優先，保留最多 400 筆最舊與 100 筆最新工作；
   * 剛以相同 generation defer 的工作只在穩定候選之後補入。事件／展開的類別順序由呼叫端保留。
   */
  private selectLocalWork(work: readonly LocalWorkItem[], limit: number): LocalWorkItem[] {
    const selectGroup = (items: readonly LocalWorkItem[], capacity: number): LocalWorkItem[] => {
      if (capacity <= 0) return [];
      const stable: LocalWorkItem[] = [];
      const deferred: LocalWorkItem[] = [];
      for (const item of items) {
        if (this.deferredGenerations.get(item.filePath) === item.generation) deferred.push(item);
        else stable.push(item);
      }
      const newestCount = Math.min(LOCAL_BATCH_NEWEST_ITEMS, stable.length, capacity);
      const oldestCount = Math.min(capacity - newestCount, stable.length - newestCount);
      const selectedStable = [
        ...stable.slice(0, oldestCount),
        ...stable.slice(stable.length - newestCount),
      ];
      return [
        ...selectedStable,
        ...deferred.slice(0, capacity - selectedStable.length),
      ];
    };

    const events = work.filter(item => !item.expand);
    const expansions = work.filter(item => item.expand);
    const selectedEvents = selectGroup(events, limit);
    return [
      ...selectedEvents,
      ...selectGroup(expansions, limit - selectedEvents.length),
    ];
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
      timing: { stableWaitMs: 0, enumerateMs: 0, lockMs: 0, commitMs: 0 },
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
      if (state.stableSince.get(item.filePath) === item.stableSince) state.stableSince.delete(item.filePath);
      result.finished.add(item.filePath);
      result.attempted.add(localWorkKey(item));
      if (item.generation > 0) this.ackPath(state.root, item.relPath, item.generation);
    };
    const defer = (item: LocalWorkItem) => {
      if (this.deferredGenerations.get(item.filePath) !== item.generation) {
        this.deferrals.set(item.filePath, 0);
        this.deferredGenerations.set(item.filePath, item.generation);
      }
      const count = (this.deferrals.get(item.filePath) ?? 0) + 1;
      if (count > UNSTABLE_BACKOFF_MS.length) {
        // 與原本退避用盡相同：保留既有索引並確認完成，之後的新事件會重新排入。
        finish(item, { updated: 0, unchanged: 0, removed: 0, complete: false, path: "" });
        return;
      }
      this.deferrals.set(item.filePath, count);
      state.stableSince.set(item.filePath, { at: this.now() });
      result.deferred = true;
      result.attempted.add(localWorkKey(item));

    };
    if (!this.store.roots().includes(state.root)) {
      this.dropRoot(state, true);
      return result;
    }
    const candidates: { item: LocalWorkItem; key: string; sizeBytes: number }[] = [];
    let walkBudget = this.options.localWalkEntries ?? LOCAL_WALK_MAX_ENTRIES;
    const enumerateStarted = performance.now();
    for (const item of work) {
      if (this.stopping && !this.options.applyFileUpdate) { result.interrupted = true; break; }
      if (this.isExcluded(state, item.filePath, false)) { finish(item); continue; }
      let info: fs.Stats | undefined;
      try { info = await fs.promises.lstat(item.filePath); } catch { info = undefined; }
      if (info?.isSymbolicLink() && this.isExcluded(state, item.filePath, false, true)) { finish(item); continue; }
      if (info?.isDirectory() && !info.isSymbolicLink() && (item.expand || !samePath(item.filePath, state.root))) {
        if (this.isExcluded(state, item.filePath, true)) { finish(item); continue; }
        const walked = await this.expandDirectory(state, item.filePath, walkBudget);
        walkBudget = walked.budgetLeft;
        // 展開寫入的檔案待辦要由下一輪處理，所以一律立即接續。
        result.interrupted = true;
        if (walked.done) finish(item);
        else result.attempted.add(localWorkKey(item));
        continue;
      }
      if (!info || !info.isFile()) {
        // 不存在、連結與其他類型沿用單一路徑處理（刪除、整根校正、略過）。
        finish(item, await this.applyOne(state, item.filePath, inner, syncOptions, result.timing));
        continue;
      }
      candidates.push({ item, key: identityKey(info), sizeBytes: info.size });
    }
    result.timing.enumerateMs += performance.now() - enumerateStarted;
    if (!candidates.length) return result;

    const waitForStable = async (candidate: { item: LocalWorkItem; key: string; sizeBytes: number }): Promise<fs.Stats | undefined> => {
      const stableStarted = performance.now();
      const stableSince = candidate.item.stableSince?.at ?? this.now();
      const remaining = Math.max(0, stableSince + this.debounceMs - this.now());
      if (remaining > 0) await (this.options.sleep ?? sleepMs)(remaining);
      result.timing.stableWaitMs += performance.now() - stableStarted;
      try { return await fs.promises.lstat(candidate.item.filePath); } catch { return undefined; }
    };
    let processStarted: number | undefined;
    const apply = this.options.applyFileUpdate;
    let processed = 0;

    // 舊有測試 hook 仍維持逐檔 apply 行為；正式路徑在下方以 prepared 群組提交。
    if (apply) {
      const stablePromises = candidates.map(waitForStable);
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!;
        const second = await stablePromises[index]!;
        if (processStarted === undefined) processStarted = this.now();
        if (processed > 0 && this.now() - processStarted >= LOCAL_BATCH_MAX_MS) { result.interrupted = true; break; }
        processed++;
        if (!second) {
          finish(candidate.item, await this.applyOne(state, candidate.item.filePath, inner, syncOptions, result.timing));
          continue;
        }
        if (identityKey(second) !== candidate.key) { defer(candidate.item); continue; }
        this.localUpdateCount++;
        const commitStarted = performance.now();
        const update = await withWriterBackoff(this.store.databasePath, {
          ...inner,
          onLockWait: elapsedMs => { result.timing.lockMs += elapsedMs; },
        }, () => apply(candidate.item.filePath, state.root, this.store, {
          ...inner, lockHeld: true, stableMs: 0, deferUnstable: true,
        }));
        result.timing.commitMs += performance.now() - commitStarted;
        if (update.deferred) { defer(candidate.item); continue; }
        finish(candidate.item, { updated: update.updated, unchanged: update.unchanged, removed: update.removed, complete: update.complete, path: candidate.item.filePath });
      }
      return result;
    }

    let preparedGroup: PreparedLocalItem[] = [];
    let preparedCharacters = 0;
    let groupStartedAt = 0;
    const discardPrepared = () => {
      preparedGroup = [];
      preparedCharacters = 0;
      groupStartedAt = 0;
    };
    const flushPrepared = async (): Promise<void> => {
      if (!preparedGroup.length) return;
      if (this.stopping) {
        result.interrupted = true;
        discardPrepared();
        return;
      }
      const group = preparedGroup;
      discardPrepared();
      let updates: readonly LocalUpdateResult[];
      let partialBusy = false;
      try {
        updates = await this.commitPreparedBatch(group, inner, result.timing);
      } catch (error) {
        if (!(error instanceof PreparedBatchBusyError)) throw error;
        updates = error.completed;
        result.busy = error.busyError;
        partialBusy = true;
      }
      for (let index = 0; index < updates.length; index++) {
        if (this.stopping && !partialBusy) {
          result.interrupted = true;
          return;
        }
        const item = group[index]!.item;
        const update = updates[index]!;
        if (update.deferred) defer(item);
        else finish(item, {
          updated: update.updated, unchanged: update.unchanged,
          removed: update.removed, complete: update.complete, path: item.filePath,
        });
      }
    };

    const stablePromises = candidates.map(waitForStable);
    for (let index = 0; index < candidates.length; index++) {
      if (this.stopping) {
        result.interrupted = true;
        discardPrepared();
        break;
      }
      const candidate = candidates[index]!;
      const second = await stablePromises[index]!;
      if (processStarted === undefined) processStarted = this.now();
      if (processed > 0 && this.now() - processStarted >= LOCAL_BATCH_MAX_MS) {
        await flushPrepared();
        result.interrupted = true;
        break;
      }
      processed++;
      if (!second) {
        await flushPrepared();
        if (result.busy) { result.interrupted = true; break; }
        if (this.stopping) { result.interrupted = true; break; }
        finish(candidate.item, await this.applyOne(state, candidate.item.filePath, inner, syncOptions, result.timing));
        continue;
      }
      if (identityKey(second) !== candidate.key) { defer(candidate.item); continue; }
      const estimatedCharacters = Math.max(0, candidate.sizeBytes);
      if (preparedGroup.length > 0 && (
        preparedGroup.length >= LOCAL_PREPARED_GROUP_MAX_ITEMS ||
        this.now() - groupStartedAt >= LOCAL_PREPARED_GROUP_MAX_MS ||
        preparedCharacters + estimatedCharacters > LOCAL_PREPARED_MAX_TEXT_CHARS
      )) {
        await flushPrepared();
        if (result.busy) { result.interrupted = true; break; }
        if (this.stopping) { result.interrupted = true; break; }
      }

      this.localUpdateCount++;
      if (!preparedGroup.length) groupStartedAt = this.now();
      const prepared = await prepareFileUpdate(candidate.item.filePath, state.root, this.store, {
        ...inner, stableMs: 0, deferUnstable: true,
      }, second);
      if (this.stopping) {
        result.interrupted = true;
        discardPrepared();
        break;
      }
      if (prepared.kind === "result") {
        if (prepared.result.deferred) defer(candidate.item);
        else finish(candidate.item, {
          updated: prepared.result.updated, unchanged: prepared.result.unchanged,
          removed: prepared.result.removed, complete: prepared.result.complete, path: prepared.result.path,
        });
        continue;
      }

      const textChars = preparedDocumentCharacters(prepared);
      // 來源 size 先作準備前的保守預留；壓縮格式若解析後膨脹，這份文件單獨成組。
      if (preparedGroup.length > 0 && preparedCharacters + textChars > LOCAL_PREPARED_MAX_TEXT_CHARS) {
        await flushPrepared();
        if (result.busy) { result.interrupted = true; break; }
        if (this.stopping) { result.interrupted = true; break; }
        groupStartedAt = this.now();
      }
      preparedGroup.push({ item: candidate.item, prepared, textChars });
      preparedCharacters += textChars;
      if (
        preparedGroup.length >= LOCAL_PREPARED_GROUP_MAX_ITEMS ||
        preparedCharacters >= LOCAL_PREPARED_MAX_TEXT_CHARS ||
        this.now() - groupStartedAt >= LOCAL_PREPARED_GROUP_MAX_MS
      ) {
        await flushPrepared();
        if (result.busy) { result.interrupted = true; break; }
      }
    }
    if (!this.stopping) await flushPrepared();
    else discardPrepared();
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
          walk.listing = {
            dir: current,
            entries: await (this.options.readdir
              ? this.options.readdir(current)
              : fs.promises.readdir(current, { withFileTypes: true }) as Promise<fs.Dirent[]>),
            next: 0,
          };
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
        if (entry.isSymbolicLink() || state.exclusion.excludes(full, entry.isDirectory(), entry.isSymbolicLink())) continue;
        if (entry.isDirectory()) {
          walk.frontier.push(full);
          continue;
        }
        if (!entry.isFile() || isIndexArtifact(full, this.store.databasePath)) continue;
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

  private async commitPreparedBatch(
    prepared: readonly PreparedLocalItem[],
    options: LocalUpdateOptions,
    timing: LocalBatchTiming,
  ): Promise<LocalUpdateResult[]> {
    return withWriterBackoff(this.store.databasePath, {
      ...options,
      onLockWait: elapsedMs => {
        options.onLockWait?.(elapsedMs);
        timing.lockMs += elapsedMs;
      },
    }, async () => {
      const commitStarted = performance.now();
      try {
        const sleep = options.sleep ?? sleepMs;
        const results: LocalUpdateResult[] = [];
        for (const item of prepared) {
          for (let attempt = 0; ; attempt++) {
            throwIfAborted(options.signal);
            try {
              results.push(await commitPreparedFileUpdateLocked(
                item.prepared,
                this.store,
                { ...options, lockHeld: true, stableMs: 0, deferUnstable: true },
              ));
              break;
            } catch (error) {
              if (!(error instanceof IndexBusyError) && !isSqliteBusy(error)) throw error;
              const delay = PREPARED_COMMIT_BUSY_RETRY_MS[attempt];
              if (delay === undefined) {
                this.store.checkpointWal();
                throw new PreparedBatchBusyError(results, error);
              }
              await sleep(delay);
            }
          }
        }
        this.store.checkpointWal();
        return results;
      } finally {
        timing.commitMs += performance.now() - commitStarted;
      }
    });
  }

  private async applyOne(
    state: RootState,
    filePath: string,
    localOpts: LocalUpdateOptions,
    syncOptions: SyncOptions,
    timing?: LocalBatchTiming,
  ): Promise<{ updated: number; unchanged: number; removed: number; complete: boolean; path: string }> {
    const options = timing ? {
      ...localOpts,
      onLockWait: (elapsedMs: number) => {
        localOpts.onLockWait?.(elapsedMs);
        timing.lockMs += elapsedMs;
      },
    } : localOpts;
    return withWriterBackoff(this.store.databasePath, options, async () => {
      const commitStarted = timing ? performance.now() : 0;
      try {
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
      } finally {
        if (timing) timing.commitMs += performance.now() - commitStarted;
      }
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
    // 校正批次已讓 local 待辦取得優先權時，不能被後續事件重新延後。
    if (state.localPriority && state.timer) return;
    if (state.timer) this.clearTimer(state.timer);
    const now = this.now();
    state.firstScheduledAt ??= now;
    const remaining = state.firstScheduledAt + this.debounceMs * DEBOUNCE_MAX_WAIT_FACTOR - now;
    const reconcileRemaining = state.reconcile && state.lastReconcileBatchAt !== undefined
      ? Math.max(0, state.lastReconcileBatchAt + BACKGROUND_RECONCILE_INTERVAL_MS - now)
      : Number.POSITIVE_INFINITY;
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      state.firstScheduledAt = undefined;
      this.enqueueReady(state.root);
    }, Math.max(0, Math.min(this.debounceMs, remaining, reconcileRemaining)));
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
    if (!this.reconcileMs || this.stopping || state.removed) return;
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
    state.stableSince.clear();
    state.degradedChildren.clear();
    state.uncertainRescans.clear();
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
    const rawMessage = error instanceof Error ? error.message : "未知錯誤";
    const displayMessage = describeIndexClientError(error) ?? rawMessage;
    state.lastError = displayMessage;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = undefined;
    this.closeHandles(state);
    this.log(`監看錯誤：${state.root}：${state.lastError}`);
    this.rememberError("WATCH_ERROR", rawMessage, error);
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
    state.degradedChildren.clear();
    this.attachWatch(state, state.root, false);
    state.scopeMode = "split";
    for (const child of children) {
      try {
        this.attachWatch(state, child, true);
      } catch (error) {
        this.degradeChild(state, child, error);
      }
    }
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
      state.degradedChildren.clear();
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
    state.uncertainRescans.clear();
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
      const child = path.join(root, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory() || state.exclusion.excludes(child, true, entry.isSymbolicLink())) continue;
      children.push(child);
    }
    return children;
  }

  private degradeChild(state: RootState, dir: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : "未知錯誤";
    state.uncertainRescans.delete(dir);
    state.degradedChildren.set(dir, reason);
    this.rememberError("WATCH_SCOPE_ERROR", `${dir}: ${reason}`);
    this.persistPath(state, dir, "expand");
    absorb(state.pending, dir, state.stableSince);
    state.reconcile = true;
    state.localPriority = true;
    this.schedule(state);
    this.armWatcherRetry(state);
  }

  private failHandle(state: RootState, handle: WatchHandle, error: unknown): void {
    if (state.removed || this.stopping) return;
    const message = error instanceof Error ? error.message : "未知錯誤";
    this.log(`監看錯誤：${handle.path}：${message}`);
    this.rememberError("WATCH_SCOPE_ERROR", `${handle.path}: ${message}`);
    this.persistPath(state, handle.path, "expand");
    absorb(state.pending, handle.path, state.stableSince);
    this.schedule(state);
    try { handle.watcher.close(); } catch { /* ignore */ }
    state.uncertainRescans.delete(handle.path);
    state.handles = state.handles.filter(item => item !== handle);
    if (samePath(handle.path, state.root)) {
      this.failRoot(state, error);
      return;
    }
    try {
      this.attachWatch(state, handle.path, true);
      state.degradedChildren.delete(handle.path);
    } catch (retryError) {
      this.degradeChild(state, handle.path, retryError);
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
      state.degradedChildren.delete(dir);
    } catch (error) {
      // 短暫存在的目錄在 attach 前已消失：路徑已排入待辦核對，不必退回 coarse（SPEC §53.2）。
      if (!fs.existsSync(dir)) return;
      this.degradeChild(state, dir, error);
    }
  }

  private releaseChildWatch(state: RootState, dir: string): void {
    const handle = state.handles.find(item => samePath(item.path, dir));
    if (!handle || samePath(handle.path, state.root)) return;
    this.persistPath(state, dir);
    absorb(state.pending, dir, state.stableSince);
    this.schedule(state);
    try { handle.watcher.close(); } catch { /* ignore */ }
    state.uncertainRescans.delete(handle.path);
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

  private rememberUncertainRescan(state: RootState, dir: string, value: UncertainRescanState): void {
    if (!state.uncertainRescans.has(dir)) {
      while (state.uncertainRescans.size >= MAX_UNCERTAIN_RESCAN_STATES_PER_ROOT) {
        const oldest = state.uncertainRescans.keys().next().value;
        if (typeof oldest !== "string") break;
        state.uncertainRescans.delete(oldest);
      }
    }
    state.uncertainRescans.delete(dir);
    state.uncertainRescans.set(dir, value);
  }

  private scheduleUncertainRescan(state: RootState, watchDir: string): boolean {
    const dir = path.resolve(watchDir);
    if (!samePath(state.root, dir) && !coversPath(state.root, dir)) return false;
    const now = this.now();
    let rescan = state.uncertainRescans.get(dir);
    if (!rescan || now < rescan.windowStartedAt) {
      rescan = { windowStartedAt: now, accepted: 0, nextAllowedAt: now, backoffIndex: 0 };
      this.rememberUncertainRescan(state, dir, rescan);
    } else if (now - rescan.windowStartedAt >= this.uncertainRescanWindowMs) {
      // 視窗重置但保留尚未到期的有限退避，避免視窗邊界連續觸發補掃。
      rescan = {
        windowStartedAt: now,
        accepted: 0,
        nextAllowedAt: rescan.nextAllowedAt,
        backoffIndex: rescan.backoffIndex,
      };
      this.rememberUncertainRescan(state, dir, rescan);
    } else {
      // Map insertion order提供 bounded LRU：高頻 watchDir 保留自己的冷卻狀態。
      this.rememberUncertainRescan(state, dir, rescan);
    }
    if (now < rescan.nextAllowedAt) return false;
    if (rescan.accepted >= this.uncertainRescanMaxPerWindow) {
      const delays = this.uncertainRescanBackoffMs;
      const delay = delays[Math.min(rescan.backoffIndex, delays.length - 1)] ?? 0;
      rescan.backoffIndex++;
      rescan.nextAllowedAt = now + delay;
      return false;
    }
    if (!this.persistPath(state, dir, "expand")) return false;
    absorb(state.pending, dir, state.stableSince);
    rescan.accepted++;
    rescan.nextAllowedAt = now + this.uncertainRescanCooldownMs;
    const at = new Date(now).toISOString();
    state.uncertainRescanCount++;
    state.lastUncertainRescanAt = at;
    this.uncertainRescanCount++;
    this.lastUncertainRescanAt = at;
    state.localPriority = true;
    return true;
  }

  private handleEvent(
    state: RootState,
    filename: string | Buffer | null | undefined,
    watchDir = state.root,
    eventType: fs.WatchEventType = "rename",
  ): void {
    const label = filename ? String(filename) : "";
    if (!label) state.emptyFilenameEventCount++;
    if (!label) this.emptyFilenameEventCount++;
    const abs = label ? path.resolve(watchDir, label) : undefined;
    // coarse／split callback 先以字串和已載入規則做保守檔案判定；命中時不得觸發 IO。
    if (label && shouldIgnoreWatchPath(
      label, watchDir, runtimePathPlatform(), state.exclusion, false, false,
    )) {
      this.excludedEventCount++;
      return;
    }
    let info: fs.Stats | undefined;
    let missing = false;
    if (abs) {
      try { info = (this.options.lstatSync ?? fs.lstatSync)(abs); } catch { missing = true; }
    }
    if (abs) {
      if (info?.isSymbolicLink() && this.isExcluded(state, abs, false, true)) {
        this.excludedEventCount++;
        return;
      }
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
    state.firstEventClock ??= performance.now();
    if (this.options.verbose) this.log(`變更：${watchDir}${label ? path.sep + label : ""} @${this.now()}`);
    if (!label) {
      if (samePath(watchDir, state.root)) {
        this.persistScope(state, "unknown-filename");
        this.markReconcile(state);
      }
      this.scheduleUncertainRescan(state, watchDir);
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
    absorb(state.pending, abs, state.stableSince);
    if (this.overflowRoot(state)) this.markReconcile(state);
    this.schedule(state);
  }

  private persistPath(state: RootState, abs: string, reason: "event" | "expand" = "event"): boolean {
    try {
      const relPath = path.relative(state.root, abs);
      if (reason === "expand" && (!relPath || relPath === ".")) this.queue.acceptDirectory(state.root, relPath);
      else this.queue.acceptPath(state.root, relPath, reason);
      state.stableSince.set(abs, { at: this.now() });
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
      this.rememberError("QUEUE_ACK_FAILED", error instanceof Error ? error.message : "ack 失敗", error);
    }
  }

  private ackUpTo(root: string, generation: number): void {
    try { this.queue.ackUpTo(root, generation); }
    catch (error) {
      this.queueDegraded = true;
      this.rememberError("QUEUE_ACK_FAILED", error instanceof Error ? error.message : "ack 失敗", error);
    }
  }

  private onQueueFailure(state: RootState, error: unknown): void {
    this.queueDegraded = true;
    const message = error instanceof QueuePersistError || error instanceof Error ? error.message : "工作佇列無法落盤。";
    this.rememberError("QUEUE_PERSIST_FAILED", message, error);
    this.failRoot(state, error instanceof Error ? error : new QueuePersistError(message));
  }

  private hydrateFromQueue(): void {
    for (const state of this.states.values()) {
      const hadScope = this.queue.hasScope(state.root);
      if (this.queue.reopened) {
        try {
          if (!hadScope) this.queue.markDowntimeGap(state.root);
        } catch (error) {
          this.onQueueFailure(state, error);
          continue;
        }
        this.startupCatchupRoots.add(state.root);
        if (this.startupCatchupMode === "auto") {
          this.startupCatchupState = "running";
          state.reconcile = true;
        } else if (this.startupCatchupMode === "off") {
          try { this.queue.skipDowntimeGap(state.root); }
          catch (error) { this.onQueueFailure(state, error); continue; }
          this.startupCatchupState = "skipped";
          state.reconcile = hadScope;
        } else {
          this.startupCatchupState = "pending";
          state.reconcile = false;
        }
      } else if (hadScope) state.reconcile = true;
      for (const item of this.queue.listPaths(state.root)) {
        const filePath = path.resolve(state.root, item.relPath);
        state.stableSince.set(filePath, { at: this.now() });
        absorb(state.pending, filePath, state.stableSince);
      }
    }
  }

  private markReconcile(state: RootState): void {
    state.reconcile = true;
    state.pending.clear();
    state.stableSince.clear();
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
      const runInitialSync = this.options.syncNow !== false
        && (this.options.mode !== "background" || this.startupCatchupMode === "auto");
      if (runInitialSync) {
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
