import { existsSync } from "node:fs";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { IndexStore } from "./store.js";
import { explainPath, indexStatus, McpToolError, prepareContextTool, searchDocuments } from "./mcp-tools.js";
import { describeIndexClientError } from "./index-errors.js";
import { LibraryStore, indexedLibraryDocument } from "./library.js";
import { MCP_APP_HTML, MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_URI } from "./mcp-app.js";
import { productVersion } from "./version.js";

export const MCP_TOOL_NAMES = ["search_documents", "prepare_context", "index_status", "explain_path", "open_search_app"] as const;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function errorResult(error: unknown): CallToolResult {
  if (error instanceof McpToolError) {
    return { content: [{ type: "text", text: `${error.code}：${error.message}` }], isError: true };
  }
  const classified = describeIndexClientError(error);
  if (classified) return { content: [{ type: "text", text: classified }], isError: true };
  return { content: [{ type: "text", text: "MCP_INTERNAL：無法完成本機工具呼叫。" }], isError: true };
}

export type McpIndexStoreFactory = (databasePath: string) => IndexStore;

export async function mcpWithStore(
  databasePath: string,
  operation: (store: IndexStore) => Promise<CallToolResult> | CallToolResult,
  createIndexStore: McpIndexStoreFactory = path => new IndexStore(path, { readOnly: true }),
): Promise<CallToolResult> {
  if (!existsSync(databasePath)) {
    return errorResult(new McpToolError("MCP_INDEX_MISSING", "索引尚未建立；請先在終端執行 docsearch index <root>。"));
  }
  let store: IndexStore | undefined;
  try {
    store = createIndexStore(databasePath);
    return await operation(store);
  } catch (error) {
    return errorResult(error);
  } finally {
    store?.close();
  }
}

const modeSchema = z.enum(["phrase", "all-terms"]).default("phrase");
const typesSchema = z.array(z.string().min(1).max(254)).max(50).optional();

