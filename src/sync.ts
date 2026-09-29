import { acquireWriteLock } from "./write-lock.js";
import { IgnoreConfigurationError } from "./ignore.js";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { parseDocument } from "./parser.js";
import { scan, validateRoot, RootError } from "./scanner.js";
import { canonicalizeRootInput, planRootOperation, resolveUserRootPath, runtimePathPlatform, type RootOperationKind } from "./root-plan.js";
import { emptyStatusCounts, classifyReprocess, emptyReasonCounts, reprocessAction, reprocessReasonLabels, type Diagnostic, type DocumentRecord, type ReprocessReason, type SyncSummary } from "./model.js";
import { indexArtifactPaths, isIndexArtifact, type IndexStore, type RemovalResult, type UpsertTimings } from "./store.js";
import { OperationCancelledError, throwIfAborted, yieldToEvents, type ProgressUpdate } from "./progress.js";
import { addTimingSample, createTimingReservoir, rememberSlowFile, type SlowFileProfile, type TimingReservoir } from "./profile.js";

export interface SyncReport extends SyncSummary {
  root: string;
  errors: string[];
  notices: string[];
  diagnostics: Diagnostic[];
  ignoreFile: string | null;
  ignorePatterns: string[];
  complete: boolean;
  protectedScopes: string[];
  protectedByScanFailure: number;
  operation: RootOperationKind;
  mergedRoots: string[];
  retainedDocuments: number;
  coveringRoot: string | null;
  scanStart: string;
  checked: number;
  failedDocuments: number;
  reasonsAttempted: Record<ReprocessReason, number>;
  reasonsCommitted: Record<ReprocessReason, number>;
  phasesMs: Record<string, number>;
  formats: Record<string, number>;
  sourceBytes: number;
  peakRssBytes: number;
  sample: TimingReservoir;
  slowest: SlowFileProfile[];
}

export interface SyncOptions {
  rebuild?: boolean;
  requireRegistered?: boolean;
  lockHeld?: boolean;
  // 注入相同契約以測試零解析及讀檔失敗，不改變 CLI 行為。
  parse?: typeof parseDocument;
  scan?: typeof scan;
  signal?: AbortSignal;
  onProgress?: (update: ProgressUpdate) => void;
  excludePaths?: readonly string[];
}

