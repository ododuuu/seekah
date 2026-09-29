import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { IndexStore, dataDirectory, type TrashedRoot } from "./store.js";
import { indexStatus, prepareContextTool, searchDocuments } from "./mcp-tools.js";
import { emptySearchTrace } from "./search-trace.js";
import { AnswerTraceRecorder, type AnswerTrace } from "./answer-trace.js";
import { createTraceLog, readTraceLog, TRACE_LOG_FILES, TRACE_LOG_LIMIT } from "./trace-log.js";
import { MAX_FILE_BYTES } from "./parser.js";
import { documentStatuses, supportedExtensions, type DocumentStatus } from "./model.js";
import { combineWorkbenchContext, importDocument, sanitizeUploadName, WORKBENCH_FILE_LIMIT, type ImportedDocument } from "./workbench-context.js";
import { modelChoices, previewId, previewMatches, ProviderError, ProviderKeys, providerNames, providerSelections, requestProvider, requestProviderWithFallback, resolveModelRoute, routeSignature, validateModel, validateProvider, validateProviderSelection, type ProviderName, type ProviderSelection, type ProviderState, type RoutedProviderResult } from "./workbench-provider.js";
import { workbenchHtml } from "./workbench-app.js";
import { traceHtml } from "./trace-app.js";
import { actOnDocument, type DocumentAction } from "./open-document.js";
import { sync } from "./sync.js";
import { selectFolder } from "./folder-picker.js";
import { productVersion } from "./version.js";
import { OperationCancelledError, type ProgressUpdate } from "./progress.js";
import { isSqliteBusy, IndexBusyError } from "./write-lock.js";
import { AutoupdateError, autoupdateStart, autoupdateStatus, autoupdateStop, resolveAutoupdateReconcile } from "./autoupdate.js";
import { resolveWatchDebounce } from "./live-update.js";
import { autoupdateStartupDisable, autoupdateStartupEnable, autoupdateStartupStatus, type StartupCommandOptions } from "./autoupdate-startup.js";
import type { AutoupdateSettings } from "./autoupdate-control.js";
import { isPidAlive, readIndexingState, writeIndexingState, type PersistedIndexingReport, type PersistedIndexingState } from "./indexing-state.js";

const HOST = "127.0.0.1";
const JSON_LIMIT = 128 * 1024;

interface Selection { query: string; reference: string }
interface ContextRequest {
  provider: ProviderSelection;
  model: string;
  question: string;
  mode: "phrase" | "all-terms";
  selections: Selection[];
  fileIds: string[];
}

export interface WorkbenchOptions {
  databasePath: string;
  port?: number;
  token?: string;
  secret?: Buffer;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  tempParent?: string;
  indexHold?: () => Promise<void>;
  selectFolder?: () => Promise<string | null>;
  startupOptions?: Omit<StartupCommandOptions, "databasePath">;
}

export interface WorkbenchHandle {
  url: string;
  port: number;
  token: string;
  lastAnswerTrace(): AnswerTrace | null;
  waitForIndex(): Promise<void>;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error("要求內容超過上限。"), { statusCode: 413 });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw Object.assign(new Error("要求內容超過上限。"), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request, JSON_LIMIT);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw Object.assign(new Error("JSON 要求格式無效。"), { statusCode: 400 }); }
}
function rootList(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.roots) || body.roots.length < 1 || body.roots.length > 128
    || body.roots.some(root => typeof root !== "string" || !root.trim() || root.length > 16_384)) {
    throw Object.assign(new Error("根目錄清單無效。"), { statusCode: 400 });
  }
  return [...new Set(body.roots.map(root => (root as string).trim()))];
}

function contextRequest(body: Record<string, unknown>): ContextRequest {
  const provider = validateProviderSelection(body.provider);
  const model = validateModel(body.model);
  if (typeof body.question !== "string" || body.question.length > 8000) throw new Error("問題長度無效。");
  const question = body.question.trim();
  const mode = body.mode === "all-terms" ? "all-terms" : body.mode === "phrase" ? "phrase" : undefined;
  if (!mode) throw new Error("搜尋模式無效。");
  if (!Array.isArray(body.selections) || !Array.isArray(body.fileIds)) throw new Error("上下文選取格式無效。");
  const selections = body.selections.map(value => {
    if (!value || typeof value !== "object") throw new Error("索引選取格式無效。");
    const item = value as Record<string, unknown>;
    if (typeof item.query !== "string" || !item.query.trim() || item.query.length > 1000
      || typeof item.reference !== "string" || !/^[1-9]\d*-[0-9a-f]{16}$/u.test(item.reference)) throw new Error("索引選取格式無效。");
    return { query: item.query.trim(), reference: item.reference };
  });
  const fileIds = body.fileIds.map(value => {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/u.test(value)) throw new Error("拖曳文件代碼無效。");
    return value;
  });
  const uniqueReferences = new Set(selections.map(item => item.reference));
  const uniqueFiles = new Set(fileIds);
  if (uniqueReferences.size !== selections.length || uniqueFiles.size !== fileIds.length
    || selections.length + fileIds.length < 1 || selections.length + fileIds.length > WORKBENCH_FILE_LIMIT) throw new Error("索引與拖曳文件合計需要 1～20 份不重複項目。");
  return { provider, model, question, mode, selections, fileIds };
}

