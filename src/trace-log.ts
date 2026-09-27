import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AnswerTrace } from "./answer-trace.js";
import type { SearchTrace } from "./search-trace.js";

export const TRACE_LOG_LIMIT = 2 * 1024 * 1024;
export const TRACE_LOG_FILES = 5;
export const TRACE_LOG_NAME = "trace.log";

export type DiagnosticTrace = SearchTrace | AnswerTrace;
export type TraceType = DiagnosticTrace["type"];

export interface TraceLog {
  readonly failed: boolean;
  write(trace: DiagnosticTrace): void;
  rotate(): void;
}

export interface TraceLogFile {
  path: string;
  bytes: number;
  current: boolean;
}

export interface TraceLogSnapshot {
  path: string;
  files: TraceLogFile[];
  traces: DiagnosticTrace[];
  parseErrors: number;
}

export function traceLogPath(dataDir: string, index = 0): string {
  return index === 0 ? path.join(dataDir, TRACE_LOG_NAME) : path.join(dataDir, `${TRACE_LOG_NAME}.${index}`);
}

function isDiagnosticTrace(value: unknown): value is DiagnosticTrace {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DiagnosticTrace>;
  return (item.type === "search" || item.type === "answer")
    && typeof item.schemaVersion === "number"
    && typeof item.startedAt === "string"
    && typeof item.completedAt === "string"
    && typeof item.durationMs === "number"
    && typeof item.bottleneck === "string";
}

function readFileBytes(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

export function createTraceLog(dataDir: string): TraceLog {
  const current = traceLogPath(dataDir);
  let failed = false;
  let size = readFileBytes(current);
  const rotate = () => {
    try {
      mkdirSync(dataDir, { recursive: true });
      const last = traceLogPath(dataDir, TRACE_LOG_FILES - 1);
      try { unlinkSync(last); } catch { /* 沒有最舊檔 */ }
      for (let index = TRACE_LOG_FILES - 2; index >= 1; index--) {
        try { renameSync(traceLogPath(dataDir, index), traceLogPath(dataDir, index + 1)); }
        catch { /* 該輪替檔不存在 */ }
      }
      try { renameSync(current, traceLogPath(dataDir, 1)); }
      catch { /* 目前檔可能尚未建立 */ }
      writeFileSync(current, "", { encoding: "utf8", mode: 0o600 });
      size = 0;
    } catch {
      failed = true;
    }
  };
  return {
    get failed() { return failed; },
    rotate,
    write(trace: DiagnosticTrace) {
      if (failed) return;
      try {
        mkdirSync(dataDir, { recursive: true });
        const payload = `${JSON.stringify(trace)}\n`;
        const bytes = Buffer.byteLength(payload);
        if (size + bytes > TRACE_LOG_LIMIT) rotate();
        if (failed) return;
        appendFileSync(current, payload, { encoding: "utf8", mode: 0o600 });
        size += bytes;
      } catch {
        failed = true;
      }
    },
  };
}

export function readTraceLog(dataDir: string, options: {
  limit?: number;
  type?: TraceType;
  status?: "success" | "error";
} = {}): TraceLogSnapshot {
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const traces: DiagnosticTrace[] = [];
  let parseErrors = 0;
  for (let index = TRACE_LOG_FILES - 1; index >= 0; index--) {
    const filePath = traceLogPath(dataDir, index);
    let content: string;
    try { content = readFileSync(filePath, "utf8"); }
    catch { continue; }
    for (const line of content.split(/\r?\n/u)) {
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isDiagnosticTrace(value)) { parseErrors++; continue; }
        if (options.type && value.type !== options.type) continue;
        if (options.status && value.status !== options.status) continue;
        traces.push(value);
      } catch {
        parseErrors++;
      }
    }
  }
  traces.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  return {
    path: traceLogPath(dataDir),
    files: Array.from({ length: TRACE_LOG_FILES }, (_, index) => {
      const filePath = traceLogPath(dataDir, index);
      return { path: filePath, bytes: readFileBytes(filePath), current: index === 0 };
    }).filter(file => file.bytes > 0),
    traces: traces.slice(0, limit),
    parseErrors,
  };
}
