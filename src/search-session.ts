import { materializeHits, openHits, totalTarget, type HitStream, type SearchField, type SearchMode, type SearchResult, type SearchResultPage, type SearchSort, type TotalMode } from "./search.js";
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
  stream: HitStream;
  trace: SearchTraceRecorder;
}

export class SearchSession {
  readonly originalQuery: string;
  readonly originalTotal: number;
  /** `gte` when the first layer stopped at the fast-mode limit (SPEC §52.3). */
  readonly originalTotalRelation: "eq" | "gte";
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
    private readonly totalMode: TotalMode = "fast",
  ) {
    this.originalQuery = rawQuery;
    this.mode = mode;
    const trace = new SearchTraceRecorder(rawQuery, mode, field, sort);
    const stream = openHits(store, rawQuery, { types, root, subtree, mode, field, statuses, sort, trace });
    stream.fill(totalTarget(totalMode));
    this.history = [{ rawQuery, stream, trace }];
    this.originalTotal = stream.results.length;
    this.originalTotalRelation = stream.done ? "eq" : "gte";
    this.dataVersion = store.dataVersion();
  }

  get conditions(): string[] {
    return this.history.map(layer => layer.rawQuery);
  }

  get currentTotal(): number {
    return this.current.stream.results.length;
  }

  get currentTotalRelation(): "eq" | "gte" {
    return this.current.stream.done ? "eq" : "gte";
  }

  get trace(): SearchTrace {
    return this.current.trace.snapshot(this.current.stream.results.length);
  }

  private get current(): SearchLayer {
    return this.history[this.history.length - 1]!;
  }

  ensureCurrent(): void {
    if (this.store.dataVersion() !== this.dataVersion) throw new SearchIndexChangedError();
  }

  /** Finish the current layer so a later exact-total request reuses its verified stream. */
  complete(): void {
    this.ensureCurrent();
    this.current.stream.fill(Number.POSITIVE_INFINITY);
  }

  append(rawQuery: string): void {
    this.ensureCurrent();
    const query = rawQuery.trim();
    if (!query) throw new Error("縮小條件不可為空白。");
    const trace = new SearchTraceRecorder(query, this.mode, this.field, this.sort);
    // The new condition filters the previous layer in its order and checks full content (D044, SPEC §52.2).
    const stream = openHits(this.store, query, { mode: this.mode, field: this.field, statuses: this.statuses, sort: this.sort,
      within: this.current.stream, trace });
    stream.fill(totalTarget(this.totalMode));
    this.history.push({ rawQuery: query, stream, trace });
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
    if (Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(pageSize) && pageSize > 0) layer.stream.fill(page * pageSize);
    return materializeHits(this.store, layer.stream.results, layer.rawQuery, this.mode, page, pageSize, layer.rawQuery, layer.trace, this.field);
  }
}

export function formatConditionChain(conditions: readonly string[]): string {
  return conditions.join(" → ");
}

/** "N" or "N 以上" when the count is a lower bound (SPEC §52.3). */
export function formatTotal(total: number, relation: "eq" | "gte"): string {
  return relation === "gte" ? `${total} 以上` : `${total}`;
}

export function formatSessionSummary(page: SearchResultPage, originalTotal: number, conditions: readonly string[],
  relations: { current: "eq" | "gte"; original: "eq" | "gte" } = { current: "eq", original: "eq" }): string[] {
  return [
    `搜尋條件：${formatConditionChain(conditions)}`,
    `符合 ${formatTotal(page.total, relations.current)} 份文件（最初 ${formatTotal(originalTotal, relations.original)} 份）；第 ${page.page}/${page.pageCount}${relations.current === "gte" ? "+" : ""} 頁，本頁 ${page.start}–${page.end}；回傳 ${page.results.length} 份。`,
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
    for (const line of formatSessionSummary(page, session.originalTotal, session.conditions,
      { current: session.currentTotalRelation, original: session.originalTotalRelation })) io.write(line);
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
        // A lower-bound total may have more pages than are known yet (SPEC §52.3).
        if (nextPage < 1 || (nextPage > page.pageCount && session.currentTotalRelation === "eq")) {
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
