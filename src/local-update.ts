import { lstat, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { IGNORE_FILE, IgnoreConfigurationError } from "./ignore.js";
import { RootExclusion } from "./root-exclusion.js";
import { classifyReprocess, emptyStatusCounts, reprocessAction, supportedExtensions, type Diagnostic, type DocumentRecord } from "./model.js";
import { parseDocument } from "./parser.js";
import { throwIfAborted } from "./progress.js";
import { samePath } from "./root-plan.js";
import { isIndexArtifact, type IndexStore } from "./store.js";
import { acquireWriteLock, IndexBusyError, isSqliteBusy } from "./write-lock.js";
import { shouldIgnoreWatchPath } from "./watch-path.js";

export const WRITER_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
/** 單次 withWriterBackoff 最多初次嘗試加五次退避；跨 root 的下一輪仍由 LiveUpdateEngine 排程。 */
export const WRITER_BACKOFF_MAX_ATTEMPTS = WRITER_BACKOFF_MS.length + 1;
export const UNSTABLE_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000] as const;
export const TRANSIENT_CODES = new Set(["EACCES", "EPERM", "ENOENT", "EIO", "EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

export type LocalUpdateKind = "file-upsert" | "file-delete" | "subtree-delete" | "skipped" | "retained" | "unstable";

export interface LocalUpdateResult {
  kind: LocalUpdateKind;
  path: string;
  root: string;
  updated: number;
  added: number;
  removed: number;
  unchanged: number;
  parserCalls: number;
  complete: boolean;
  deferred: boolean;
  diagnostics: Diagnostic[];
  notices: string[];
}

export interface LocalUpdateOptions {
  parse?: typeof parseDocument;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  lockHeld?: boolean;
  acquireLock?: (databasePath: string) => () => void;
  lstat?: typeof lstat;
  readdir?: typeof readdir;
  stat?: typeof stat;
  /** 解析前兩次 metadata 須相同，且間隔至少此毫秒數（通常等於 debounce）。0 表示只做解析前後核對。 */
  stableMs?: number;
  /** 檔案仍在變動或暫時無法讀取時，不原地退避，立即回傳 `deferred`（SPEC §54.3）。 */
  deferUnstable?: boolean;
  /** 可選重用 RootExclusion（由 LiveUpdateEngine 傳 state.exclusion）；未提供時維持每檔 load 的原有行為（SPEC §61）。 */
  exclusion?: RootExclusion;
}

function emptyResult(kind: LocalUpdateKind, filePath: string, root: string): LocalUpdateResult {
  return {
    kind, path: filePath, root, updated: 0, added: 0, removed: 0, unchanged: 0,
    parserCalls: 0, complete: true, deferred: false, diagnostics: [], notices: [],
  };
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as NodeJS.ErrnoException).code);
  return "";
}

function isTransient(error: unknown): boolean {
  return TRANSIENT_CODES.has(errorCode(error));
}

export async function withWriterBackoff<T>(
  databasePath: string,
  options: LocalUpdateOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (options.lockHeld) return fn();
  const acquire = options.acquireLock ?? acquireWriteLock;
  const sleep = options.sleep ?? sleepMs;
  for (let attempt = 0; attempt < WRITER_BACKOFF_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(options.signal);
    try {
      const release = acquire(databasePath);
      try { return await fn(); }
      finally { release(); }
    } catch (error) {
      if (!(error instanceof IndexBusyError) && !isSqliteBusy(error)) throw error;
      if (attempt >= WRITER_BACKOFF_MS.length) {
        throw error instanceof IndexBusyError ? error : new IndexBusyError();
      }
      await sleep(WRITER_BACKOFF_MS[attempt]!);
    }
  }
  throw new IndexBusyError();
}

