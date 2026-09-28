#!/usr/bin/env node
import { acquireWriteLock, IndexBusyError } from "./write-lock.js";
import { interactiveContext, ContextError } from "./context.js";
import { runWatch, WatchError, resolveWatchDebounce, resolveWatchRescan } from "./watch.js";
import { runAutoupdateCommand } from "./autoupdate.js";
import { actOnDocument, DocumentActionError } from "./open-document.js";
import { defaultDatabasePath, describeDatabaseLocation, formatMib, IndexStore, inspectDatabaseFile, type ExtensionStats, type StorageFootprint } from "./store.js";
import { parseTypes, type SearchResult } from "./search.js";
import { formatTotal, runSearchSession, SearchSession, SearchIndexChangedError } from "./search-session.js";
import { resolveUserRootPath } from "./root-plan.js";
import { RootError } from "./scanner.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IgnoreConfigurationError } from "./ignore.js";
import { reprocessReasonLabels, reprocessReasons, type Diagnostic, type SyncSummary } from "./model.js";
import { supportedExtensions } from "./model.js";
import { ClipboardError } from "./clipboard.js";
import { existsSync, statSync } from "node:fs";
import { createProgressReporter, OperationCancelledError } from "./progress.js";
import { createInterface } from "node:readline/promises";
import { runTui, TuiInputDecoder, type TuiEvent, type TuiStopReason } from "./tui.js";
import { StringDecoder } from "node:string_decoder";
import { buildIndexProfile, profilePaths, reserveNewProfile, writeIndexProfile } from "./profile.js";
import type { SyncReport } from "./sync.js";
import { productVersion } from "./version.js";

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return entries.length ? entries.map(([key, count]) => `${key}=${count}`).join("、") : "無";
}

function printDiagnosticAggregates(diagnostics: readonly Diagnostic[], noText: number, readErrors: number): void {
  const byStage: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  let parseErrors = 0;
  for (const item of diagnostics) {
    byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;
    byCode[item.code] = (byCode[item.code] ?? 0) + 1;
    if (item.stage === "parse") parseErrors++;
  }
  console.log(`本次 no_text：${noText}；讀取／掃描錯誤：${readErrors}；解析錯誤：${parseErrors}`);
  console.log(`診斷彙總（階段）：${formatCountMap(byStage)}`);
  console.log(`診斷彙總（錯誤碼）：${formatCountMap(byCode)}`);
}

function printStorage(footprint: StorageFootprint): void {
  console.log("索引容量（檔案長度，非檔案系統配置空間）：");
  for (const file of footprint.files) {
    if (file.missing) continue;
    if (file.unknown) console.log(`  ${file.label}：未知（讀取失敗）`);
    else console.log(`  ${file.label}：${file.bytes} bytes（${formatMib(file.bytes!)}）`);
  }
  if (footprint.incomplete) console.log("  合計：不完整（部分附屬檔讀取失敗，未以 0 計入）");
  else console.log(`  合計：${footprint.totalBytes} bytes（${formatMib(footprint.totalBytes ?? 0)}）`);
  if (footprint.approximate) console.log("  註：偵測到 WAL／journal 等附屬檔，以上為即時近似值。");
}

function printExtensionStats(stats: readonly ExtensionStats[]): void {
  console.log("已索引格式統計（metadata，未重新掃描來源）：");
  if (!stats.length) {
    console.log("  （無文件）");
    return;
  }
  for (const item of stats) {
    const label = item.extension || "（無副檔名）";
    const statuses = Object.entries(item.statuses).filter(([, count]) => count > 0)
      .map(([status, count]) => `${status}=${count}`).join("、");
    console.log(`  ${label}：${item.documents} 份，來源 ${item.sourceBytes} bytes（${formatMib(item.sourceBytes)}）；${statuses || "無狀態"}`);
  }
}

const OPERATIONAL_NOTICE = /^(合併根目錄範圍：|合併：|已包含於上層索引：|已將根目錄 |沿用排除作用域：|遇到資源回收筒)/;

function sqliteExtendedCode(error: unknown): number | undefined {
  return error instanceof Error && "errcode" in error ? (error as Error & { errcode?: number }).errcode : undefined;
}