export async function sync(rootInput: string, store: IndexStore, options: SyncOptions = {}): Promise<SyncReport> {
  const release = options.lockHeld ? undefined : acquireWriteLock(store.databasePath);
  try {
    options.onProgress?.({ stage: "upgrade", message: "檢查索引格式" });
    await store.upgrade({ lockHeld: true, ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
    throwIfAborted(options.signal);
    if ((options.requireRegistered || options.rebuild) && !store.roots().includes(resolveUserRootPath(rootInput))) {
      const merged = store.findMergedParent(resolveUserRootPath(rootInput));
      if (merged) {
        throw new RootError(options.rebuild
          ? `該路徑已合併至上層索引：${merged}；重建請指定有效根目錄，避免隱式擴大範圍。`
          : `該路徑已合併至上層索引：${merged}；請改對上層根目錄操作。`);
      }
      throw new RootError("根目錄已移除或尚未登錄，請重新選擇位置。");
    }
    const report = await syncLocked(rootInput, store, options);
    store.checkpointWal();
    return report;
  } catch (error) {
    if (error instanceof RootError || error instanceof IgnoreConfigurationError) {
      const registered = store.roots().find(root => root === resolveUserRootPath(rootInput));
      if (registered) store.recordSync(registered, false, [error.message], [], undefined,
        [{ stage: "scan", path: registered, code: "ROOT_SYNC_FAILED", message: "根目錄無法同步，保留既有索引" }]);
    }
    throw error;
  } finally { release?.(); }
}

async function syncLocked(rootInput: string, store: IndexStore, options: SyncOptions): Promise<SyncReport> {
  const started = performance.now();
  const canon = runtimePathPlatform() === "win32" ? canonicalizeRootInput(rootInput, "win32") : { path: rootInput };
  options.onProgress?.({ stage: "scan", message: "開始掃描根目錄", path: canon.path });
  const resolved = await validateRoot(canon.path);
  let actual: string;
  try { actual = await realpath(resolved); } catch { actual = resolved; }
  const existing = await Promise.all(store.roots().map(async registered => {
    let canonical: string;
    try { canonical = await realpath(registered); } catch { canonical = path.resolve(registered); }
    return { registered, actual: canonical };
  }));
  const plan = planRootOperation({ resolved, actual }, existing);
  let retainedDocuments = 0;
  if (plan.kind === "merge") {
    retainedDocuments = store.mergeChildRoots(plan.registeredRoot, plan.mergedRoots).transferred;
  }
  const root = plan.registeredRoot;
  const extraIgnoreBases = store.ignoreBases(root);
  const scanStart = plan.subtree ?? root;
  const enumerateStarted = performance.now();
  const found = options.scan
    ? await options.scan(root, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(extraIgnoreBases.length ? { extraIgnoreBases } : {}),
      ...(scanStart !== root ? { start: scanStart } : {}),
    })
    : await scan(root, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(extraIgnoreBases.length ? { extraIgnoreBases } : {}),
      ...(scanStart !== root ? { start: scanStart } : {}),
    });
  const enumerateMs = performance.now() - enumerateStarted;
  // 使用者可能把索引資料目錄放在被掃描根目錄內；LocalDocSearch 自己的資料庫
  // 與 WAL／協調檔不是來源文件，納入會造成每次同步都修改自己的輸入。
  const databasePath = path.resolve(store.databasePath);
  const internalPaths = new Set([...indexArtifactPaths(databasePath), ...(options.excludePaths ?? []).map(item => path.resolve(item))]);
  const sourcePaths = found.paths.filter(filePath => !internalPaths.has(path.resolve(filePath)) && !isIndexArtifact(filePath, databasePath));
  found.skipped.builtin += found.paths.length - sourcePaths.length;
  found.paths = sourcePaths;
  const notices: string[] = [];
  if (canon.rewrittenFrom !== undefined) notices.push(`已將根目錄 ${canon.rewrittenFrom} 視為 ${canon.path}`);
  if (plan.kind === "merge") {
    notices.push(`合併根目錄範圍：新增 ${root}，合併既有子根 ${plan.mergedRoots.length} 個，保留文件 ${retainedDocuments} 份。`);
    for (const child of plan.mergedRoots) notices.push(`合併：${child}`);
  } else if (plan.kind === "subtree") {
    notices.push(`已包含於上層索引：${plan.subtree} 屬於 ${root}；僅同步指定子樹，不新增重疊登錄。`);
  }
  for (const file of found.extraIgnoreFiles ?? []) notices.push(`沿用排除作用域：${file}`);
  const report: SyncReport = { root, found: found.paths.length, updated: 0, added: 0, reprocessed: 0,
    unchanged: 0, removed: 0, parserCalls: 0, statuses: emptyStatusCounts(), skipped: found.skipped,
    readErrors: found.diagnostics.length, elapsedMs: 0, diagnostics: [...found.diagnostics],
    ignoreFile: found.ignoreFile, ignorePatterns: found.ignorePatterns,
    errors: [...found.errors], notices, complete: found.errors.length === 0,
    protectedScopes: [...found.protectedScopes], protectedByScanFailure: 0,
    operation: plan.kind, mergedRoots: plan.mergedRoots, retainedDocuments,
    coveringRoot: plan.kind === "subtree" ? root : null, scanStart,
    checked: 0, failedDocuments: 0, reasonsAttempted: emptyReasonCounts(), reasonsCommitted: emptyReasonCounts(),
    phasesMs: {}, formats: {}, sourceBytes: 0, peakRssBytes: process.memoryUsage().rss,
    sample: createTimingReservoir(), slowest: [] };
  if (plan.kind !== "subtree") store.registerRoot(root);
  const knownPaths = new Set(found.paths);
  let processed = 0;
  let phase = "檢查 metadata";
  let phaseStartedMs = Date.now();
  const addPhase = (name: string, elapsedMs: number) => {
    report.phasesMs[name] = (report.phasesMs[name] ?? 0) + elapsedMs;
  };
  addPhase("enumerate", enumerateMs);
  const notePhase = (next: string) => {
    if (next === phase) return;
    phase = next;
    phaseStartedMs = Date.now();
  };
  const emit = (message: string, filePath?: string, slow?: ProgressUpdate["slow"]) => {
    const update: ProgressUpdate = {
      stage: "read", message, current: processed, total: found.paths.length,
      checked: report.checked, skipped: report.unchanged, committed: report.updated,
      parserCalls: report.parserCalls, failed: report.failedDocuments, phase, phaseStartedMs,
    };
    if (filePath) update.path = filePath;
    if (slow) update.slow = slow;
    options.onProgress?.(update);
  };
  try {
    for (const filePath of found.paths) {
      throwIfAborted(options.signal);
      const fileStarted = performance.now();
      let stage: Diagnostic["stage"] = "read";
      let extension = path.extname(filePath).toLowerCase();
      let sizeBytes = 0;
      let reason: ReprocessReason = "unchanged";
      let errorCode: string | null = null;
      try {
        notePhase("檢查 metadata");
        const statStarted = performance.now();
        const info = await stat(filePath);
        addPhase("stat", performance.now() - statStarted);
        sizeBytes = info.size;
        report.sourceBytes += info.size;
        report.formats[extension] = (report.formats[extension] ?? 0) + 1;
        const lookupStarted = performance.now();
        const previous = store.getDocument(filePath);
        addPhase("lookup", performance.now() - lookupStarted);
        reason = classifyReprocess({
          rebuild: Boolean(options.rebuild), previous: previous ?? null, extension,
          sizeBytes: info.size, modifiedAtMs: info.mtimeMs,
        });
        report.reasonsAttempted[reason]++;
        const action = reprocessAction(reason, extension);
        if (action === "skip") {
          report.unchanged++;
        } else {
          let document: DocumentRecord;
          if (action === "parse") {
            notePhase("讀取／解析");
            report.parserCalls++;
            emit("解析文件內容", filePath);
            const parseStarted = performance.now();
            document = await (options.parse ?? parseDocument)(filePath);
            addPhase("parse", performance.now() - parseStarted);
            document.sizeBytes = info.size;
            document.modifiedAtMs = info.mtimeMs;
          } else {
            document = {
              path: filePath, filename: path.basename(filePath), extension,
              sizeBytes: info.size, modifiedAtMs: info.mtimeMs, status: "unsupported",
              errorCode: null, errorMessage: null, blocks: [],
            };
          }
          stage = "store";
          notePhase(action === "parse" ? "壓縮／Bloom／寫入" : "SQLite 寫入／提交");
          emit("寫入文件索引", filePath);
          if (action === "parse") {
            const timings: UpsertTimings = { compressMs: 0, bloomMs: 0, deleteMs: 0, writeMs: 0, commitMs: 0 };
            store.upsert(document, root, timings);
            addPhase("compress", timings.compressMs);
            addPhase("bloom", timings.bloomMs);
            addPhase("delete", timings.deleteMs);
            addPhase("write", timings.writeMs);
            addPhase("commit", timings.commitMs);
          } else {
            const writeStarted = performance.now();
            store.touchMetadata(document, root);
            addPhase("write", performance.now() - writeStarted);
          }
          report.updated++;
          if (previous || options.rebuild) report.reprocessed++;
          else report.added++;
          report.reasonsCommitted[reason]++;
          report.statuses[document.status]++;
          errorCode = document.errorCode;
          if (document.status === "unsupported" && document.errorMessage) report.notices.push(`${filePath}: ${document.errorMessage}`);
          if (document.status === "error" || document.status === "encrypted") {
            const diagnostic: Diagnostic = { stage: "parse", path: filePath,
              code: document.errorCode ?? "PARSE_ERROR",
              message: document.status === "encrypted" ? "文件已加密，僅可搜尋檔名" : "無法解析文件，僅可搜尋檔名" };
            if (["EACCES", "EPERM", "ENOENT", "EIO", "EBUSY", "EISDIR", "EMFILE", "ENFILE"].includes(diagnostic.code)) {
              diagnostic.stage = "read";
              report.readErrors++;
              report.complete = false;
            }
            report.diagnostics.push(diagnostic);
            report.errors.push(`${filePath}: ${diagnostic.message}`);
          }
          if (document.status === "no_text" && document.extension === ".vsd") report.notices.push(`${filePath}: VSD 沒有可擷取的直接文字（未展開 master、動態欄位或 OCR）`);
          if (document.status === "no_text" && document.extension === ".pdf") report.notices.push(`${filePath}: PDF 沒有可擷取的文字層（掃描影像不支援 OCR）`);
        }
      } catch (error) {
        if (error instanceof OperationCancelledError) throw error;
        report.failedDocuments++;
        const diagnostic: Diagnostic = { stage, path: filePath,
          code: stage === "store" ? "INDEX_WRITE_FAILED" : "FILE_READ_FAILED",
          message: stage === "store" ? "無法更新文件索引" : "無法讀取文件" };
        report.diagnostics.push(diagnostic);
        report.errors.push(`${filePath}: ${diagnostic.message}`);
        if (stage === "read") report.readErrors++;
        report.complete = false;
        errorCode = diagnostic.code;
      }
      const elapsedMs = performance.now() - fileStarted;
      addTimingSample(report.sample, elapsedMs);
      rememberSlowFile(report.slowest, { seq: processed + 1, extension, bytes: sizeBytes, reason, elapsedMs, errorCode });
      report.peakRssBytes = Math.max(report.peakRssBytes, process.memoryUsage().rss);
      if (elapsedMs >= 5000) emit("慢檔仍在處理", filePath, {
        extension, bytes: sizeBytes, phase, elapsedMs, reason: reprocessReasonLabels[reason],
      });
      processed++;
      report.checked = processed;
      emit("檢查文件", filePath);
      if (processed % 25 === 0) await yieldToEvents();
    }
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      report.checked = processed;
      report.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      error.partial = report;
    }
    throw error;
  }
  try {
    throwIfAborted(options.signal);
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      report.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      error.partial = report;
    }
    throw error;
  }
  notePhase("刪除校正");
  const removeStarted = performance.now();
  let removal: RemovalResult;
  try {
    removal = await store.removeMissing(
      knownPaths,
      root,
      plan.kind === "subtree" ? scanStart : undefined,
      found.protectedScopes,
      { ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) },
    );
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      // Committed removal batches stay; the next sync recomputes the rest (SPEC §51.3).
      report.removed = (error.partial as RemovalResult | undefined)?.removed ?? 0;
      report.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      error.partial = report;
    }
    throw error;
  }
  report.removed = removal.removed;
  report.protectedByScanFailure = removal.protected;
  addPhase("remove", performance.now() - removeStarted);
  report.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  if (plan.kind !== "subtree") {
    const { root: _root, errors, notices: _notices, complete, diagnostics, ignoreFile: _ignoreFile, ignorePatterns: _ignorePatterns,
      operation: _operation, mergedRoots: _mergedRoots, retainedDocuments: _retainedDocuments, coveringRoot: _coveringRoot, scanStart: _scanStart,
      protectedScopes: _protectedScopes,
      phasesMs: _phasesMs, formats: _formats, sourceBytes: _sourceBytes, peakRssBytes: _peakRssBytes, sample: _sample, slowest: _slowest, ...summary } = report;
    store.recordSync(root, complete, errors, report.notices, summary, diagnostics);
  }
  options.onProgress?.({ stage: "complete", message: "索引同步完成", current: found.paths.length, total: found.paths.length, path: root });
  return report;
}
