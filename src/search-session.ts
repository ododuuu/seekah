import { collectHits, materializeHits, type RankedSearchResult, type SearchField, type SearchMode, type SearchResult, type SearchResultPage, type SearchSort } from "./search.js";
import type { DocumentStatus } from "./model.js";
import { SearchTraceRecorder, type SearchTrace } from "./search-trace.js";
import type { IndexStore } from "./store.js";
export class SearchIndexChangedError extends Error {
  readonly code = "SEARCH_INDEX_CHANGED";
  constructor() {
    super("索引已在工作階段期間更新，請重新執行搜尋以維持一致排序。");
    this.name = "SearchIndexChangedError";
  }
}

export const searchSessionPrompt = "[n] 下一頁  [p] 上一頁  [/ 關鍵字] 縮小  [back] 撤回  [reset] 重設  [q] 結束：";

export interface SearchSessionIO {
  write(text: string): void;
  writeError(text: string): void;
  ask(prompt: string): Promise<string | null>;
}

interface SearchLayer {
  rawQuery: string;
  ranked: RankedSearchResult[];
  trace: SearchTraceRecorder;
}

export class SearchSession {
  readonly originalQuery: string;
  readonly originalTotal: number;
  readonly dataVersion: number;
  readonly mode: SearchMode;
  private readonly history: SearchLayer[];

  constructor(
    private readonly store: IndexStore,
    rawQuery: string,
    types?: readonly string[],
    root?: string,
    mode: SearchMode = "phrase",
    subtree?: string,
    private readonly field: SearchField = "all",
    private readonly statuses?: readonly DocumentStatus[],
    private readonly sort: SearchSort = "relevance",
  ) {
    this.originalQuery = rawQuery;
    this.mode = mode;
    const trace = new SearchTraceRecorder(rawQuery, mode, field, sort);
    const ranked = collectHits(store, rawQuery, types, root, mode, undefined, subtree, field, statuses, sort, trace);
    this.history = [{ rawQuery, ranked, trace }];
    this.originalTotal = ranked.length;
    this.dataVersion = store.dataVersion();
  }

  get conditions(): string[] {
    return this.history.map(layer => layer.rawQuery);
  }

  get currentTotal(): number {
    return this.current.ranked.length;
  }

  get trace(): SearchTrace {
    return this.current.trace.snapshot(this.current.ranked.length);
  }

  private get current(): SearchLayer {
    return this.history[this.history.length - 1]!;
  }

  ensureCurrent(): void {
    if (this.store.dataVersion() !== this.dataVersion) throw new SearchIndexChangedError();
  }

  append(rawQuery: string): void {
    this.ensureCurrent();
    const query = rawQuery.trim();
    if (!query) throw new Error("縮小條件不可為空白。");
    const trace = new SearchTraceRecorder(query, this.mode, this.field, this.sort);
    const ranked = collectHits(this.store, query, undefined, undefined, this.mode, this.current.ranked.map(item => item.documentId),
      undefined, this.field, this.statuses, this.sort, trace);
    this.history.push({ rawQuery: query, ranked, trace });
  }

  back(): boolean {
    this.ensureCurrent();
    if (this.history.length === 1) return false;
    this.history.pop();
    return true;
  }

  reset(): boolean {
    this.ensureCurrent();
    if (this.history.length === 1) return false;
    this.history.length = 1;
    return true;
  }

  page(page: number, pageSize: number): SearchResultPage {
    this.ensureCurrent();
    const layer = this.current;
    return materializeHits(this.store, layer.ranked, layer.rawQuery, this.mode, page, pageSize, layer.rawQuery, layer.trace);
  }
}

export function formatConditionChain(conditions: readonly string[]): string {
  return conditions.join(" → ");
}

export function formatSessionSummary(page: SearchResultPage, originalTotal: number, conditions: readonly string[]): string[] {
  return [
    `搜尋條件：${formatConditionChain(conditions)}`,
    `符合 ${page.total} 份文件（最初 ${originalTotal} 份）；第 ${page.page}/${page.pageCount} 頁，本頁 ${page.start}–${page.end}；回傳 ${page.results.length} 份。`,
  ];
}

export async function runSearchSession(
  session: SearchSession,
  options: {
    pageSize: number;
    renderResults: (results: readonly SearchResult[], write: (text: string) => void) => void;
  },
  io: SearchSessionIO,
): Promise<number> {
  let currentPage = 1;
  const render = (): SearchResultPage => {
    const page = session.page(currentPage, options.pageSize);
    for (const line of formatSessionSummary(page, session.originalTotal, session.conditions)) io.write(line);
    options.renderResults(page.results, io.write);
    return page;
  };
  try {
    let page = render();
    while (true) {
      const rawAnswer = await io.ask(searchSessionPrompt);
      if (rawAnswer === null) return 0;
      const trimmed = rawAnswer.trim();
      if (!trimmed) {
        io.write("請輸入 n、p、q、back、reset，或 / 關鍵字。");
        continue;
      }
      const lower = trimmed.toLowerCase();
      if (lower === "q") return 0;
      if (lower === "n" || lower === "p") {
        const nextPage = lower === "n" ? currentPage + 1 : currentPage - 1;
        if (nextPage < 1 || nextPage > page.pageCount) {
          io.write(nextPage < 1 ? "已是第一頁。" : "已是最後一頁。");
          continue;
        }
        session.ensureCurrent();
        currentPage = nextPage;
        page = render();
        continue;
      }
      if (lower === "back") {
        if (!session.back()) io.write("已是最初結果。");
        else { currentPage = 1; page = render(); }
        continue;
      }
      if (lower === "reset") {
        if (!session.reset()) io.write("已是最初結果。");
        else { currentPage = 1; page = render(); }
        continue;
      }
      if (trimmed.startsWith("/")) {
        const query = trimmed.slice(1).trim();
        if (!query) {
          io.write("請在 / 之後輸入縮小條件。");
          continue;
        }
        session.append(query);
        currentPage = 1;
        page = render();
        continue;
      }
      io.write("請輸入 n、p、q、back、reset，或 / 關鍵字。");
    }
  } catch (error) {
    if (error instanceof SearchIndexChangedError) {
      io.writeError(`SEARCH_INDEX_CHANGED：${error.message}`);
      return 3;
    }
    throw error;
  }
}
