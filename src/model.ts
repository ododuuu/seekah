export const documentStatuses = ["indexed", "no_text", "unsupported", "too_large", "encrypted", "error"] as const;
export type DocumentStatus = typeof documentStatuses[number];

export interface TextBlock {
  ordinal: number;
  heading: string | null;
  content: string;
  locationKind: "section" | "line" | "slide" | "sheet_cell" | "page";
  locationValue: string;
}

export interface DocumentRecord {
  path: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  modifiedAtMs: number;
  status: DocumentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  blocks: TextBlock[];
}

export const supportedExtensions = new Set([
  ".md", ".txt", ".xml", ".java", ".sql", ".js",
  ".docx", ".pptx", ".xlsx", ".xlsm", ".odt", ".rtf", ".csv", ".pdf", ".doc", ".xls",
  ".mht", ".mhtml", ".html", ".htm", ".xhtml", ".adoc", ".msg", ".vsd",
]);

export const TEXT_PARSE_VERSION = 1;
export const textParseExtensions = new Set([".txt", ".md", ".adoc", ".xml", ".java", ".sql", ".js"]);

export function needsTextParseUpgrade(
  previous: { status: DocumentStatus; parse_version?: number | null },
  extension: string,
): boolean {
  if (!textParseExtensions.has(extension)) return false;
  if (previous.status === "too_large") return false;
  return (previous.parse_version ?? 0) < TEXT_PARSE_VERSION;
}

export const reprocessReasons = [
  "rebuild", "added", "source-changed", "error-retry", "text-upgrade", "unsupported-retry", "unchanged",
] as const;
export type ReprocessReason = typeof reprocessReasons[number];

export const reprocessReasonLabels: Record<ReprocessReason, string> = {
  rebuild: "強制重建",
  added: "新增",
  "source-changed": "來源變更",
  "error-retry": "錯誤重試",
  "text-upgrade": "文字解析升級",
  "unsupported-retry": "未支援重試",
  unchanged: "未變更略過",
};

export interface ClassifyDocumentInput {
  rebuild?: boolean;
  previous: { status: DocumentStatus; parse_version?: number | null; size_bytes: number; modified_at_ms: number } | null;
  extension: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

/** 依 SPEC §44.2 由上往下只取一個原因。TEXT_PARSE_VERSION 維持 1。 */
export function classifyReprocess(input: ClassifyDocumentInput): ReprocessReason {
  if (input.rebuild) return "rebuild";
  if (!input.previous) return "added";
  if (input.previous.size_bytes !== input.sizeBytes || input.previous.modified_at_ms !== input.modifiedAtMs) return "source-changed";
  if (input.previous.status === "error") return "error-retry";
  if (needsTextParseUpgrade(input.previous, input.extension)) return "text-upgrade";
  if (input.previous.status === "unsupported" && supportedExtensions.has(input.extension)) return "unsupported-retry";
  return "unchanged";
}

export type ReprocessAction = "skip" | "metadata" | "parse";

export function reprocessAction(reason: ReprocessReason, extension: string): ReprocessAction {
  if (reason === "unchanged") return "skip";
  if (!supportedExtensions.has(extension)) return "metadata";
  return "parse";
}

export function emptyReasonCounts(): Record<ReprocessReason, number> {
  return Object.fromEntries(reprocessReasons.map(reason => [reason, 0])) as Record<ReprocessReason, number>;
}

export interface Diagnostic {
  stage: "scan" | "read" | "parse" | "store";
  path: string;
  code: string;
  message: string;
}

export interface SkippedCounts {
  builtin: number;
  user: number;
  unsupported: number;
  link: number;
  /** 以 RootExclusion 的穩定 rule id 計數；舊摘要可缺少此欄位。 */
  byRule: Record<string, number>;
}

export interface ExclusionCleanupSummary {
  removed: number;
  pending: number;
}

export function emptySkippedCounts(): SkippedCounts {
  return { builtin: 0, user: 0, unsupported: 0, link: 0, byRule: {} };
}

export interface SyncSummary {
  found: number;
  updated: number;
  added: number;
  reprocessed: number;
  unchanged: number;
  removed: number;
  parserCalls: number;
  statuses: Record<DocumentStatus, number>;
  skipped: SkippedCounts;
  readErrors: number;
  elapsedMs: number;
  /** 既有摘要缺少這些欄位時應顯示「未提供」，不可補 0。 */
  checked?: number;
  failedDocuments?: number;
  reasonsAttempted?: Record<ReprocessReason, number>;
  reasonsCommitted?: Record<ReprocessReason, number>;
  protectedByScanFailure?: number;
  /** 背景校正摘要所屬的 queue generation；完整同步摘要不填此欄位。 */
  reconcileGeneration?: number;
  /** 預設排除造成的既有索引清理進度；不是來源檔案刪除進度。 */
  exclusionCleanup?: ExclusionCleanupSummary;
}

export function emptyStatusCounts(): Record<DocumentStatus, number> {
  return Object.fromEntries(documentStatuses.map(status => [status, 0])) as Record<DocumentStatus, number>;
}