export async function rootIsOnline(root: string, options: LocalUpdateOptions = {}): Promise<boolean> {
  try {
    const info = await (options.stat ?? stat)(root);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function parentReadable(filePath: string, options: LocalUpdateOptions = {}): Promise<boolean> {
  const parent = path.dirname(filePath);
  if (samePath(parent, filePath)) return false;
  try {
    await (options.readdir ?? readdir)(parent);
    return true;
  } catch {
    return false;
  }
}

export async function canSafelyDelete(filePath: string, root: string, options: LocalUpdateOptions = {}): Promise<boolean> {
  return await rootIsOnline(root, options) && await parentReadable(filePath, options);
}

export function identityKey(info: { size: number; mtimeMs: number; ino?: number; dev?: number; isFile(): boolean }): string {
  return `${info.isFile() ? "f" : "o"}:${info.size}:${info.mtimeMs}:${info.ino ?? 0}:${info.dev ?? 0}`;
}

async function documentFromFile(
  filePath: string,
  info: { size: number; mtimeMs: number },
  parse: typeof parseDocument,
): Promise<{ document: DocumentRecord; parserCalls: number }> {
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    return {
      parserCalls: 0,
      document: {
        path: filePath,
        filename: path.basename(filePath),
        extension,
        sizeBytes: info.size,
        modifiedAtMs: info.mtimeMs,
        status: "unsupported",
        errorCode: null,
        errorMessage: null,
        blocks: [],
      },
    };
  }
  const document = await parse(filePath);
  document.sizeBytes = info.size;
  document.modifiedAtMs = info.mtimeMs;
  return { document, parserCalls: 1 };
}

export type PreparedFileUpdate =
  | {
    kind: "file";
    filePath: string;
    root: string;
    identity: string;
    action: "skip" | "metadata" | "parse";
    document?: DocumentRecord;
    parserCalls: number;
  }
  | { kind: "result"; result: LocalUpdateResult };

function deferredResult(filePath: string, root: string, code: string): LocalUpdateResult {
  const result = emptyResult("unstable", filePath, root);
  result.complete = false;
  result.deferred = true;
  result.diagnostics.push({ stage: "read", path: filePath, code, message: "檔案仍在變動，延後重新核對" });
  return result;
}

function skippedResult(filePath: string, root: string, notice?: string): LocalUpdateResult {
  const result = emptyResult("skipped", filePath, root);
  if (notice) result.notices.push(notice);
  return result;
}

/**
 * 在 writer lock 外準備一份局部更新。LiveUpdateEngine 會先傳入批次第二次
 * metadata 觀察結果，避免在整批一次穩定等待後再重複做一次觀察。
 */
export async function prepareFileUpdate(
  filePath: string,
  root: string,
  store: IndexStore,
  options: LocalUpdateOptions = {},
  observed?: Stats,
): Promise<PreparedFileUpdate> {
  const lstatFn = options.lstat ?? lstat;
  const sleep = options.sleep ?? sleepMs;
  const info = observed ?? await (async () => {
    try {
      const first = await lstatFn(filePath);
      const stableMs = options.stableMs ?? 0;
      if (stableMs <= 0) return first;
      await sleep(stableMs);
      const second = await lstatFn(filePath);
      if (identityKey(second) !== identityKey(first)) return undefined;
      return second;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      if (isTransient(error) && options.deferUnstable) return undefined;
      throw error;
    }
  })();

  if (!info) {
    return { kind: "result", result: deferredResult(filePath, root, "FILE_UNSTABLE") };
  }
  if (!store.roots().includes(root)) return { kind: "result", result: skippedResult(filePath, root, "根目錄已移除或尚未登錄") };
  if (isIndexArtifact(filePath, store.databasePath)) return { kind: "result", result: skippedResult(filePath, root) };
  if (info.isSymbolicLink()) return { kind: "result", result: skippedResult(filePath, root, "略過符號連結") };
  if (!info.isFile()) return { kind: "result", result: skippedResult(filePath, root) };

  const exclusion = options.exclusion ?? await RootExclusion.load(root, store);
  if (shouldIgnoreWatchPath(filePath, root) || exclusion.excludes(filePath, false)) {
    return { kind: "result", result: skippedResult(filePath, root) };
  }

  const previous = store.getDocument(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const reason = classifyReprocess({
    previous: previous ?? null, extension, sizeBytes: info.size, modifiedAtMs: info.mtimeMs,
  });
  const action = reprocessAction(reason, extension);
  const identity = identityKey(info);
  if (action === "skip") {
    return { kind: "file", filePath, root, identity, action, parserCalls: 0 };
  }
  if (action === "metadata") {
    return {
      kind: "file", filePath, root, identity, action, parserCalls: 0,
      document: {
        path: filePath,
        filename: path.basename(filePath),
        extension,
        sizeBytes: info.size,
        modifiedAtMs: info.mtimeMs,
        status: "unsupported",
        errorCode: null,
        errorMessage: null,
        blocks: [],
      },
    };
  }

  throwIfAborted(options.signal);
  try {
    const parsed = await documentFromFile(filePath, info, options.parse ?? parseDocument);
    throwIfAborted(options.signal);
    const afterInfo = await lstatFn(filePath);
    if (afterInfo.isSymbolicLink() || !afterInfo.isFile() || identityKey(afterInfo) !== identity) {
      return { kind: "result", result: deferredResult(filePath, root, "FILE_UNSTABLE") };
    }
    return {
      kind: "file", filePath, root, identity, action, parserCalls: parsed.parserCalls,
      document: parsed.document,
    };
  } catch (error) {
    if (error instanceof IgnoreConfigurationError) throw error;
    if (isTransient(error) && options.deferUnstable) {
      return { kind: "result", result: deferredResult(filePath, root, errorCode(error)) };
    }
    throw error;
  }
}

/**
 * 只執行鎖內的 metadata 重新確認與單份提交。呼叫者必須已持有 writer lock；
 * `commitPreparedFileUpdate` 提供一般呼叫者的 backoff 包裝。
 */
export async function commitPreparedFileUpdateLocked(
  prepared: PreparedFileUpdate,
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult> {
  if (prepared.kind === "result") return prepared.result;
  const result = emptyResult("file-upsert", prepared.filePath, prepared.root);
  if (!store.roots().includes(prepared.root)) {
    result.kind = "skipped";
    result.notices.push("根目錄已移除或尚未登錄");
    return result;
  }
  if (isIndexArtifact(prepared.filePath, store.databasePath)) {
    result.kind = "skipped";
    return result;
  }

  throwIfAborted(options.signal);
  const lstatFn = options.lstat ?? lstat;
  let current: Stats;
  try {
    current = await lstatFn(prepared.filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return applyPathDeleteLocked(prepared.filePath, prepared.root, store, options);
    if (isTransient(error) && options.deferUnstable) return deferredResult(prepared.filePath, prepared.root, errorCode(error));
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile() || identityKey(current) !== prepared.identity) {
    return deferredResult(prepared.filePath, prepared.root, "FILE_UNSTABLE");
  }
  const exclusion = options.exclusion ?? await RootExclusion.load(prepared.root, store);
  if (shouldIgnoreWatchPath(prepared.filePath, prepared.root) || exclusion.excludes(prepared.filePath, false)) {
    result.kind = "skipped";
    return result;
  }
  throwIfAborted(options.signal);
  if (prepared.action === "skip") {
    result.unchanged = 1;
    return result;
  }
  const previous = store.getDocument(prepared.filePath);
  if (!prepared.document) throw new Error("局部更新準備結果缺少文件資料。");
  if (prepared.action === "metadata") {
    store.touchMetadata(prepared.document, prepared.root);
  } else {
    store.upsert(prepared.document, prepared.root);
  }
  result.updated = 1;
  result.added = previous ? 0 : 1;
  result.parserCalls = prepared.parserCalls;
  return result;
}
/**
 * 在同一把已持有的 writer lock 內重新確認並提交一組準備結果。
 * 呼叫者必須自行持有鎖；每份結果仍各自核對 metadata，不能因同批而略過。
 */
export async function commitPreparedFileUpdatesLocked(
  prepared: readonly PreparedFileUpdate[],
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult[]> {
  const results: LocalUpdateResult[] = [];
  for (const item of prepared) {
    results.push(await commitPreparedFileUpdateLocked(item, store, options));
  }
  return results;
}

/**
 * 取得一次 writer lock，提交一組已準備結果後才釋放。
 */
export async function commitPreparedFileUpdates(
  prepared: readonly PreparedFileUpdate[],
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult[]> {
  return withWriterBackoff(store.databasePath, options, () => commitPreparedFileUpdatesLocked(prepared, store, options));
}

export async function commitPreparedFileUpdate(
  prepared: PreparedFileUpdate,
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult> {
  return withWriterBackoff(store.databasePath, options, () => commitPreparedFileUpdateLocked(prepared, store, options));
}

export async function applyFileUpdate(
  filePath: string,
  root: string,
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult> {
  return withWriterBackoff(store.databasePath, options, () => applyFileUpdateLocked(filePath, root, store, options));
}

async function applyFileUpdateLocked(
  filePath: string,
  root: string,
  store: IndexStore,
  options: LocalUpdateOptions,
): Promise<LocalUpdateResult> {
  const result = emptyResult("file-upsert", filePath, root);
  if (!store.roots().includes(root)) {
    result.kind = "skipped";
    result.notices.push("根目錄已移除或尚未登錄");
    return result;
  }
  if (isIndexArtifact(filePath, store.databasePath)) {
    result.kind = "skipped";
    return result;
  }
  const exclusion = options.exclusion ?? await RootExclusion.load(root, store);
  const ignore = {
    match(filePath: string, isDirectory: boolean) {
      return shouldIgnoreWatchPath(filePath, root) || exclusion.excludes(filePath, isDirectory);
    },
  };
  const lstatFn = options.lstat ?? lstat;
  const parse = options.parse ?? parseDocument;
  const sleep = options.sleep ?? sleepMs;
  const previous = store.getDocument(filePath);
  const defer = (code: string): LocalUpdateResult => {
    result.kind = "unstable";
    result.complete = false;
    result.deferred = true;
    result.diagnostics.push({ stage: "read", path: filePath, code, message: "檔案仍在變動，延後重新核對" });
    return result;
  };

  for (let attempt = 0; attempt <= UNSTABLE_BACKOFF_MS.length; attempt++) {
    throwIfAborted(options.signal);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstatFn(filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return applyPathDeleteLocked(filePath, root, store, options);
      if (isTransient(error) && options.deferUnstable) return defer(errorCode(error));
      if (isTransient(error) && attempt < UNSTABLE_BACKOFF_MS.length) {
        await sleep(UNSTABLE_BACKOFF_MS[attempt]!);
        continue;
      }
      result.kind = "unstable";
      result.complete = false;
      result.diagnostics.push({ stage: "read", path: filePath, code: errorCode(error) || "FILE_READ_FAILED", message: "無法讀取文件，保留既有索引" });
      return result;
    }
    if (info.isSymbolicLink()) {
      result.kind = "skipped";
      result.notices.push("略過符號連結");
      return result;
    }
    if (info.isDirectory()) {
      result.kind = "skipped";
      result.notices.push("目錄事件改由子樹校正處理");
      return result;
    }
    if (!info.isFile()) {
      result.kind = "skipped";
      return result;
    }
    if (ignore.match(filePath, false)) {
      result.kind = "skipped";
      return result;
    }
    const stableMs = options.stableMs ?? 0;
    if (stableMs > 0) {
      const firstKey = identityKey(info);
      await sleep(stableMs);
      let second: Awaited<ReturnType<typeof lstat>>;
      try {
        second = await lstatFn(filePath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return applyPathDeleteLocked(filePath, root, store, options);
        if (isTransient(error) && options.deferUnstable) return defer(errorCode(error));
        if (isTransient(error) && attempt < UNSTABLE_BACKOFF_MS.length) {
          await sleep(UNSTABLE_BACKOFF_MS[attempt]!);
          continue;
        }
        result.kind = "unstable";
        result.complete = false;
        result.diagnostics.push({ stage: "read", path: filePath, code: errorCode(error) || "FILE_READ_FAILED", message: "無法讀取文件，保留既有索引" });
        return result;
      }
      if (identityKey(second) !== firstKey) {
        if (options.deferUnstable) return defer("FILE_UNSTABLE");
        if (attempt < UNSTABLE_BACKOFF_MS.length) {
          await sleep(UNSTABLE_BACKOFF_MS[attempt]!);
          continue;
        }
        result.kind = "unstable";
        result.complete = false;
        result.diagnostics.push({ stage: "read", path: filePath, code: "FILE_UNSTABLE", message: "穩定觀察期間檔案仍在變動，保留既有索引" });
        return result;
      }
      info = second;
    }
    const extension = path.extname(filePath).toLowerCase();
    const reason = classifyReprocess({
      previous: previous ?? null, extension, sizeBytes: info.size, modifiedAtMs: info.mtimeMs,
    });
    const action = reprocessAction(reason, extension);
    if (action === "skip") {
      result.unchanged = 1;
      result.kind = "file-upsert";
      return result;
    }
    if (action === "metadata") {
      store.touchMetadata({
        path: filePath, filename: path.basename(filePath), extension,
        sizeBytes: info.size, modifiedAtMs: info.mtimeMs, status: "unsupported",
        errorCode: null, errorMessage: null, blocks: [],
      }, root);
      result.updated = 1;
      if (!previous) result.added = 1;
      result.kind = "file-upsert";
      return result;
    }
    const before = identityKey(info);
    try {
      const parsed = await documentFromFile(filePath, info, parse);
      const afterInfo = await lstatFn(filePath);
      if (identityKey(afterInfo) !== before) {
        if (options.deferUnstable) return defer("FILE_UNSTABLE");
        if (attempt < UNSTABLE_BACKOFF_MS.length) {
          await sleep(UNSTABLE_BACKOFF_MS[attempt]!);
          continue;
        }
        result.kind = "unstable";
        result.complete = false;
        result.diagnostics.push({ stage: "read", path: filePath, code: "FILE_UNSTABLE", message: "解析期間檔案仍在變動，保留既有索引" });
        return result;
      }
      if (afterInfo.isSymbolicLink() || !afterInfo.isFile()) {
        result.kind = "unstable";
        result.complete = false;
        return result;
      }
      store.upsert(parsed.document, root);
      result.parserCalls = parsed.parserCalls;
      result.updated = 1;
      if (!previous) result.added = 1;
      result.kind = "file-upsert";
      return result;
    } catch (error) {
      if (error instanceof IgnoreConfigurationError) throw error;
      if (isTransient(error) && options.deferUnstable) return defer(errorCode(error));
      if (isTransient(error) && attempt < UNSTABLE_BACKOFF_MS.length) {
        await sleep(UNSTABLE_BACKOFF_MS[attempt]!);
        continue;
      }
      const code = errorCode(error) || "PARSE_ERROR";
      if (TRANSIENT_CODES.has(code) || code === "FILE_UNSTABLE") {
        result.kind = "unstable";
        result.complete = false;
        result.diagnostics.push({ stage: "read", path: filePath, code, message: "無法穩定讀取文件，保留既有索引" });
        return result;
      }
      throw error;
    }
  }
  result.kind = "unstable";
  result.complete = false;
  result.diagnostics.push({ stage: "read", path: filePath, code: "FILE_UNSTABLE", message: "解析期間檔案仍在變動，保留既有索引" });
  return result;
}

export async function applyFileDelete(
  filePath: string,
  root: string,
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult> {
  return withWriterBackoff(store.databasePath, options, () => applyPathDeleteLocked(filePath, root, store, options));
}

async function applyPathDeleteLocked(
  filePath: string,
  root: string,
  store: IndexStore,
  options: LocalUpdateOptions,
): Promise<LocalUpdateResult> {
  const result = emptyResult("file-delete", filePath, root);
  if (!store.roots().includes(root)) {
    result.kind = "skipped";
    return result;
  }
  if (!await canSafelyDelete(filePath, root, options)) {
    result.kind = "retained";
    result.complete = false;
    result.diagnostics.push({
      stage: "scan",
      path: filePath,
      code: "DELETE_UNCONFIRMED",
      message: "無法確認父目錄或根目錄可讀，保留既有索引",
    });
    return result;
  }
  const removal = await store.removeMissing(new Set(), root, filePath);
  result.removed = removal.removed;
  result.kind = removal.removed > 1 || (removal.removed === 1 && !store.getDocument(filePath) && !samePath(filePath, root))
    ? (removal.removed > 1 ? "subtree-delete" : "file-delete")
    : "file-delete";
  return result;
}

export async function applyPathChange(
  filePath: string,
  root: string,
  store: IndexStore,
  options: LocalUpdateOptions = {},
): Promise<LocalUpdateResult> {
  const lstatFn = options.lstat ?? lstat;
  try {
    const info = await lstatFn(filePath);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const skipped = emptyResult("skipped", filePath, root);
      skipped.notices.push("目錄事件改由子樹校正處理");
      return skipped;
    }
    return applyFileUpdate(filePath, root, store, options);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return applyFileDelete(filePath, root, store, options);
    if (isTransient(error)) return applyFileUpdate(filePath, root, store, options);
    throw error;
  }
}

export function isIgnoreFile(filePath: string): boolean {
  return path.basename(filePath) === IGNORE_FILE;
}

export { emptyStatusCounts };
