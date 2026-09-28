import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { IGNORE_FILE, IgnoreConfigurationError } from "./ignore.js";
import { RootExclusion } from "./root-exclusion.js";
import { classifyReprocess, emptyStatusCounts, reprocessAction, supportedExtensions, type Diagnostic, type DocumentRecord } from "./model.js";
import { parseDocument } from "./parser.js";
import { throwIfAborted } from "./progress.js";
import { samePath } from "./root-plan.js";
import { isIndexArtifact, type IndexStore } from "./store.js";
import { acquireWriteLock, IndexBusyError } from "./write-lock.js";
import { shouldIgnoreWatchPath } from "./watch-path.js";

export const WRITER_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
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
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(options.signal);
    try {
      const release = acquire(databasePath);
      try { return await fn(); }
      finally { release(); }
    } catch (error) {
      if (!(error instanceof IndexBusyError)) throw error;
      const delay = WRITER_BACKOFF_MS[Math.min(attempt, WRITER_BACKOFF_MS.length - 1)]!;
      await sleep(delay);
    }
  }
}

async function loadRootIgnore(root: string, store: IndexStore): Promise<{ match(filePath: string, isDirectory: boolean): boolean }> {
  const exclusion = await RootExclusion.load(root, store);
  return {
    match(filePath, isDirectory) {
      return shouldIgnoreWatchPath(filePath, root) || exclusion.excludes(filePath, isDirectory);
    },
  };
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

function identityKey(info: { size: number; mtimeMs: number; ino?: number; dev?: number; isFile(): boolean }): string {
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
  const ignore = await loadRootIgnore(root, store);
  const lstatFn = options.lstat ?? lstat;
  const parse = options.parse ?? parseDocument;
  const sleep = options.sleep ?? sleepMs;
  const previous = store.getDocument(filePath);

  for (let attempt = 0; attempt <= UNSTABLE_BACKOFF_MS.length; attempt++) {
    throwIfAborted(options.signal);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstatFn(filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return applyPathDeleteLocked(filePath, root, store, options);
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