export function buildHelpText(): string {
  return [
    "Seekah — 本機文件搜尋",
    "主要入口：seekah／seekah.cmd；下列 docsearch 命令保留相容，參數完全相同。",
    "",
    "  docsearch index [root] [--verbose] [--profile <新檔案>]    # 立即完整校正",
    "  docsearch search <query> [--all-terms] [--page <正整數>] [--page-size <1～100>] [--limit <正整數>] [--type <格式清單>] [--root <路徑>] [--exact-total] [--verbose]",
    "    --verbose（search）：stderr 輸出一行 SEARCH_TRACE <JSON>，供診斷查詢 phase、counts 與候選來源。",
    "    每次完成的 search trace 也追加至索引資料目錄 trace.log；Workbench 頂列 Trace 可開啟獨立診斷頁。",
    "  docsearch context [query] (--out <新檔案>|--clipboard) [--all-terms] [--format json|md] [--passages <1～10>] [--select <文件代碼,...>] [--type <格式>] [--root <路徑>] [--limit <1～500>]",
    "  docsearch open <文件代碼> [--dry-run]",
    "  docsearch reveal <文件代碼> [--dry-run]",
    "  docsearch roots [remove <root>]",
    "  docsearch status [--issues] [--types]",
    "  docsearch rebuild [root] [--verbose]",
    "  docsearch watch [root] [--debounce <毫秒>] [--rescan <毫秒>] [--verbose]",
    "  docsearch autoupdate start [--debounce <毫秒>] [--reconcile <毫秒>] [--data-dir <資料目錄>] # 初次索引後的日常變更",
    "  docsearch autoupdate status [--data-dir <資料目錄>]",
    "  docsearch autoupdate stop [--data-dir <資料目錄>]",
    "  docsearch autoupdate startup enable|disable|status",
    "  docsearch tui",
    "  docsearch ui [--no-open]",
    "  docsearch mcp",
    "  docsearch setup codex [--dry-run]",
    "  docsearch doctor",
    "  docsearch compact                                 # 回收刪除後留下的空白頁（需先停止背景自動更新）",
    "",
    "search 在互動終端預設每頁 20 筆，可用 n／p 翻頁、/ 關鍵字縮小結果、back 撤回、reset 重設、q 結束；單頁與零結果仍可操作。非互動輸出可用 --page 與 --page-size。--limit 保留為單次輸出的相容選項。",
    "index 可將涵蓋的既有子根合併為上層登錄；已包含於上層的子目錄只同步該子樹。--root 可為已登錄根目錄或其下子樹／已合併原子根。",
    "普通 index 是立即完整校正：會枚舉根目錄並比對既有索引。日常新增／修改／刪除請先 index 一次，再 autoupdate start。--profile <新檔案> 寫入不含路徑與正文的本機診斷（含 enumerate／stat／parse／compress／bloom／write／commit），拒絕覆寫；請用目前 shell 已展開的路徑。",
    `docsearch tui 為 ${productVersion} 全螢幕介面。/help 可翻頁；./help、./quit、./q、./exit 會改成對應命令並提示標準寫法。/quit、/q、/exit 與 EOF 退出 0，Ctrl+C 退出 130。`,
    "Windows 磁碟根目錄請用 D:/ ；加引號時請寫 D:/，不要讓路徑以反斜線結尾。",
    "context 預設 100、最高 500。--type 例如 pdf,docx,xml（可有前導點、忽略大小寫）。",
    `目前支援 ${[...supportedExtensions].join("、")}（PDF 只擷取文字層）；.class 僅檔名。搜尋前請先執行 index。`,
    "VSD v11 擷取直接儲存的圖形文字；不展開 master／動態欄位，舊版或不支援結構仍可搜尋檔名。",
    "文字與原始碼採嚴格 UTF-8，失敗才回退 Big5；XML 明確編碼宣告失敗不回退。",
    "查詢預設為整段子字串；--all-terms 要求空白分隔詞全部出現在同一文件。AND、*、? 不作進階查詢語法。",
    "context 內可用 s <查詢> 跨查詢累積選取，b 查看已選清單，r <編號> 移除。",
    "status 預設顯示容量與問題彙總；--issues 列出文件問題與各根同步診斷，--types 依副檔名統計。",
    "autoupdate start 在關閉原終端後繼續更新；不安裝服務、不要求管理員權限。登入啟動需明確執行 autoupdate startup enable，預設關閉。",
    "mcp 以本機 stdio 提供唯讀搜尋、已選上下文與索引狀態；stdout 專供 MCP 協定。",
    "ui 只綁定 127.0.0.1，提供索引搜尋、拖曳臨時文件、預覽與可選 OpenAI／xAI API；Ctrl+C 關閉並清除臨時資料。",
    "setup codex 安全註冊目前安裝的本機 MCP；同名異設定不覆寫。doctor 只讀檢查 Node、CLI、索引與 MCP App。",
  ].join("\n");
}

function emitProfile(filePath: string | undefined, status: "complete" | "cancelled" | "failed", report: SyncReport | undefined, store: IndexStore | undefined): void {
  if (!filePath || !report) return;
  try {
    const content = store?.contentStats() ?? { documents: 0, blocks: 0, payloads: 0, mappings: 0 };
    writeIndexProfile(filePath, buildIndexProfile({
      status, found: report.found, checked: report.checked, updated: report.updated, unchanged: report.unchanged,
      removed: report.removed, parserCalls: report.parserCalls, failedDocuments: report.failedDocuments,
      reasonsAttempted: report.reasonsAttempted, reasonsCommitted: report.reasonsCommitted, formats: report.formats,
      sourceBytes: report.sourceBytes, blocks: content.blocks, payloads: content.payloads, mappings: content.mappings,
      phasesMs: report.phasesMs, reservoir: report.sample, peakRssBytes: report.peakRssBytes, slowest: report.slowest,
    }));
    console.log("已寫入本機 profile（不含路徑、檔名或正文）。");
  } catch {
    console.error("PROFILE_WRITE_FAILED：索引已保留，診斷報告沒有寫完。");
  }
}

