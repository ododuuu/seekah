import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProgressUpdate } from "./progress.js";

export const INDEXING_STATE_SCHEMA = 1;

export type IndexingStateName = "idle" | "running" | "stopping" | "stopped" | "complete" | "failed";

export interface PersistedIndexingReport {
  root: string;
  complete: boolean;
  found: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface PersistedIndexingState {
  schemaVersion: number;
  databasePath: string;
  instanceId: string;
  pid: number;
  state: IndexingStateName;
  message: string;
  roots: string[];
  reports: PersistedIndexingReport[];
  progress: ProgressUpdate | null;
  startedAt: string;
  updatedAt: string;
}

export function indexingStatePath(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), "indexing.json");
}

function mode(destination: string): void {
  try { chmodSync(destination, 0o600); } catch { /* Windows 沒有 POSIX 權限 */ }
}

export function writeIndexingState(state: PersistedIndexingState): void {
  const destination = indexingStatePath(state.databasePath);
  const tmp = `${destination}.tmp`;
  const payload = `${JSON.stringify({
    schemaVersion: INDEXING_STATE_SCHEMA,
    databasePath: path.resolve(state.databasePath),
    instanceId: state.instanceId,
    pid: state.pid,
    state: state.state,
    message: state.message,
    roots: state.roots,
    reports: state.reports,
    progress: state.progress,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  })}\n`;
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  mode(tmp);
  renameSync(tmp, destination);
  mode(destination);
}

function isStateName(value: unknown): value is IndexingStateName {
  return value === "idle" || value === "running" || value === "stopping" || value === "stopped" || value === "complete" || value === "failed";
}

function isProgress(value: unknown): value is ProgressUpdate | null {
  return value === null || (typeof value === "object" && value !== null && typeof (value as { stage?: unknown }).stage === "string"
    && typeof (value as { message?: unknown }).message === "string");
}

export function readIndexingState(databasePath: string): PersistedIndexingState | undefined {
  const destination = indexingStatePath(databasePath);
  if (!existsSync(destination)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(destination, "utf8")) as Partial<PersistedIndexingState>;
    if (parsed.schemaVersion !== INDEXING_STATE_SCHEMA
      || typeof parsed.databasePath !== "string"
      || path.resolve(parsed.databasePath) !== path.resolve(databasePath)
      || typeof parsed.instanceId !== "string" || !parsed.instanceId
      || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0
      || !isStateName(parsed.state)
      || typeof parsed.message !== "string"
      || !Array.isArray(parsed.roots) || parsed.roots.some(root => typeof root !== "string")
      || !Array.isArray(parsed.reports)
      || !isProgress(parsed.progress)
      || typeof parsed.startedAt !== "string" || typeof parsed.updatedAt !== "string") return undefined;
    return parsed as PersistedIndexingState;
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && String((error as NodeJS.ErrnoException).code) === "EPERM");
  }
}
