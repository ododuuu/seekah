import { prepareSelectedContext, type SelectedContextReference, ContextError } from "./context.js";
import { parseTypes, type SearchField, type SearchMode, type SearchSort } from "./search.js";
import { SearchSession } from "./search-session.js";
import type { IndexStore } from "./store.js";

export class McpToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface SearchDocumentsInput {
  query: string;
  mode?: SearchMode;
  types?: readonly string[];
  root?: string;
  page?: number;
  pageSize?: number;
  field?: SearchField;
  statuses?: readonly import("./model.js").DocumentStatus[];
  sort?: SearchSort;
}

function resolveScope(store: IndexStore, root?: string): { root?: string; subtree?: string } {
  if (!root?.trim()) return {};
  try {
    const scope = store.resolveSearchScope(root);
    return { root: scope.root, ...(scope.subtree ? { subtree: scope.subtree } : {}) };
  } catch {
    throw new McpToolError("MCP_ROOT_NOT_INDEXED", "指定路徑不在目前已登錄的索引範圍內。");
  }
}

function resolveTypes(types?: readonly string[]): string[] | undefined {
  if (!types?.length) return undefined;
  try { return parseTypes(types.join(",")); }
  catch { throw new McpToolError("MCP_TYPES_INVALID", "types 必須是安全的副檔名清單。"); }
}

export function searchDocuments(store: IndexStore, input: SearchDocumentsInput) {
  const query = input.query.trim();
  const mode = input.mode ?? "phrase";
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 10;
  if (!query) throw new McpToolError("MCP_QUERY_EMPTY", "query 不可為空白。");
  if (mode !== "phrase" && mode !== "all-terms") throw new McpToolError("MCP_MODE_INVALID", "mode 必須是 phrase 或 all-terms。");
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50
    || (page - 1) * pageSize >= 500) {
    throw new McpToolError("MCP_PAGE_INVALID", "page／pageSize 超出範圍；每頁最多 50，且只可瀏覽前 500 筆候選。");
  }
  const types = resolveTypes(input.types);
  const scope = resolveScope(store, input.root);
  const field = input.field ?? "all";
  const sort = input.sort ?? "relevance";
  if (!["all", "filename", "content"].includes(field)) throw new McpToolError("MCP_FIELD_INVALID", "field 必須是 all、filename 或 content。");
  if (!["relevance", "filename", "modified"].includes(sort)) throw new McpToolError("MCP_SORT_INVALID", "sort 必須是 relevance、filename 或 modified。");
  const session = new SearchSession(store, query, types, scope.root, mode, scope.subtree, field, input.statuses, sort);
  const accessibleTotal = Math.min(session.originalTotal, 500);
  const pageCount = Math.max(1, Math.ceil(accessibleTotal / pageSize));
  if (page > pageCount) throw new McpToolError("MCP_PAGE_INVALID", `頁碼超出範圍；可瀏覽頁數為 ${pageCount}。`);
  const resultPage = session.page(page, pageSize);
  const results = resultPage.results.map(result => ({
    reference: result.reference,
    path: result.path,
    extension: result.extension,
    status: result.status,
    reason: result.reason,
    filenameOnly: result.filenameOnly,
    heading: result.heading,
    location: result.location,
    snippet: result.snippet,
    snippetTruncated: result.snippetTruncated,
    modifiedAt: new Date(result.modifiedAtMs).toISOString(),
  }));
  return {
    query,
    mode,
    total: session.originalTotal,
    accessibleTotal,
    truncatedToFirst500: session.originalTotal > 500,
    page,
    pageSize,
    pageCount,
    results,
    trace: session.trace,
  };
}

export interface PrepareContextInput {
  selections: readonly SelectedContextReference[];
  mode?: SearchMode;
  types?: readonly string[];
  root?: string;
  passages?: number;
  createdAt?: string;
  includeTimestamps?: boolean;
}

export async function prepareContextTool(store: IndexStore, input: PrepareContextInput) {
  const mode = input.mode ?? "phrase";
  if (mode !== "phrase" && mode !== "all-terms") throw new McpToolError("MCP_MODE_INVALID", "mode 必須是 phrase 或 all-terms。");
  const passages = input.passages ?? 3;
  if (!Number.isSafeInteger(passages) || passages < 1 || passages > 10) {
    throw new McpToolError("MCP_PASSAGES_INVALID", "passages 必須是 1～10 的整數。");
  }
  const types = resolveTypes(input.types);
  const scope = resolveScope(store, input.root);
  try {
    return await prepareSelectedContext(store, input.selections, {
      passages,
      format: "md",
      ...(types ? { types } : {}),
      ...(scope.root ? { root: scope.root } : {}),
      ...(scope.subtree ? { subtree: scope.subtree } : {}),
      ...(mode === "all-terms" ? { allTerms: true } : {}),
      ...(input.includeTimestamps === false ? { includeTimestamps: false } : {}),
    }, input.createdAt);
  } catch (error) {
    if (error instanceof ContextError) throw new McpToolError(error.code, error.message);
    throw error;
  }
}

export function indexStatus(store: IndexStore) {
  const roots = store.roots().map(root => {
    const report = store.getLastSyncReport(root);
    return {
      path: root,
      documentCount: store.documentCountForRoot(root),
      lastAttemptedSync: report.attemptedAt,
      lastSuccessfulSync: report.successfulAt,
      lastSyncComplete: report.complete,
      errors: report.errors,
      notices: report.notices,
      summary: report.summary,
      diagnostics: report.diagnostics.length,
    };
  });
  const format = store.formatStatus();
  return {
    databasePath: store.databasePath,
    readOnly: true,
    counts: store.counts(),
    roots,
    format: {
      contentStorageVersion: format.contentStorageVersion,
      payloadBloomVersion: format.payloadBloomVersion,
      ngramIndexVersion: format.ngramIndexVersion,
      ngramCompletedDocuments: format.ngramCompletedDocuments,
      ngramTablesReady: format.ngramTablesReady,
      needsUpgrade: format.needsUpgrade,
      completedDocuments: format.completedDocuments,
      totalDocuments: format.totalDocuments,
    },
  };
}