function providerStates(keys: ProviderKeys) {
  const states = Object.fromEntries(providerNames.map(provider => [provider, keys.state(provider)])) as Record<ProviderName, ProviderState>;
  const source = states.openai.source === "session" || states.xai.source === "session"
    ? "session"
    : states.openai.source === "environment" || states.xai.source === "environment" ? "environment" : null;
  return {
    ...states,
    auto: { configured: states.openai.configured || states.xai.configured, source, defaultModel: "auto" },
  };
}

function modelRoute(input: ContextRequest, keys: ProviderKeys) {
  return resolveModelRoute({
    provider: input.provider,
    model: input.model,
    question: input.question,
    openaiConfigured: Boolean(keys.get("openai")),
    xaiConfigured: Boolean(keys.get("xai")),
  });
}

const INDEX_BUSY_CLIENT_MESSAGE = "INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。";

async function withIndexStore<T>(
  databasePath: string,
  options: { readOnly?: boolean },
  operation: (store: IndexStore) => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let store: IndexStore | undefined;
    try {
      store = new IndexStore(databasePath, options.readOnly ? { readOnly: true } : undefined);
      return await operation(store);
    } catch (error) {
      if (!(error instanceof IndexBusyError || isSqliteBusy(error)) || attempt === 4) {
        throw error instanceof IndexBusyError || isSqliteBusy(error)
          ? Object.assign(new Error(INDEX_BUSY_CLIENT_MESSAGE), { statusCode: 409 })
          : error;
      }
      await new Promise<void>(resolve => { setTimeout(resolve, 100 * (attempt + 1)); });
    } finally {
      store?.close();
    }
  }
  throw Object.assign(new Error(INDEX_BUSY_CLIENT_MESSAGE), { statusCode: 409 });
}


async function openStore<T>(databasePath: string, operation: (store: IndexStore) => T | Promise<T>): Promise<T> {
  if (!existsSync(databasePath)) throw new Error("索引尚未建立；仍可只使用拖曳文件。");
  return withIndexStore(databasePath, { readOnly: true }, operation);
}