function printSummary(summary: SyncSummary): void {
  console.log(`找到 ${summary.found} 份一般檔案；更新 ${summary.updated}、未變更 ${summary.unchanged}、移除 ${summary.removed}。`);
  console.log(`新增 ${summary.added}、重新處理 ${summary.reprocessed}；解析器呼叫 ${summary.parserCalls} 次。`);
  if (summary.checked === undefined) console.log("檢查／失敗計數：未提供");
  else console.log(`已檢查 ${summary.checked}；文件失敗 ${summary.failedDocuments ?? "未提供"}。`);
  if (summary.reasonsAttempted && summary.reasonsCommitted) {
    const attempted = summary.reasonsAttempted;
    const committed = summary.reasonsCommitted;
    console.log(`更新原因（嘗試）：${reprocessReasons.map(reason => `${reprocessReasonLabels[reason]}=${attempted[reason]}`).join("、")}`);
    console.log(`更新原因（成功提交）：${reprocessReasons.map(reason => `${reprocessReasonLabels[reason]}=${committed[reason]}`).join("、")}`);
  } else {
    console.log("更新原因（嘗試）：未提供");
    console.log("更新原因（成功提交）：未提供");
  }
  console.log(`本次處理狀態：${Object.entries(summary.statuses).map(([status, count]) => `${status}=${count}`).join("、")}`);
  console.log(`略過項目（不計已排除目錄的內部文件）：內建規則 ${summary.skipped.builtin}、使用者規則 ${summary.skipped.user}、連結 ${summary.skipped.link}。${summary.skipped.unsupported ? ` 舊版未登錄格式 ${summary.skipped.unsupported}。` : ""}`);
  console.log(`掃描／讀取錯誤 ${summary.readErrors}；同步耗時 ${summary.elapsedMs} ms。`);
  if (summary.protectedByScanFailure !== undefined) {
    console.log(`掃描失敗範圍保留 ${summary.protectedByScanFailure} 份既有索引。`);
  }
}

function printSearchResults(results: readonly SearchResult[], verbose: boolean, write: (text: string) => void = console.log): void {
  for (const result of results) {
    write(`${result.path} (${result.extension})`);
    write(`  文件代碼：${result.reference}；open ${result.reference}／reveal ${result.reference}`);
    write(`  命中：${result.reason}${result.filenameOnly ? "（僅檔名命中）" : ""}`);
    if (result.condition) write(`  條件：${result.condition}`);
    if (result.status !== "indexed") write(`  解析狀態：${result.status}`);
    if (result.heading) write(`  標題：${result.heading}`);
    if (result.location) write(`  位置：${result.location}`);
    write(`  片段：${result.snippet}${result.snippetTruncated ? "（命中文字已截短）" : ""}`);
    write(`  修改：${new Date(result.modifiedAtMs).toISOString()}`);
    if (verbose) write(`  排序：等級 ${result.rank}；同級按修改時間 ${result.modifiedAtMs} 由新到舊，再按完整路徑固定字串順序：${result.path}`);
  }
}