export function createMcpServer(databasePath: string, options: { createIndexStore?: McpIndexStoreFactory } = {}): McpServer {
  const withStore = (
    operation: (store: IndexStore) => Promise<CallToolResult> | CallToolResult,
  ) => mcpWithStore(databasePath, operation, options.createIndexStore);
  const server = new McpServer(
    { name: "localdocsearch", version: productVersion },
    {
      instructions: "Search the existing local index first. Show document references to the user and call prepare_context only for references the user selected. Never imply that a snippet is the full document.",
    },
  );

  server.registerResource(
    "localdocsearch-search-context",
    MCP_APP_RESOURCE_URI,
    {
      title: "Seekah 搜尋與上下文工作台",
      description: "在已建立的本機索引中搜尋、人工勾選，並把已選片段加入 AI 上下文。",
      mimeType: MCP_APP_MIME_TYPE,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          prefersBorder: true,
        },
      },
    },
    async uri => ({
      contents: [{
        uri: uri.href,
        mimeType: MCP_APP_MIME_TYPE,
        text: MCP_APP_HTML,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            prefersBorder: true,
          },
        },
      }],
    }),
  );

  server.registerTool(
    "search_documents",
    {
      title: "搜尋本機文件",
      description: "唯讀搜尋 Seekah 既有索引，回傳有界片段與穩定文件代碼。先讓使用者選擇代碼，再呼叫 prepare_context。",
      inputSchema: z.object({
        query: z.string().min(1).max(1000),
        mode: modeSchema.optional(),
        types: typesSchema,
        root: z.string().min(1).max(32768).optional(),
        page: z.number().int().min(1).max(500).default(1),
        pageSize: z.number().int().min(1).max(50).default(10),
        exactTotal: z.boolean().optional().describe("true 時驗證全部候選以取得精確總數；預設在 500 筆後停止並以 totalRelation=gte 回報下限。"),
      }),
      annotations: readOnlyAnnotations,
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async input => withStore(store => {
      const result = searchDocuments(store, {
        query: input.query,
        page: input.page,
        pageSize: input.pageSize,
        ...(input.exactTotal !== undefined ? { exactTotal: input.exactTotal } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.types ? { types: input.types } : {}),
        ...(input.root ? { root: input.root } : {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }),
  );

  server.registerTool(
    "prepare_context",
    {
      title: "建立已選上下文",
      description: "只為使用者明確選定的 1～20 個文件代碼建立有界 Markdown 上下文；重新驗證索引與來源，不讀整庫或完整文件。",
      inputSchema: z.object({
        selections: z.array(z.object({
          query: z.string().min(1).max(1000),
          reference: z.string().regex(/^[1-9]\d*-[0-9a-f]{16}$/u),
        })).min(1).max(20),
        mode: modeSchema.optional(),
        types: typesSchema,
        root: z.string().min(1).max(32768).optional(),
        passages: z.number().int().min(1).max(10).default(3),
      }),
      annotations: readOnlyAnnotations,
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async input => withStore(async store => {
      const result = await prepareContextTool(store, {
        selections: input.selections,
        passages: input.passages,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.types ? { types: input.types } : {}),
        ...(input.root ? { root: input.root } : {}),
      });
      const library = new LibraryStore(databasePath);
      try {
        for (const selection of input.selections) {
          const document = indexedLibraryDocument(store, selection.reference);
          library.recordRecent({ ...document, action: "mcp" });
        }
      } finally { library.close(); }
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.data,
      };
    }),
  );

  server.registerTool(
    "index_status",
    {
      title: "查看本機索引狀態",
      description: "唯讀查看 Seekah 索引格式、文件狀態數與已登錄根目錄；不掃描來源或啟動更新。",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async () => withStore(store => {
      const result = indexStatus(store);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }),
  );

  server.registerTool(
    "explain_path",
    {
      title: "查詢檔案為何未出現在搜尋結果",
      description: "唯讀重新計算目前路徑的排除、索引、解析與根目錄狀態；只回傳路徑、規則、狀態與錯誤碼，不回傳文件內容。",
      inputSchema: z.object({ path: z.string().min(1).max(16_384) }),
      annotations: readOnlyAnnotations,
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async input => withStore(store => {
      const result = explainPath(store, input.path);
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }),
  );

  server.registerTool(
    "open_search_app",
    {
      title: "開啟 Seekah 搜尋工作台",
      description: "顯示本機文件搜尋、人工勾選與加入 AI 上下文的互動介面。此工具只展示介面；不支援 MCP Apps 時，請直接使用 search_documents 與 prepare_context。",
      inputSchema: z.object({
        query: z.string().max(1000).optional(),
        mode: modeSchema.optional(),
      }),
      annotations: readOnlyAnnotations,
      _meta: {
        ui: { resourceUri: MCP_APP_RESOURCE_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": MCP_APP_RESOURCE_URI,
        "openai/toolInvocation/invoking": "正在開啟本機搜尋工作台…",
        "openai/toolInvocation/invoked": "已開啟本機搜尋工作台。",
      },
    },
    async input => {
      const result = { query: input.query?.trim() ?? "", mode: input.mode ?? "phrase", selectionLimit: 20 };
      return {
        content: [{ type: "text", text: "已顯示 Seekah 搜尋工作台。若 Host 未顯示互動介面，請改用 search_documents 搜尋，再讓使用者選定文件代碼後呼叫 prepare_context。" }],
        structuredContent: result,
        _meta: { ui: { resourceUri: MCP_APP_RESOURCE_URI } },
      };
    },
  );

  return server;
}

export async function runMcpServer(databasePath: string): Promise<number> {
  serveStdio(() => createMcpServer(databasePath), {
    onerror: () => console.error("Seekah MCP transport error."),
  });
  console.error(`Seekah MCP ${productVersion} running on stdio.`);
  return 0;
}