async function readWorkbenchIndexStatus(databasePath: string) {
  const readAt = new Date().toISOString();
  const defaultAutoupdateSettings = { debounceMs: resolveWatchDebounce(undefined), reconcileMs: resolveAutoupdateReconcile(undefined) };
  if (!existsSync(databasePath)) return {
    state: "missing" as const, readAt, trash: [] as TrashedRoot[], deleteConfirmation: true,
    totalMode: "fast" as const, autoupdateSettings: defaultAutoupdateSettings,
  };
  try {
    return await openStore(databasePath, store => {
      const status = indexStatus(store);
      return {
        state: "available" as const,
        readAt,
        ...status,
        trash: store.trashRoots(),
        deleteConfirmation: store.deleteConfirmationEnabled(),
        totalMode: store.searchTotalMode(),
        autoupdateSettings: store.autoupdateSettings(),
      };
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "INDEX_READ_FAILED";
    return {
      state: "unavailable" as const, readAt, errorCode: code, message: "索引目前無法唯讀讀取，請稍後重試。",
      trash: [] as TrashedRoot[], deleteConfirmation: true, totalMode: "fast" as const,
      autoupdateSettings: defaultAutoupdateSettings,
    };
  }
}

function workbenchStartupOptions(databasePath: string, options: Pick<WorkbenchOptions, "startupOptions">): StartupCommandOptions {
  return {
    ...(options.startupOptions ?? {}),
    databasePath,
    cliPath: options.startupOptions?.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
  };
}

function readAutoupdateStartupStatus(databasePath: string, options: Pick<WorkbenchOptions, "startupOptions">): {
  supported: boolean;
  enabled: boolean;
  message: string;
} {
  const startupOptions = workbenchStartupOptions(databasePath, options);
  const supported = (startupOptions.platform ?? process.platform) === "win32";
  try {
    const result = autoupdateStartupStatus(startupOptions);
    const enabled = supported && result.code === 0 && /^登入啟動：已啟用/u.test(result.text);
    return { supported, enabled, message: result.text };
  } catch (error) {
    return { supported, enabled: false, message: error instanceof Error ? error.message : "無法讀取登入啟動設定。" };
  }
}

function resolveWorkbenchAutoupdateSettings(body: Record<string, unknown>, current: AutoupdateSettings): AutoupdateSettings {
  let debounceMs = current.debounceMs;
  let reconcileMs = current.reconcileMs;
  if (body.autoupdateDebounceMs !== undefined) {
    if (typeof body.autoupdateDebounceMs !== "number" || !Number.isSafeInteger(body.autoupdateDebounceMs)) {
      throw new Error("背景自動更新變更等待設定無效。");
    }
    debounceMs = resolveWatchDebounce(body.autoupdateDebounceMs);
  }
  if (body.autoupdateReconcileMs !== undefined) {
    if (typeof body.autoupdateReconcileMs !== "number" || !Number.isSafeInteger(body.autoupdateReconcileMs)) {
      throw new Error("背景自動更新完整校正設定無效。");
    }
    reconcileMs = resolveAutoupdateReconcile(body.autoupdateReconcileMs);
  }
  return { debounceMs, reconcileMs };
}

async function readAutoupdateStatus(databasePath: string) {
  try {
    const result = await autoupdateStatus(databasePath);
    return {
      enabled: result.code === 0,
      available: result.code === 0,
      message: result.text,
      ...(result.code === 0 && result.live ? { live: result.live } : {}),
    };
  } catch (error) {
    if (error instanceof AutoupdateError && error.code === "AUTOUPDATE_NOT_RUNNING") {
      return { enabled: false, available: true, message: "背景自動更新未執行。" };
    }
    return { enabled: false, available: false, message: error instanceof Error ? error.message : "無法讀取背景自動更新狀態。" };
  }
}
interface WorkbenchIndexingState {
  state: "idle" | "running" | "stopping" | "stopped" | "complete" | "failed";
  message: string;
  roots: string[];
  reports: PersistedIndexingReport[];
  progress: ProgressUpdate | null;
  instanceId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

interface IndexWorkerReport extends PersistedIndexingReport {}

type IndexWorkerMessage =
  | { type: "progress"; progress: ProgressUpdate }
  | { type: "complete"; reports: IndexWorkerReport[] }
  | { type: "stopped"; message: string }
  | { type: "error"; message: string; code?: string };

const INDEX_STOP_GRACE_MS = 2000;

function progressPathLabel(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return normalized.split(/[\\/]/u).filter(Boolean).pop() ?? normalized;
}

function indexingMessage(progress: ProgressUpdate): string {
  const pathLabel = progress.path ? `；目前：${progressPathLabel(progress.path)}` : "";
  if (progress.current === undefined) return `${progress.message}${pathLabel}`;
  if (progress.total === undefined) return `${progress.message}；已發現 ${progress.current} 份${pathLabel}`;
  if (progress.total === 0) return `${progress.message}；沒有找到文件${pathLabel}`;
  const percent = progress.stage === "complete" ? 100 : Math.min((progress.current / progress.total) * 100, 99.99);
  return `${progress.message}：${progress.current}／${progress.total}（${percent.toFixed(2)}%）${pathLabel}`;
}

function initialIndexingState(databasePath: string, instanceId: string): WorkbenchIndexingState {
  const persisted = readIndexingState(databasePath);
  const now = new Date().toISOString();
  if (!persisted) {
    return { state: "idle", message: "尚未開始索引。", roots: [], reports: [], progress: null,
      instanceId, pid: process.pid, startedAt: now, updatedAt: now };
  }
  const interrupted = (persisted.state === "running" || persisted.state === "stopping")
    && persisted.pid !== process.pid && !isPidAlive(persisted.pid);
  return {
    state: interrupted ? "stopped" : persisted.state,
    message: interrupted ? "上次索引程序已中斷；已提交進度保留，重新索引會從已提交文件接續。" : persisted.message,
    roots: [...persisted.roots],
    reports: [...persisted.reports],
    progress: persisted.progress ? { ...persisted.progress } : null,
    instanceId: interrupted ? instanceId : persisted.instanceId,
    pid: interrupted ? process.pid : persisted.pid,
    startedAt: persisted.startedAt,
    updatedAt: interrupted ? now : persisted.updatedAt,
  };
}



export async function createWorkbench(options: WorkbenchOptions): Promise<WorkbenchHandle> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const secret = options.secret ?? randomBytes(32);
  const keys = new ProviderKeys(options.environment);
  const documents = new Map<string, ImportedDocument>();
  const consumedPreviews = new Set<string>();
  const tempRoot = await mkdtemp(path.join(options.tempParent ?? os.tmpdir(), "localdocsearch-ui-"));
  const sessionCreatedAt = new Date().toISOString();
  const instanceId = randomUUID();
  let origin = "";
  let indexing: WorkbenchIndexingState = initialIndexingState(options.databasePath, instanceId);
  let indexingTask: Promise<void> | undefined;
  let indexAbort: AbortController | undefined;
  let indexWorker: Worker | undefined;
  let indexingBusy = false;
  let lastPersistedAt = 0;
  let latestAnswerTrace: AnswerTrace | null = null;
  const traceLog = createTraceLog(dataDirectory(options.databasePath));

  function persistIndexing(force = false): void {
    const now = Date.now();
    if (!force && now - lastPersistedAt < 500) return;
    try {
      const state: PersistedIndexingState = {
        schemaVersion: 1,
        databasePath: options.databasePath,
        instanceId: indexing.instanceId,
        pid: indexing.pid,
        state: indexing.state,
        message: indexing.message,
        roots: [...indexing.roots],
        reports: [...indexing.reports],
        progress: indexing.progress ? { ...indexing.progress } : null,
        startedAt: indexing.startedAt,
        updatedAt: indexing.updatedAt,
      };
      writeIndexingState(state);
      lastPersistedAt = now;
    } catch {
      // 進度檔是診斷與恢復資訊，不能讓索引本身失敗。
    }
  }

  function updateProgress(progress: ProgressUpdate): void {
    indexing = { ...indexing, progress, message: indexingMessage(progress), updatedAt: new Date().toISOString() };
    persistIndexing();
  }

  function runIndexWorker(input: {
    databasePath: string;
    roots: string[];
    root?: string;
    upgradeOnly: boolean;
  }): Promise<{ reports: IndexWorkerReport[] }> {
    return new Promise((resolve, reject) => {
      const execArgv = process.execArgv.filter((argument, index) =>
        argument !== "--input-type" && !argument.startsWith("--input-type=") && process.execArgv[index - 1] !== "--input-type");
      const worker = new Worker(new URL("./index-worker.js", import.meta.url), { workerData: input, execArgv });
      indexWorker = worker;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (indexWorker === worker) indexWorker = undefined;
        callback();
      };
      worker.on("message", (message: IndexWorkerMessage) => {
        if (message.type === "progress") {
          updateProgress(message.progress);
        } else if (message.type === "complete") {
          finish(() => resolve({ reports: message.reports }));
        } else if (message.type === "stopped") {
          finish(() => reject(new OperationCancelledError()));
        } else {
          finish(() => {
            const error = new Error(message.message);
            if (message.code) Object.assign(error, { code: message.code });
            reject(error);
          });
        }
      });
      worker.once("error", error => finish(() => reject(error)));
      worker.once("exit", code => {
        if (code !== 0) finish(() => reject(new Error(`索引工作執行緒結束（${code}）。`)));
      });
    });
  }

  function requestWorkerStop(): void {
    const worker = indexWorker;
    if (!worker) return;
    worker.postMessage({ type: "stop" });
    const timer = setTimeout(() => {
      if (indexWorker === worker) void worker.terminate();
    }, INDEX_STOP_GRACE_MS);
    timer.unref();
  }

  function startIndex(root: string | undefined, upgradeOnly = false): WorkbenchIndexingState {
    if (indexingBusy) {
      if (root) throw Object.assign(new Error("索引進行中，請完成後再加入。"), { statusCode: 409 });
      return indexing;
    }
    if ((indexing.state === "running" || indexing.state === "stopping")
      && indexing.pid !== process.pid && isPidAlive(indexing.pid)) {
      throw Object.assign(new Error("另一個工作台程序正在索引；請等待它完成，或關閉該程序後再重試。"), { statusCode: 409 });
    }
    indexingBusy = true;
    let store: IndexStore | undefined;
    try {
      store = new IndexStore(options.databasePath);
    } catch (error) {
      indexingBusy = false;
      if (error instanceof IndexBusyError) {
        throw Object.assign(new Error("INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。"), { statusCode: 409 });
      }
      throw error;
    }
    const roots = root ? [root] : store.roots();
    if (!upgradeOnly && !roots.length) {
      store.close();
      indexingBusy = false;
      throw new Error("尚無索引根目錄；請先在工作台選擇要建立索引的資料夾。");
    }
    const now = new Date().toISOString();
    indexing = {
      state: "running",
      message: upgradeOnly ? "正在建立 unigram／trigram 搜尋 postings…" : "正在初始化索引…",
      roots,
      reports: [],
      progress: null,
      instanceId,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
    };
    persistIndexing(true);
    indexAbort = new AbortController();
    const abort = indexAbort;
    const useInProcess = Boolean(options.indexHold);
    if (!useInProcess) {
      store.close();
      store = undefined;
    }
    indexingTask = (async () => {
      try {
        if (useInProcess) {
          await Promise.race([
            options.indexHold!(),
            new Promise<never>((_, reject) => {
              abort.signal.addEventListener("abort", () => reject(new Error("索引已中止。")), { once: true });
            }),
          ]);
          if (upgradeOnly) {
            await store!.upgrade({ signal: abort.signal, onProgress: updateProgress });
          }
          if (!upgradeOnly) {
            for (const target of roots) {
              const report = await sync(target, store!, {
                requireRegistered: !root,
                signal: abort.signal,
                onProgress: updateProgress,
              });
              indexing.reports.push({
                root: report.root,
                complete: report.complete,
                found: report.found,
                updated: report.updated,
                unchanged: report.unchanged,
                removed: report.removed,
              });
            }
            if (indexing.reports.every(report => report.complete)) store!.purgeTrashRoots(roots);
          }
        } else {
          const result = await runIndexWorker({
            databasePath: options.databasePath,
            roots,
            ...(root === undefined ? {} : { root }),
            upgradeOnly,
          });
          indexing = { ...indexing, reports: result.reports, updatedAt: new Date().toISOString() };
        }
        indexing = {
          ...indexing,
          state: "complete",
          message: upgradeOnly ? "unigram／trigram 搜尋 postings 已建立。"
            : indexing.reports.every(report => report.complete) ? "索引已更新。" : "索引完成，但部分根目錄未完整同步。",
          updatedAt: new Date().toISOString(),
        };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
        const stopped = abort.signal.aborted || error instanceof OperationCancelledError;
        const message = stopped ? "索引同步已停止。"
          : code === "INDEX_BUSY" || error instanceof IndexBusyError
            ? "INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。"
            : error instanceof Error ? error.message : "索引無法完成。";
        indexing = { ...indexing, state: stopped ? "stopped" : "failed", message, updatedAt: new Date().toISOString() };
      } finally {
        store?.close();
        if (indexAbort === abort) indexAbort = undefined;
        indexingTask = undefined;
        indexingBusy = false;
        persistIndexing(true);
      }
    })();
    return indexing;
  }
  persistIndexing(true);


  const buildContext = async (input: ContextRequest) => {
    let indexedText = "";
    if (input.selections.length) {
      const prepared = await openStore(options.databasePath, store => prepareContextTool(store, {
        selections: input.selections,
        mode: input.mode,
        passages: 3,
        createdAt: sessionCreatedAt,
        includeTimestamps: false,
      }));
      indexedText = prepared.text;
    }
    const imported = input.fileIds.map(id => {
      const document = documents.get(id);
      if (!document) throw new Error("拖曳文件已不存在，請重新選取。");
      return document;
    });
    return combineWorkbenchContext(indexedText, imported);
  };

  const server = createServer(async (request, response) => {
    let activeAnswerTrace: AnswerTraceRecorder | undefined;
    try {
      const host = request.headers.host;
      const currentAddress = server.address();
      const currentPort = currentAddress && typeof currentAddress === "object" ? currentAddress.port : options.port ?? 0;
      if (!host || host !== `${HOST}:${currentPort}`) { json(response, 421, { error: "Host 不允許。" }); return; }
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && url.pathname === "/") {
        const nonce = randomBytes(18).toString("base64url");
        const body = workbenchHtml(nonce);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cross-origin-opener-policy": "same-origin",
        });
        response.end(body); return;
      }
      if (request.method === "GET" && url.pathname === "/traces") {
        const nonce = randomBytes(18).toString("base64url");
        const body = traceHtml(nonce);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cross-origin-opener-policy": "same-origin",
        });
        response.end(body); return;
      }
      if (!url.pathname.startsWith("/api/")) { json(response, 404, { error: "找不到本機資源。" }); return; }
      if (request.headers["x-localdocsearch-token"] !== token) { json(response, 403, { error: "工作階段 token 無效。" }); return; }
      if (request.method === "GET" && url.pathname === "/api/traces") {
        const typeValue = url.searchParams.get("type");
        const statusValue = url.searchParams.get("status");
        const limitValue = url.searchParams.get("limit");
        if (typeValue && typeValue !== "search" && typeValue !== "answer") throw new Error("Trace 類型篩選無效。");
        if (statusValue && statusValue !== "success" && statusValue !== "error") throw new Error("Trace 狀態篩選無效。");
        const limit = limitValue === null ? undefined : Number(limitValue);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Trace 筆數必須是 1～500。");
        const snapshot = readTraceLog(dataDirectory(options.databasePath), {
          ...(typeValue ? { type: typeValue as "search" | "answer" } : {}),
          ...(statusValue ? { status: statusValue as "success" | "error" } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
        json(response, 200, {
          ...snapshot,
          retention: { maxFiles: TRACE_LOG_FILES, maxFileBytes: TRACE_LOG_LIMIT },
          writeFailed: traceLog.failed,
        });
        return;
      }
      if (request.method !== "GET" && request.headers.origin !== origin) { json(response, 403, { error: "跨來源要求已拒絕。" }); return; }

      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, {
          indexAvailable: existsSync(options.databasePath),
          supportedExtensions: [...supportedExtensions].sort(),
          providers: providerStates(keys),
          providerChoices: [...providerSelections],
          modelChoices,
          fileLimit: WORKBENCH_FILE_LIMIT,
        }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/index-status") {
        json(response, 200, { ...await readWorkbenchIndexStatus(options.databasePath), indexing,
          autoupdate: await readAutoupdateStatus(options.databasePath),
          autoupdateStartup: readAutoupdateStartupStatus(options.databasePath, options) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/index") {
        const body = await readJson(request);
        const root = body.root;
        if (root !== undefined && (typeof root !== "string" || !root.trim() || root.length > 16_384)) {
          throw new Error("索引根目錄無效。");
        }
        json(response, 202, { indexing: startIndex(typeof root === "string" ? root.trim() : undefined) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/index/stop") {
        if (!indexingBusy || !indexAbort) {
          if ((indexing.state === "running" || indexing.state === "stopping")
            && indexing.pid !== process.pid && isPidAlive(indexing.pid)) {
            throw Object.assign(new Error("另一個工作台程序正在索引；請在原程序停止。"), { statusCode: 409 });
          }
          json(response, 200, { indexing }); return;
        }
        indexing = { ...indexing, state: "stopping", message: "正在停止索引同步…", updatedAt: new Date().toISOString() };
        persistIndexing(true);
        indexAbort.abort();
        requestWorkerStop();
        await indexingTask;
        json(response, 200, { indexing }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/index-roots/trash") {
        if (indexingBusy) throw Object.assign(new Error("索引進行中，請完成後再刪除根目錄。"), { statusCode: 409 });
        const roots = rootList(await readJson(request));
        json(response, 200, { removed: await withIndexStore(options.databasePath, {}, store => store.moveRootsToTrash(roots)) });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/api/trash") {
        if (indexingBusy) throw Object.assign(new Error("索引進行中，請完成後再清理垃圾桶。"), { statusCode: 409 });
        const roots = rootList(await readJson(request));
        json(response, 200, { removed: await withIndexStore(options.databasePath, {}, store => store.purgeTrashRoots(roots)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const body = await readJson(request);
        if (body.deleteConfirmation !== undefined && typeof body.deleteConfirmation !== "boolean") throw new Error("刪除提醒設定無效。");
        if (body.autoupdateEnabled !== undefined && typeof body.autoupdateEnabled !== "boolean") throw new Error("背景自動更新設定無效。");
        if (body.autoupdateStartup !== undefined && typeof body.autoupdateStartup !== "boolean") throw new Error("登入啟動設定無效。");
        if (body.totalMode !== undefined && body.totalMode !== "fast" && body.totalMode !== "exact") throw new Error("總筆數設定無效。");
        const hasAutoupdateParameterUpdate = body.autoupdateDebounceMs !== undefined || body.autoupdateReconcileMs !== undefined;
        const defaultAutoupdateSettings = { debounceMs: resolveWatchDebounce(undefined), reconcileMs: resolveAutoupdateReconcile(undefined) };
        let currentAutoupdateSettings = defaultAutoupdateSettings;
        if (existsSync(options.databasePath)) {
          currentAutoupdateSettings = await withIndexStore(options.databasePath, { readOnly: true }, store => store.autoupdateSettings());
        }
        const autoupdateSettings = resolveWorkbenchAutoupdateSettings(body, currentAutoupdateSettings);
        if (hasAutoupdateParameterUpdate && !existsSync(options.databasePath)) {
          throw new Error("索引尚未建立；無法保存背景自動更新參數。");
        }
        const liveBefore = hasAutoupdateParameterUpdate
          ? (await readAutoupdateStatus(options.databasePath)).live
          : undefined;
        const startupBefore = hasAutoupdateParameterUpdate
          ? readAutoupdateStartupStatus(options.databasePath, options)
          : undefined;
        const autoupdateParametersChanged = Boolean(liveBefore && hasAutoupdateParameterUpdate
          && (liveBefore.settings.debounceMs !== autoupdateSettings.debounceMs
            || liveBefore.settings.reconcileMs !== autoupdateSettings.reconcileMs));
        if (autoupdateParametersChanged && liveBefore?.mode === "foreground") {
          throw new AutoupdateError("AUTOUPDATE_FOREGROUND_ACTIVE", "前景監看請在原終端按 Ctrl+C 結束，不能從另一個程序遠端停止。");
        }
        let deleteConfirmation = true;
        let totalMode: "fast" | "exact" = "fast";
        if (body.deleteConfirmation !== undefined || body.totalMode !== undefined || existsSync(options.databasePath)) {
          const saved = await withIndexStore(options.databasePath, {}, store => {
            if (typeof body.deleteConfirmation === "boolean") store.setDeleteConfirmationEnabled(body.deleteConfirmation);
            if (body.totalMode === "fast" || body.totalMode === "exact") store.setSearchTotalMode(body.totalMode);
            if (hasAutoupdateParameterUpdate) store.setAutoupdateSettings(autoupdateSettings);
            return { deleteConfirmation: store.deleteConfirmationEnabled(), totalMode: store.searchTotalMode() };
          });
          deleteConfirmation = saved.deleteConfirmation;
          totalMode = saved.totalMode;
        }
        let settingsMessage = "";
        if (body.autoupdateEnabled === true) {
          if (autoupdateParametersChanged) {
            await autoupdateStop(options.databasePath);
            await autoupdateStart(autoupdateSettings, options.databasePath,
              { cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)) });
            settingsMessage = "背景自動更新已依新設定重新啟動。";
          } else {
            await autoupdateStart(autoupdateSettings, options.databasePath,
              { cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)) });
          }
        } else if (body.autoupdateEnabled === false) {
          try { await autoupdateStop(options.databasePath); }
          catch (error) {
            if (!(error instanceof AutoupdateError && error.code === "AUTOUPDATE_NOT_RUNNING")) throw error;
          }
        } else if (autoupdateParametersChanged) {
          await autoupdateStop(options.databasePath);
          await autoupdateStart(autoupdateSettings, options.databasePath,
            { cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)) });
          settingsMessage = "背景自動更新已依新設定重新啟動。";
        }
        if (body.autoupdateStartup !== undefined) {
          const startupOptions = workbenchStartupOptions(options.databasePath, options);
          if (body.autoupdateStartup === true) {
            await autoupdateStartupEnable({ ...startupOptions, autoupdateSettings });
          } else {
            autoupdateStartupDisable(startupOptions);
          }
        } else if (startupBefore?.enabled) {
          // Owned startup entries follow the saved GUI parameters without changing
          // the CLI's legacy no-flag shortcut output.
          await autoupdateStartupEnable({ ...workbenchStartupOptions(options.databasePath, options), autoupdateSettings });
        }
        json(response, 200, {
          deleteConfirmation,
          totalMode,
          autoupdateSettings,
          autoupdate: await readAutoupdateStatus(options.databasePath),
          autoupdateStartup: readAutoupdateStartupStatus(options.databasePath, options),
          ...(settingsMessage ? { message: settingsMessage } : {}),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/select-folder") {
        const selected = await (options.selectFolder ?? selectFolder)();
        json(response, 200, { root: selected }); return;
      }
      if (request.method === "POST" && (url.pathname === "/api/search" || url.pathname === "/api/search/count")) {
        // /api/search/count repeats the search verifying every candidate for an exact total (SPEC §52.3).
        const counting = url.pathname === "/api/search/count";
        const body = await readJson(request);
        const page = Number(body.page);
        const pageSize = Number(body.pageSize);
        if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new Error("工作台每頁最多 20 筆。");
        const field = body.field === "filename" || body.field === "content" ? body.field : body.field === "all" || body.field === undefined ? "all" : undefined;
        const sort = body.sort === "filename" || body.sort === "modified" ? body.sort : body.sort === "relevance" || body.sort === undefined ? "relevance" : undefined;
        if (!field || !sort) throw new Error("搜尋欄位或排序方式無效。");
        const statuses = body.statuses === undefined ? undefined : Array.isArray(body.statuses)
          && body.statuses.every(value => typeof value === "string" && documentStatuses.includes(value as DocumentStatus))
          ? [...new Set(body.statuses as DocumentStatus[])] : null;
        if (statuses === null) throw new Error("解析狀態篩選無效。");
        const types = body.types === undefined ? undefined : Array.isArray(body.types) && body.types.every(value => typeof value === "string")
          ? body.types as string[] : null;
        if (types === null) throw new Error("格式篩選無效。");
        const query = typeof body.query === "string" ? body.query.normalize("NFKC").toLowerCase().trim() : "";
        const searchInput: import("./mcp-tools.js").SearchDocumentsInput = {
          query: typeof body.query === "string" ? body.query : "", mode: body.mode === "all-terms" ? "all-terms" as const : "phrase" as const,
          page, pageSize, field, sort,
          ...(statuses ? { statuses } : {}), ...(types ? { types } : {}),
          ...(typeof body.root === "string" && body.root ? { root: body.root } : {}),
        };
        if (query && existsSync(options.databasePath)) {
          const ready = await openStore(options.databasePath, store => !store.formatStatus().needsUpgrade);
          if (!ready) {
            startIndex(undefined, true);
            json(response, 202, { pendingUpgrade: true, message: "搜尋索引升級尚未完成；背景升級完成後會自動搜尋。" });
            return;
          }
        }
        const hasIndex = existsSync(options.databasePath);
        const result = hasIndex
          ? await openStore(options.databasePath, store => ({
            ...searchDocuments(store, counting ? { ...searchInput, exactTotal: true } : searchInput), totalMode: store.searchTotalMode() }))
          : { query: searchInput.query.trim(), mode: searchInput.mode, total: 0, totalRelation: "eq" as const, accessibleTotal: 0,
            truncatedToFirst500: false, page, pageSize, pageCount: 1, results: [], totalMode: "fast" as const,
            trace: emptySearchTrace(searchInput.query, searchInput.mode!, field, sort) };
        if (!hasIndex) traceLog.write(result.trace);
        if (counting) { json(response, 200, { total: result.total, totalRelation: result.totalRelation }); return; }
        const temporaryResults = page === 1 && field !== "content" && !body.root ? [...documents.values()]
          .filter(document => (!types?.length || types.includes(document.extension))
            && (!statuses?.length || statuses.includes(document.status)) && document.filename.normalize("NFKC").toLowerCase().includes(query))
          .map(document => ({ id: document.id, temporary: true, path: document.filename, filename: document.filename,
            extension: document.extension, status: document.status, reason: "臨時文件檔名包含", filenameOnly: true,
            snippet: document.errorMessage ?? "臨時文件；只以檔名參與搜尋。", location: null })) : [];
        json(response, 200, { ...result, temporaryResults }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/files") {
        if (documents.size >= WORKBENCH_FILE_LIMIT) throw Object.assign(new Error("一次最多保留 20 份拖曳文件。"), { statusCode: 409 });
        const header = request.headers["x-file-name"];
        if (typeof header !== "string") throw Object.assign(new Error("缺少檔名。"), { statusCode: 400 });
        let decoded: string;
        try { decoded = decodeURIComponent(header); } catch { throw Object.assign(new Error("檔名編碼無效。"), { statusCode: 400 }); }
        const filename = sanitizeUploadName(decoded);
        const extension = path.extname(filename).toLowerCase();
        const content = await readBody(request, MAX_FILE_BYTES);
        const id = randomUUID();
        let document: ImportedDocument;
        if (!supportedExtensions.has(extension)) {
          document = { id, filename, extension, sizeBytes: content.length, status: "unsupported",
            errorCode: "FORMAT_UNSUPPORTED", errorMessage: "此格式不支援內容解析；只能搜尋檔名，不能加入上下文。", blocks: [] };
        } else {
          const temporary = path.join(tempRoot, `${randomUUID()}${extension}`);
          await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
          try { document = await importDocument(temporary, filename, id); }
          catch (error) {
            document = { id, filename, extension, sizeBytes: content.length, status: "error", errorCode: "PARSE_ERROR",
              errorMessage: error instanceof Error ? error.message : "文件解析失敗；只能搜尋檔名，不能加入上下文。", blocks: [] };
          } finally { await unlink(temporary).catch(() => {}); }
        }
        documents.set(document.id, document);
        const { blocks: _blocks, ...publicDocument } = document;
        json(response, 201, publicDocument); return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/files/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/files/".length));
        if (!documents.delete(id)) throw Object.assign(new Error("拖曳文件不存在。"), { statusCode: 404 });
        json(response, 200, { removed: true }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/providers") {
        const body = await readJson(request);
        const provider = validateProvider(body.provider);
        if (typeof body.key !== "string") throw new Error("缺少 API Key。");
        keys.configure(provider, body.key);
        json(response, 200, { providers: providerStates(keys) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/document-action") {
        const body = await readJson(request);
        if (typeof body.reference !== "string" || (body.action !== "open" && body.action !== "reveal")) {
          throw new Error("文件操作需要搜尋結果的文件代碼與有效動作。");
        }
        const reference = body.reference;
        const action: DocumentAction = body.action;
        const target = await openStore(options.databasePath, store => actOnDocument(store, reference, action));
        json(response, 200, { action, ...target }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/preview") {
        const input = contextRequest(await readJson(request));
        const built = await buildContext(input);
        const route = modelRoute(input, keys);
        const id = previewId(secret, { provider: input.provider, model: input.model, question: input.question, context: built.text, route: routeSignature(route) });
        json(response, 200, {
          previewId: id,
          context: built.text,
          bytes: built.bytes,
          documentCount: input.selections.length + input.fileIds.length,
          truncated: built.truncated,
          route,
        }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/ask") {
        const body = await readJson(request);
        const trace = new AnswerTraceRecorder(typeof body.question === "string" ? body.question : "");
        activeAnswerTrace = trace;
        const validationStarted = performance.now();
        const input = contextRequest(body);
        if (!input.question) throw new Error("送出 AI 前需要填寫問題。");
        if (body.confirmed !== true) throw new Error("尚未確認外部傳送。");
        trace.addPhase("inputValidation", performance.now() - validationStarted);
        const contextStarted = performance.now();
        const built = await buildContext(input);
        trace.addPhase("contextBuild", performance.now() - contextStarted);
        trace.setContext(built.bytes, input.selections.length + input.fileIds.length);
        const routeStarted = performance.now();
        const route = modelRoute(input, keys);
        trace.setRoute(route.primary.provider, route.primary.model);
        trace.addPhase("routeResolution", performance.now() - routeStarted);
        const previewStarted = performance.now();
        const expected = previewId(secret, { provider: input.provider, model: input.model, question: input.question, context: built.text, route: routeSignature(route) });
        if (!previewMatches(expected, body.previewId)) throw Object.assign(new Error("預覽已失效；請重新預覽並確認。"), { statusCode: 409 });
        if (typeof body.previewId !== "string" || consumedPreviews.has(body.previewId)) throw Object.assign(new Error("這次確認已送出或已失效，請重新產生預覽。"), { statusCode: 409 });
        consumedPreviews.add(body.previewId);
        trace.addPhase("previewValidation", performance.now() - previewStarted);
        const primaryKey = keys.get(route.primary.provider);
        const fallbackKey = route.fallback ? keys.get(route.fallback.provider) : undefined;
        let result: RoutedProviderResult;
        if (primaryKey) {
          result = await requestProviderWithFallback(
            { ...route.primary, question: input.question, context: built.text, apiKey: primaryKey },
            route.fallback && fallbackKey ? { ...route.fallback, question: input.question, context: built.text, apiKey: fallbackKey } : undefined,
            options.fetcher,
            trace,
          );
        } else if (route.fallback && fallbackKey) {
          result = { answer: await requestProvider({ ...route.fallback, question: input.question, context: built.text, apiKey: fallbackKey }, options.fetcher, trace), provider: route.fallback.provider, model: route.fallback.model, fallbackUsed: true };
        } else {
          throw new Error("尚未設定主要 Provider 的 API Key。");
        }
        trace.setRoute(result.provider, result.model);
        trace.setFallbackUsed(result.fallbackUsed);
        const answerTrace = trace.snapshot();
        latestAnswerTrace = answerTrace;
        traceLog.write(answerTrace);
        json(response, 200, { answer: result.answer, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed, trace: answerTrace }); return;
      }
      json(response, 404, { error: "找不到本機 API。" });
    } catch (error) {
      if (error instanceof IndexBusyError || isSqliteBusy(error)) {
        json(response, 409, { error: INDEX_BUSY_CLIENT_MESSAGE });
        return;
      }
      const status = error instanceof ProviderError ? 502 : error instanceof Error && "statusCode" in error ? Number((error as Error & { statusCode: number }).statusCode) : 400;
      const message = error instanceof ProviderError || error instanceof Error ? error.message : "無法完成要求。";
      const errorBody: Record<string, unknown> = { error: message.slice(0, 700) };
      if (activeAnswerTrace) {
        activeAnswerTrace.setError(error instanceof ProviderError ? error.code : "ANSWER_FAILED");
        const trace = activeAnswerTrace.snapshot();
        latestAnswerTrace = trace;
        traceLog.write(trace);
        errorBody.trace = trace;
      }
      json(response, Number.isSafeInteger(status) ? status : 400, errorBody);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, HOST, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    keys.destroy();
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("無法取得本機工作台連接埠。");
  origin = `http://${HOST}:${address.port}`;
  let closed = false;
  return {
    url: `${origin}/#${encodeURIComponent(token)}`,
    port: address.port,
    token,
    lastAnswerTrace: () => {
      const trace = latestAnswerTrace;
      if (!trace) return null;
      return { ...trace, phasesMs: { ...trace.phasesMs }, counts: { ...trace.counts } };
    },
    waitForIndex: async () => { await indexingTask; },
    close: async () => {
      if (closed) return;
      closed = true;
      if (indexingBusy && indexAbort) {
        indexing = { ...indexing, state: "stopping", message: "正在停止索引同步…", updatedAt: new Date().toISOString() };
        persistIndexing(true);
        indexAbort.abort();
        requestWorkerStop();
      }
      await indexingTask;
      keys.destroy();
      documents.clear();
      consumedPreviews.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export type BrowserLauncher = (url: string) => void;

export function launchBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function runWorkbenchCommand(databasePath: string, options: { openBrowser?: boolean; launcher?: BrowserLauncher; write?: (text: string) => void } = {}): Promise<number> {
  const handle = await createWorkbench({ databasePath });
  const write = options.write ?? console.log;
  write(`Seekah ${productVersion} 本機工作台：${handle.url}`);
  write("只接受這台電腦的瀏覽器連線；按 Ctrl+C 關閉並清除臨時文件與工作階段 API Key。");
  if (options.openBrowser !== false) (options.launcher ?? launchBrowser)(handle.url);
  await new Promise<void>(resolve => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await handle.close();
  return 0;
}