function printSearchTrace(trace: unknown): void {
  console.error(`SEARCH_TRACE ${JSON.stringify(trace)}`);
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(buildHelpText());
    return 0;
  }
  const command = args[0];
  if (command === "autoupdate") return runAutoupdateCommand(args.slice(1));
  if (command === "mcp") {
    if (args.length !== 1) { console.error("用法：docsearch mcp"); return 2; }
    const { runMcpServer } = await import("./mcp.js");
    return runMcpServer(defaultDatabasePath());
  }
  if (command === "ui") {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== "--no-open")) { console.error("用法：docsearch ui [--no-open]"); return 2; }
    const { runWorkbenchCommand } = await import("./workbench.js");
    return runWorkbenchCommand(defaultDatabasePath(), { openBrowser: args[1] !== "--no-open" });
  }
  if (command === "setup") {
    if (args[1] !== "codex" || args.length > 3 || (args[2] !== undefined && args[2] !== "--dry-run")) {
      console.error("用法：docsearch setup codex [--dry-run]"); return 2;
    }
    const { setupCodex } = await import("./host-setup.js");
    return setupCodex({
      cliPath: path.resolve(process.argv[1] ?? "dist/src/cli.js"),
      ...(args[2] === "--dry-run" ? { dryRun: true } : {}),
    });
  }
  if (command === "doctor") {
    if (args.length !== 1) { console.error("用法：docsearch doctor"); return 2; }
    const { runDoctor } = await import("./host-setup.js");
    return runDoctor({ databasePath: defaultDatabasePath(), cliPath: path.resolve(process.argv[1] ?? "dist/src/cli.js") });
  }
  if (command === "compact") {
    // SPEC §52.4: rewrite the index without free pages; refuses while background autoupdate may write.
    if (args.length !== 1) { console.error("用法：docsearch compact"); return 2; }
    const databasePath = defaultDatabasePath();
    if (!existsSync(databasePath)) { console.error("索引尚未建立。"); return 2; }
    const { autoupdateStatus } = await import("./autoupdate.js");
    const running = await autoupdateStatus(databasePath).then(result => result.code === 0, () => false);
    if (running) { console.error("背景自動更新執行中；請先執行 autoupdate stop，壓縮完成後再 autoupdate start。"); return 3; }
    const before = statSync(databasePath).size;
    const store = new IndexStore(databasePath);
    const release = acquireWriteLock(databasePath);
    try {
      console.log(`壓縮資料庫中（可回收約 ${formatMib(before * store.freePageRatio())}）…`);
      store.compact();
    } finally { release(); store.close(); }
    console.log(`壓縮完成：${formatMib(before)} → ${formatMib(statSync(databasePath).size)}。`);
    return 0;
  }
  if (!["index", "search", "status", "rebuild", "open", "reveal", "roots", "context", "watch", "tui"].includes(command ?? "")) {
    console.error(`未知命令：${command}`);
    return 2;
  }
  let contextOutput: string | undefined;
  let contextClipboard = false;
  let allTerms = false;
  let exactTotal = false;
  let selectedReferences: string[] | undefined;
  let contextFormat: "json" | "md" = "json";
  let contextPassages = 3;
  let watchDebounce: number | undefined;
  let watchRescan: number | undefined;
  const contextQuery = command === "context" && args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  let rootInput: string | undefined;
  let rootFilter: string | undefined;
  let dryRun = false;
  let limit = command === "context" ? 100 : 20;
  let limitSpecified = false;
  let searchPage = 1;
  let searchPageSpecified = false;
  let searchPageSize = 20;
  let searchPageSizeSpecified = false;
  let verbose = false;
  let profilePath: string | undefined;
  let types: string[] | undefined;
  let statusIssues = false;
  let statusTypes = false;
  try {
    if (command === "watch") {
      const values: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const option = args[i]!;
        if (option === "--verbose") {
          if (verbose) throw new Error("不可重複指定 --verbose。");
          verbose = true;
        } else if (option === "--debounce") {
          if (watchDebounce !== undefined) throw new Error("不可重複指定 --debounce。");
          const value = args[++i];
          if (!value || value.startsWith("--")) throw new Error("--debounce 缺少毫秒數。");
          watchDebounce = resolveWatchDebounce(Number(value));
        } else if (option === "--rescan") {
          if (watchRescan !== undefined) throw new Error("不可重複指定 --rescan。");
          const value = args[++i];
          if (!value || !value.trim() || value.startsWith("--")) throw new Error("--rescan 缺少毫秒數。");
          watchRescan = resolveWatchRescan(Number(value));
        } else if (option.startsWith("--") || !option.trim()) {
          throw new Error("用法：docsearch watch [root] [--debounce <毫秒>] [--rescan <毫秒>] [--verbose]");
        } else {
          if (values.length) throw new Error("用法：docsearch watch [root] [--debounce <毫秒>] [--rescan <毫秒>] [--verbose]");
          values.push(option);
        }
      }
      rootInput = values[0];
    } else if (command === "tui") {
      if (args.length !== 1) throw new Error("用法：docsearch tui");
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("tui 需要互動終端。");
    } else if (command === "index" || command === "rebuild") {
      const values: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const option = args[i]!;
        if (option === "--verbose") {
          if (verbose) throw new Error("不可重複指定 --verbose。");
          verbose = true;
        } else if (option === "--profile") {
          if (command !== "index") throw new Error("--profile 只用於 index。");
          if (profilePath) throw new Error("不可重複指定 --profile。");
          const value = args[++i];
          if (!value || value.startsWith("--")) throw new Error("--profile 需要一個新的檔案路徑。");
          profilePath = path.resolve(value);
        } else if (option.startsWith("--") || !option.trim()) {
          throw new Error(`用法：docsearch ${command} [root] [--verbose]${command === "index" ? " [--profile <新檔案>]" : ""}`);
        } else if (values.length) {
          throw new Error(`用法：docsearch ${command} [root] [--verbose]${command === "index" ? " [--profile <新檔案>]" : ""}`);
        } else values.push(option);
      }
      rootInput = values[0];
    } else if (command === "roots") {
      if (args.length !== 1 && !(args.length === 3 && args[1] === "remove" && args[2] && !args[2].startsWith("--"))) throw new Error("用法：docsearch roots [remove <root>]");
    } else if (command === "open" || command === "reveal") {
      if (!args[1] || !/^[1-9]\d*-[0-9a-f]{16}$/.test(args[1]) || !Number.isSafeInteger(Number(args[1].split("-")[0])) || args.length > 3 || (args[2] !== undefined && args[2] !== "--dry-run")) throw new Error(`用法：docsearch ${command} <文件代碼> [--dry-run]`);
      dryRun = args[2] === "--dry-run";
    } else if (command === "status") {
      const seen = new Set<string>();
      for (const option of args.slice(1)) {
        if (option !== "--issues" && option !== "--types") throw new Error("用法：docsearch status [--issues] [--types]");
        if (seen.has(option)) throw new Error(`不可重複指定 ${option}。`);
        seen.add(option);
      }
      statusIssues = seen.has("--issues");
      statusTypes = seen.has("--types");
    } else {
      if (command !== "context" && !args[1]?.trim()) throw new Error("搜尋文字不可為空白。");
      const seen = new Set<string>();
      for (let i = command === "context" && contextQuery === undefined ? 1 : 2; i < args.length; i++) {
        const option = args[i]!;
        if (seen.has(option)) throw new Error(`不可重複指定 ${option}。`);
        seen.add(option);
        if (option === "--out" && command === "context") {
          const value = args[++i];
          if (!value?.trim() || value.startsWith("--")) throw new Error("--out 缺少新檔案路徑。");
          contextOutput = value;
        } else if (option === "--clipboard" && command === "context") {
          contextClipboard = true;
        } else if (option === "--all-terms") {
          allTerms = true;
        } else if (option === "--exact-total" && command === "search") {
          exactTotal = true;
        } else if (option === "--select" && command === "context") {
          const value = args[++i];
          if (!value) throw new Error("--select 缺少文件代碼。");
          selectedReferences = value.split(",").map(item => item.trim());
          if (selectedReferences.some(item => !/^[1-9]\d*-[0-9a-f]{16}$/.test(item)) || new Set(selectedReferences).size > 20) throw new Error("--select 需為最多 20 份文件代碼，以逗號分隔。");
        } else if (option === "--format" && command === "context") {
          const value = args[++i];
          if (value !== "json" && value !== "md") throw new Error("--format 必須是 json 或 md。");
          contextFormat = value;
        } else if (option === "--passages" && command === "context") {
          const value = args[++i];
          if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 10) throw new Error("--passages 必須是 1～10 的整數。");
          contextPassages = Number(value);
        } else if (option === "--verbose") verbose = true;
        else if (option === "--limit") {
          const value = args[++i];
          if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--limit 必須是正整數。");
          limit = Number(value);
          limitSpecified = true;
        } else if (option === "--page" && command === "search") {
          const value = args[++i];
          if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--page 必須是正整數。");
          searchPage = Number(value); searchPageSpecified = true;
        } else if (option === "--page-size" && command === "search") {
          const value = args[++i];
          if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new Error("--page-size 必須是 1～100 的整數。");
          searchPageSize = Number(value); searchPageSizeSpecified = true;
        } else if (option === "--root") {
          const value = args[++i];
          if (!value || value.startsWith("--")) throw new Error("--root 缺少根目錄路徑。");
          rootFilter = value;
        } else if (option === "--type") {
          const value = args[++i];
          if (value === undefined) throw new Error("--type 缺少格式清單。");
          types = parseTypes(value);
        } else throw new Error(command === "context" ? "用法：docsearch context [query] (--out <新檔案>|--clipboard) [--all-terms] [--select <文件代碼,...>] [--limit <1～500>] [--type <格式>] [--root <路徑>]" : "用法：docsearch search <query> [--all-terms] [--page <正整數>] [--page-size <1～100>] [--limit <正整數>] [--type <格式清單>] [--root <路徑>] [--exact-total] [--verbose]");
      }
      if (command === "context" && (Boolean(contextOutput) === contextClipboard || limit > 500)) throw new Error("context 需要在 --out <新檔案> 與 --clipboard 中擇一；--limit 限 1～500；--format 為 json|md，--passages 為 1～10。");
      if (command === "search" && limitSpecified && (searchPageSpecified || searchPageSizeSpecified)) throw new Error("--limit 不可與 --page 或 --page-size 同時使用。");
    }
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  let store: IndexStore | undefined;
  let reporter: ReturnType<typeof createProgressReporter> | undefined;
  let abortController: AbortController | undefined;
  let cancel: (() => void) | undefined;
  try {
    const databasePath = defaultDatabasePath();
    const writes = command === "index" || command === "rebuild" || command === "watch" || (command === "roots" && args[1] === "remove");
    if (command === "index" || command === "rebuild") {
      const location = describeDatabaseLocation();
      console.log(`索引位置：${location.path}`);
      console.log(`位置來源：${location.sourceLabel}`);
      const inspection = inspectDatabaseFile(location.path);
      if (inspection.error) { console.error(inspection.error); return 3; }
      console.log(inspection.exists ? "既有索引：沿用同一資料庫，不會因安裝路徑或版本變更而清空。" : "將建立新索引。");
      if (!inspection.exists && location.source !== "home-fallback") console.log("提示：資料目錄被明確指定；請核對上方路徑是否為預期的索引。");
    }
    if (profilePath) {
      try { reserveNewProfile(profilePath); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
    }
    if (command === "status") console.log(`索引位置：${databasePath}\n讀取索引狀態…`);
    if (!writes && !existsSync(databasePath)) { console.error("索引尚未建立；請先執行 docsearch index <root>。"); return 3; }
    if (writes) {
      reporter = createProgressReporter({ isTTY: Boolean(process.stderr.isTTY), verbose });
      reporter.update({ stage: "recover", message: "開啟並檢查本機索引" });
      abortController = new AbortController();
      cancel = () => abortController!.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
    }
    store = new IndexStore(databasePath, { readOnly: !writes });
    if (writes && !(command === "roots" && args[1] === "remove")) {
      await store.upgrade({ ...(abortController ? { signal: abortController.signal } : {}), onProgress: update => reporter?.update(update) });
    }

    if (command === "watch") {
      const registered = store.roots();
      let targets: string[];
      if (rootInput) {
        const requested = resolveUserRootPath(rootInput);
        const existing = registered.find(root => process.platform === "win32" ? root.toLowerCase() === requested.toLowerCase() : root === requested);
        if (!existing) {
          const merged = store.findMergedParent(requested);
          throw new RootError(merged
            ? `該路徑已合併至上層索引：${merged}；請改監看上層根目錄。`
            : "監看只接受已登錄根目錄；新增位置請先 index。");
        }
        targets = [existing];
      } else {
        targets = registered;
      }
      if (!targets.length) { console.error("索引尚未建立；請先執行 docsearch index <root>。"); return 3; }
      let finish!: () => void;
      const stop = new Promise<void>(resolve => {
        finish = () => resolve();
        process.on("SIGINT", finish);
        process.on("SIGTERM", finish);
      });
      try {
        return await runWatch(store, targets, {
          ...(watchDebounce !== undefined ? { debounceMs: watchDebounce } : {}),
          ...(watchRescan !== undefined ? { rescanMs: watchRescan } : {}),
          verbose, onProgress: update => reporter?.update(update),
        }, {
          write: text => console.log(text),
          waitForStop: () => stop,
        });
      } finally {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
      }
    }
    if (command === "index" || command === "rebuild") {
      if (command === "rebuild" && rootInput) {
        const requested = resolveUserRootPath(rootInput);
        const existing = store.roots().find(root => process.platform === "win32" ? root.toLowerCase() === requested.toLowerCase() : root === requested);
        if (!existing) {
          const merged = store.findMergedParent(requested);
          throw new RootError(merged
            ? `該路徑已合併至上層索引：${merged}；重建請指定有效根目錄，避免隱式擴大範圍。`
            : "重建只接受已登錄根目錄；新增位置請使用 index。");
        }
        rootInput = existing;
      }
      const targets = rootInput ? [rootInput] : store.roots();
      if (!targets.length) { console.error("索引尚未建立；請先執行 docsearch index <root>。"); return 3; }
      const totalDocuments = Object.values(store.counts()).reduce((sum, count) => sum + count, 0);
      const pending = store.textUpgradePending();
      console.log(`既有文件 ${totalDocuments}；有效根目錄 ${store.roots().length}；本次操作：${command === "rebuild" ? "明確重建" : "增量"}。`);
      console.log(`文字解析升級待處理：${pending.total}（${pending.byExtension.map(item => `${item.extension}=${item.count}`).join("、") || "無"}）。此數由已存 metadata 推導，不是磁碟精確剩餘工作量。`);
      let exitCode = 0;
      let lastReport: SyncReport | undefined;
      // search/status 不載入 Office/PDF 解析器，也不掃描來源目錄。
      const { sync } = await import("./sync.js");
      for (const target of targets) {
        try {
          const report = await sync(target, store, { rebuild: command === "rebuild", requireRegistered: !rootInput || command === "rebuild",
            ...(abortController ? { signal: abortController.signal } : {}), onProgress: update => reporter?.update(update),
            ...(profilePath ? { excludePaths: profilePaths(profilePath) } : {}) });
          lastReport = report;
          console.log(`根目錄：${report.root}`);
          for (const notice of report.notices.filter(item => OPERATIONAL_NOTICE.test(item))) {
            console.log(`提示：${notice}`);
          }
          if (command === "rebuild") console.log(report.complete ? "重建完成。" : "重建未完整完成。");
          printSummary(report);
          printDiagnosticAggregates(report.diagnostics, report.statuses.no_text, report.readErrors);
          console.log(`同步完整：${report.complete ? "是" : "否"}（與處理百分比分開；文件解析狀態另列）`);
          if (report.found === 0) console.log("沒有找到文件。");
          if (!report.complete) exitCode = 3;
          if (!report.complete) console.log(command === "rebuild"
            ? "提示：本次重建不完整；部分內容可能尚未更新，請查看 status --issues。"
            : "提示：本次同步不完整；為避免誤刪，保留無法確認的既有索引資料。");
          if (verbose) {
            for (const notice of report.notices.filter(item => !OPERATIONAL_NOTICE.test(item))) {
              console.log(`提示：${notice}`);
            }
            for (const error of report.errors) console.error(`文件問題：${error}`);
            console.log("內建排除：.git/、node_modules/、.localdocsearch/、~$ 暫存項目；不追蹤符號連結／junction。");
            console.log(`排除檔：${report.ignoreFile ?? "未設定"}`);
            for (const rule of report.ignorePatterns) console.log(`  規則：${rule}`);
            for (const issue of report.diagnostics) console.error(`  [${issue.stage}/${issue.code}] ${issue.path}：${issue.message}`);
          }
        } catch (error) {
            if (!(error instanceof RootError || error instanceof IgnoreConfigurationError)) throw error;
            console.error(error.message); exitCode = 3;

        }
      }
      emitProfile(profilePath, exitCode === 0 ? "complete" : "failed", lastReport, store);
      return exitCode;
    }
    const indexStore = store;
    const roots = indexStore.roots();
    if (command === "tui") {
      let stopReason: TuiStopReason = "eof";
      const queued: TuiEvent[] = [];
      let waiter: ((event: TuiEvent) => void) | null = null;
      const push = (event: TuiEvent) => {
        const pending = waiter;
        if (pending) {
          waiter = null;
          pending(event);
        } else {
          queued.push(event);
        }
      };
      const nextEvent = async (): Promise<TuiEvent> => {
        const event = queued.shift();
        if (event) return event;
        return await new Promise<TuiEvent>(resolve => { waiter = resolve; });
      };
      const inputDecoder = new TuiInputDecoder();
      const utf8Decoder = new StringDecoder("utf8");
      let escapeTimer: NodeJS.Timeout | undefined;
      const emitEvents = (events: readonly TuiEvent[]) => {
        for (const event of events) {
          if (event.type === "interrupt") stopReason = "sigint";
          push(event);
        }
      };
      const onData = (chunk: Buffer) => {
        clearTimeout(escapeTimer);
        emitEvents(inputDecoder.push(utf8Decoder.write(chunk)));
        escapeTimer = inputDecoder.pending ? setTimeout(() => emitEvents(inputDecoder.flush()), 80) : undefined;
      };
      const onResize = () => push({ type: "resize" });
      const onEnd = () => {
        clearTimeout(escapeTimer);
        emitEvents(inputDecoder.push(utf8Decoder.end()));
        emitEvents(inputDecoder.flush());
        push({ type: "eof" });
      };
      const onInt = () => { stopReason = "sigint"; push({ type: "interrupt" }); };
      const onTerm = () => { stopReason = "sigterm"; push({ type: "terminate" }); };
      const wasRaw = process.stdin.isRaw;
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
      process.stdout.on("resize", onResize);
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      try {
        return await runTui(store, {
          ansi: true,
          color: process.env.NO_COLOR === undefined,
          colorDepth: process.stdout.getColorDepth(),
          write: text => process.stdout.write(text),
          stopReason: () => stopReason,
          size: () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
          nextEvent,
          ask: async prompt => {
            process.stdout.write(prompt);
            let value = "";
            while (true) {
              const event = await nextEvent();
              if (event.type === "eof" || event.type === "interrupt" || event.type === "terminate") return null;
              if (event.type === "escape") return "\u001b";
              if (event.type === "page-up" || event.type === "page-down") return event.type === "page-down" ? "n" : "p";
              if (event.type === "text") { value += event.text; process.stdout.write(event.text); }
              else if (event.type === "space") { value += " "; process.stdout.write(" "); }
              else if (event.type === "backspace" && value) {
                value = [...value].slice(0, -1).join("");
                process.stdout.write("\b \b");
              } else if (event.type === "enter") {
                process.stdout.write("\n");
                return value;
              }
            }
          },
        });
      } finally {
        clearTimeout(escapeTimer);
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        process.stdout.off("resize", onResize);
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
        if (!wasRaw) process.stdin.pause();
      }
    }
    const registeredRoot = (value: string) => {
      const requested = resolveUserRootPath(value);
      const root = roots.find(item => process.platform === "win32" ? item.toLowerCase() === requested.toLowerCase() : item === requested);
      if (!root) {
        const merged = indexStore.findMergedParent(requested);
        if (merged) throw new RootError(`該路徑已合併至上層索引：${merged}；請對上層根目錄操作 remove。`);
        throw new RootError("該根目錄未登錄；請以 roots 顯示的路徑操作。");
      }
      return root;
    };
    if (command === "roots") {
      if (args[1] === "remove") {
        const root = registeredRoot(args[2]!);
        console.log(`已移除根目錄登錄及 ${store.removeRoot(root)} 份索引，來源文件未變更：${root}`);
      } else {
        console.log(`已登錄根目錄：${roots.length}`);
        for (const root of roots) console.log(root);
      }
      return 0;
    }
    if (!roots.length) {
      console.error("索引尚未建立；請先執行 docsearch index <root>。"); return 3;
    }
    const searchScope = rootFilter ? store.resolveSearchScope(rootFilter) : undefined;
    const selectedRoot = searchScope?.root;
    const selectedSubtree = searchScope?.subtree;
    if (command === "context") {
      await interactiveContext(store, {
        ...(contextOutput ? { output: contextOutput } : {}), ...(contextClipboard ? { clipboard: true } : {}),
        limit, format: contextClipboard && !args.includes("--format") ? "md" : contextFormat, passages: contextPassages,
        ...(allTerms ? { allTerms: true } : {}),
        ...(contextQuery !== undefined ? { query: contextQuery } : {}),
        ...(selectedReferences ? { select: selectedReferences } : {}),
        ...(types ? { types } : {}), ...(selectedRoot ? { root: selectedRoot } : {}),
        ...(selectedSubtree ? { subtree: selectedSubtree } : {}),
      });
      return 0;
    }
    if (command === "open" || command === "reveal") {
      const target = await actOnDocument(store, args[1]!, command, dryRun);
      if (target.changed) console.log("提示：來源已變更，搜尋片段可能過期；建議重新 index。");
      console.log(`${dryRun ? "預覽，未啟動" : "已送出請求"}：${command === "open" ? "開啟文件" : "顯示所在資料夾"} ${target.path}`);
      return 0;
    }
    if (command === "status") {
      const format = store.formatStatus();
      console.log(`索引格式：區段儲存 ${format.chunkStoreVersion ?? "未完成"}${format.legacySearchStructures ? "；舊版段落／payload／搜尋索引仍保留（遷移完成後移除）" : ""}`);
      if (format.needsUpgrade) console.log(`儲存格式升級：需要升級（區段儲存 ${format.chunkStoreCompletedDocuments}/${format.totalDocuments}）；請執行 index 接續，不必刪庫。升級前搜尋使用舊路徑，結果相同但較慢。`);
      else console.log("儲存格式升級：已完成。");
      const pendingText = format.textUpgradeByExtension.map(item => `${item.extension}=${item.count}`).join("、");
      console.log(`文字解析升級待處理：${format.textUpgradePending}（${pendingText || "無"}）。此數由已存 metadata 推導，不是磁碟精確剩餘工作量。`);
      printStorage(store.storageFootprint());
      for (const root of roots) {
        const syncReport = store.getLastSyncReport(root);
        console.log(`根目錄：${root}`);
        console.log(`最後嘗試同步：${syncReport.attemptedAt ?? "尚未同步"}`);
        console.log(`最後完整同步：${syncReport.successfulAt ?? "尚未完成"}`);
        if (syncReport.complete !== null) console.log(`最近同步完整：${syncReport.complete ? "是" : "否"}`);
        if (syncReport.summary) { console.log("最近同步摘要（歷史紀錄，非目前索引累計狀態）："); printSummary(syncReport.summary); }
        console.log(`最近同步診斷：${syncReport.diagnostics.length}（詳見 status --issues）`);
      }
      console.log("目前索引累計狀態：");
      for (const [status, count] of Object.entries(store.counts())) console.log(`${status}：${count}`);
      const issues = store.documentIssues();
      console.log(`目前索引文件問題：${issues.length}（與上方歷史同步摘要分開；詳細請用 status --issues）`);
      if (statusTypes) printExtensionStats(store.extensionStats());
      if (statusIssues) {
        console.log("目前索引文件問題：");
        if (!issues.length) console.log("  （無）");
        for (const issue of issues) console.log(`  ${issue.path} [${issue.status}/${issue.errorCode ?? "UNKNOWN"}]`);
        console.log("各根最近同步診斷：");
        let anyDiagnostic = false;
        for (const root of roots) {
          const syncReport = store.getLastSyncReport(root);
          for (const issue of syncReport.diagnostics) {
            anyDiagnostic = true;
            console.log(`  ${root} [${issue.stage}/${issue.code}] ${issue.path}：${issue.message}`);
          }
        }
        if (!anyDiagnostic) console.log("  （無）");
        console.log("以上兩組可能重疊，請勿相加當成獨立失敗文件數。");
      }
      return 0;
    }
    const session = new SearchSession(store, args[1]!, types, selectedRoot, allTerms ? "all-terms" : "phrase", selectedSubtree,
      "all", undefined, "relevance", exactTotal ? "exact" : "fast");
    const availablePages = Math.max(1, Math.ceil(session.originalTotal / searchPageSize));
    // A lower-bound total (fast mode) may have later pages that are verified on demand (SPEC §52.3).
    if (!limitSpecified && searchPage > availablePages && session.originalTotalRelation === "eq") {
      console.error(`頁碼超出範圍；共有 ${availablePages} 頁。`);
      return 2;
    }
    console.log(`搜尋根目錄：${selectedSubtree ? `${selectedSubtree}（上層 ${selectedRoot}）` : selectedRoot ?? `全部 ${roots.length} 個`}`);
    console.log(`查詢模式：${allTerms ? "全部關鍵字" : "精確片語"}`);
    console.log(`格式範圍：${types?.join(",") ?? "全部已登錄格式"}。`);
    for (const root of selectedRoot ? [selectedRoot] : roots) {
      const syncReport = store.getLastSyncReport(root);
      console.log(`根目錄：${root}；最後完整同步：${syncReport.successfulAt ?? "尚未完成"}（搜尋現有索引）`);
      if (syncReport.complete === false) console.log("提示：最近同步不完整；結果可能包含尚未確認的既有文件。");
    }
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !searchPageSpecified && !limitSpecified);
    if (session.originalTotal === 0) {
      console.log(Object.values(store.counts()).every(count => count === 0)
        ? "索引內沒有支援的文件；請確認根目錄、排除規則與同步狀態。" : "沒有符合的結果。");
      if (verbose) printSearchTrace(session.trace);
      if (!interactive) return 0;
    } else if (limitSpecified) {
      const page = session.page(1, limit);
      console.log(`符合 ${formatTotal(page.total, session.currentTotalRelation)} 份文件；顯示前 ${page.results.length} 份（--limit 單次輸出）。`);
      printSearchResults(page.results, verbose);
      if (verbose) printSearchTrace(session.trace);
      return 0;
    }
    if (!interactive) {
      const page = session.page(searchPage, searchPageSize);
      console.log(`符合 ${formatTotal(page.total, session.currentTotalRelation)} 份文件；第 ${page.page}/${page.pageCount}${session.currentTotalRelation === "gte" ? "+" : ""} 頁，本頁 ${page.start}–${page.end}；回傳 ${page.results.length} 份。`);
      if (session.currentTotalRelation === "gte") console.log("提示：總數為下限；加上 --exact-total 可算出精確總數。");
      printSearchResults(page.results, verbose);
      if (verbose) printSearchTrace(session.trace);
      if (page.page < page.pageCount || session.currentTotalRelation === "gte") console.log(`提示：尚有結果；使用 --page ${page.page + 1} --page-size ${page.pageSize} 查看下一頁。`);
      return 0;
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    let inputClosed = false;
    readline.on("close", () => { inputClosed = true; });
    readline.on("SIGINT", () => readline.close());
    try {
      return await runSearchSession(session, {
        pageSize: searchPageSize,
        renderResults: (results, write) => {
          printSearchResults(results, verbose, write);
          if (verbose) printSearchTrace(session.trace);
        },
      }, {
        write: text => console.log(text),
        writeError: text => console.error(text),
        ask: async prompt => {
          if (inputClosed) return null;
          const abort = new AbortController();
          const stop = () => abort.abort();
          readline.once("close", stop);
          try { return await readline.question(prompt, { signal: abort.signal }); }
          catch { return null; }
          finally { readline.off("close", stop); }
        },
      });
    } finally {
      readline.close();
    }
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      reporter?.update({ stage: "cancelled", message: "操作已取消；已提交進度會保留，這不是同步完整。" });
      const partial = error.partial && typeof error.partial === "object" ? error.partial as SyncReport : undefined;
      emitProfile(profilePath, "cancelled", partial, store);
      console.error(`${error.code}：${error.message}`);
      return 130;
    }
    const sqliteCode = sqliteExtendedCode(error);
    if (sqliteCode === 776) { console.error("INDEX_RECOVERY_REQUIRED：索引有未完成交易，需要由下一次 index 安全回復；請勿刪除 journal 或 WAL。"); return 3; }
    if (sqliteCode !== undefined && ((sqliteCode & 0xff) === 5 || (sqliteCode & 0xff) === 6)) { console.error("INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。"); return 3; }
    if (error instanceof SearchIndexChangedError) { console.error(`SEARCH_INDEX_CHANGED：${error.message}`); return 3; }
    if (error instanceof IndexBusyError || error instanceof ContextError || error instanceof WatchError || error instanceof ClipboardError) { console.error(`${error.code}：${error.message}`); return 3; }
    if (error instanceof DocumentActionError) { console.error(`${error.code}：${error.message}`); return 3; }
    if (error instanceof RootError || error instanceof IgnoreConfigurationError) { console.error(error.message); return 3; }
    console.error("內部錯誤 LDS-001：無法完成操作。");
    if (verbose) console.error(`診斷：${error instanceof Error ? error.name : "UnknownError"}`);
    return 4;
  } finally {
    reporter?.close();
    if (cancel) { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    store?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
