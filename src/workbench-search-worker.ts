import { parentPort, workerData } from "node:worker_threads";
import { IndexStore } from "./store.js";
import { parseTypes } from "./search.js";
import { SearchSession } from "./search-session.js";
import { McpToolError, searchDocuments, type SearchDocumentsInput, type SearchDocumentsResult } from "./mcp-tools.js";

export interface WorkbenchSearchWorkerInput extends SearchDocumentsInput {
  /** 測試用；只由 createWorkbench 明確傳入，產品預設為 0。 */
  delayMs?: number;
}

export interface WorkbenchSearchWorkerResult extends SearchDocumentsResult {
  totalMode: "fast" | "exact";
}

export type WorkbenchSearchWorkerCommand = {
  type: "search";
  requestId: string;
  input: WorkbenchSearchWorkerInput;
};

export type WorkbenchSearchWorkerMessage =
  | { type: "result"; requestId: string; result: WorkbenchSearchWorkerResult }
  | { type: "error"; requestId: string; message: string; code?: string; errcode?: number };

interface WorkbenchSearchWorkerData {
  databasePath: string;
}

if (!parentPort) throw new Error("工作台搜尋 worker 缺少 parent port。");
const port = parentPort as NonNullable<typeof parentPort>;
const input = workerData as WorkbenchSearchWorkerData;
const store = new IndexStore(input.databasePath, { readOnly: true });
let session: SearchSession | undefined;
let sessionKey = "";
let closed = false;
let commandChain = Promise.resolve();

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  const errcode = errorNumber(error);
  if (errcode === 5 || errcode === 6) return "SQLITE_BUSY";
  if (errcode === 776) return "SQLITE_READONLY_ROLLBACK";
  if (errcode === 1288) return "SQLITE_READONLY_CANTINIT";
  if (errcode === 1294) return "SQLITE_CANTOPEN_DIRTYWAL";
  if (error.message === "database is locked" || error.message === "database table is locked") return "SQLITE_BUSY";
  return undefined;
}

function errorNumber(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") return undefined;
  return error.errcode;
}

function stableSessionKey(value: WorkbenchSearchWorkerInput): string {
  return JSON.stringify({
    query: value.query.trim(),
    mode: value.mode ?? "phrase",
    types: value.types ? [...value.types].sort() : null,
    root: value.root ?? null,
    field: value.field ?? "all",
    statuses: value.statuses ? [...value.statuses].sort() : null,
    sort: value.sort ?? "relevance",
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, delayMs);
  return promise;
}

function createSession(value: WorkbenchSearchWorkerInput): SearchSession {
  const types = value.types?.length
    ? (() => {
      try { return parseTypes(value.types!.join(",")); }
      catch { throw new McpToolError("MCP_TYPES_INVALID", "types 必須是安全的副檔名清單。"); }
    })()
    : undefined;
  let scope: { root?: string; subtree?: string } = {};
  if (value.root?.trim()) {
    try {
      const resolved = store.resolveSearchScope(value.root);
      scope = { root: resolved.root, ...(resolved.subtree ? { subtree: resolved.subtree } : {}) };
    } catch {
      throw new McpToolError("MCP_ROOT_NOT_INDEXED", "指定路徑不在目前已登錄的索引範圍內。");
    }
  }
  return new SearchSession(store, value.query, types, scope.root, value.mode ?? "phrase", scope.subtree,
    value.field ?? "all", value.statuses, value.sort ?? "relevance", value.exactTotal ? "exact" : "fast");
}

async function handle(command: WorkbenchSearchWorkerCommand): Promise<void> {
  const delayMs = Number.isSafeInteger(command.input.delayMs) ? Math.max(0, command.input.delayMs ?? 0) : 0;
  if (delayMs > 0) await wait(delayMs);
  const nextKey = stableSessionKey(command.input);
  if (sessionKey !== nextKey) {
    session = undefined;
    sessionKey = nextKey;
  }
  const { delayMs: _delayMs, ...searchInput } = command.input;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) session = createSession(command.input);
    try {
      const result = searchDocuments(store, searchInput, session);
      port.postMessage({ type: "result", requestId: command.requestId, result: { ...result, totalMode: store.searchTotalMode() } } satisfies WorkbenchSearchWorkerMessage);
      return;
    } catch (error) {
      if (errorCode(error) !== "SEARCH_INDEX_CHANGED" || attempt === 1) throw error;
      session = undefined;
      sessionKey = "";
    }
  }
}

port.on("message", (message: WorkbenchSearchWorkerCommand | { type: "close" }) => {
  if (message && message.type === "close") {
    closed = true;
    session = undefined;
    try { store.close(); } finally { port.close(); }
    return;
  }
  if (!message || message.type !== "search" || closed) return;
  commandChain = commandChain.then(() => handle(message)).catch(error => {
    const code = errorCode(error);
    const errcode = errorNumber(error);
    const errorMessage = {
      type: "error" as const,
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "搜尋無法完成。",
      ...(code ? { code } : {}),
      ...(errcode === undefined ? {} : { errcode }),
    };
    port.postMessage(errorMessage satisfies WorkbenchSearchWorkerMessage);
  });
});
