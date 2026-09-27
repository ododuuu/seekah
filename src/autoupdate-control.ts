import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, renameSync, unlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { canonicalIndexPath } from "./live-lease.js";
import { dataDirectory } from "./store.js";

export const AUTOUPDATE_STATE_SCHEMA = 1;
export const CONTROL_TIMEOUT_MS = 5000;

export type LiveMode = "foreground" | "background";
export type ControlMethod = "ping" | "status" | "stop";
export type LivePhase = "starting" | "idle" | "updating" | "reconciling" | "stopping";
export type RootWatchState = "active" | "degraded" | "offline" | "removed";

export class AutoupdateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 3,
  ) {
    super(message);
    this.name = "AutoupdateError";
  }
}

export interface AutoupdateSettings {
  debounceMs: number;
  reconcileMs: number;
}

export interface AutoupdateStateFile {
  schemaVersion: number;
  databasePath: string;
  instanceId: string;
  pid: number;
  token: string;
  endpoint: string;
  startedAt: string;
  settings: AutoupdateSettings;
  mode: LiveMode;
}

export interface LiveReconcileStatus {
  generation: number;
  phase: "active" | "complete" | "failed";
  reason: string;
  checked: number;
  frontierCount: number;
  failedScopes: number;
  startedAt: string;
  updatedAt: string;
}

export interface LiveRootStatus {
  path: string;
  watch: RootWatchState;
  pending: number;
  scopeMode?: "split" | "coarse";
  handles?: number;
  lastError?: string;
  reconcile?: LiveReconcileStatus;
}

export interface LiveStatus {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  mode: LiveMode;
  startedAt: string;
  lastHeartbeatAt: string;
  phase: LivePhase;
  settings: AutoupdateSettings;
  ready: boolean;
  roots: LiveRootStatus[];
  pendingCount: number;
  eventCount: number;
  localUpdateCount: number;
  rootScanCount: number;
  subtreeScanCount: number;
  queuePendingCount: number;
  queueDegraded: boolean;
  oldestQueuedAt?: string;
  lastEvent?: { at: string; root: string };
  lastLocalUpdate?: { at: string; root: string; path: string };
  lastReconcile?: { at: string; root: string; complete: boolean };
  nextReconcileAt?: string;
  recentErrors: string[];
  logError?: "AUTOUPDATE_LOG_ERROR";
}

export interface ControlRequest {
  id: string;
  token: string;
  method: ControlMethod;
}

export interface ControlResponse {
  id: string;
  ok: boolean;
  error?: { code: string; message: string };
  result?: unknown;
}

export function instanceHash(canonicalDatabasePath: string): string {
  return createHash("sha256").update(canonicalDatabasePath).digest("hex").slice(0, 16);
}

export function controlEndpoint(databasePath: string): string {
  const canonical = canonicalIndexPath(databasePath);
  const hash = instanceHash(canonical);
  if (process.platform === "win32") return `\\\\.\\pipe\\LocalDocSearch-${hash}`;
  return path.join(os.tmpdir(), `localdocsearch-autoupdate-${hash}.sock`);
}

export function stateFilePath(databasePath: string): string {
  return path.join(dataDirectory(databasePath), "autoupdate.json");
}

export function createInstanceToken(): string {
  return randomBytes(32).toString("hex");
}

export function createInstanceId(): string {
  return randomUUID();
}

export function writeStateFile(state: AutoupdateStateFile): void {
  const destination = stateFilePath(state.databasePath);
  const tmp = `${destination}.tmp`;
  const payload = `${JSON.stringify({
    schemaVersion: state.schemaVersion,
    databasePath: state.databasePath,
    instanceId: state.instanceId,
    pid: state.pid,
    token: state.token,
    endpoint: state.endpoint,
    startedAt: state.startedAt,
    settings: state.settings,
    mode: state.mode,
  })}\n`;
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows 無 POSIX 權限 */ }
  renameSync(tmp, destination);
  try { chmodSync(destination, 0o600); } catch { /* Windows 無 POSIX 權限 */ }
}

export function readStateFile(databasePath: string): AutoupdateStateFile | undefined {
  const destination = stateFilePath(databasePath);
  if (!existsSync(destination)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(destination, "utf8")) as AutoupdateStateFile;
    if (parsed.schemaVersion !== AUTOUPDATE_STATE_SCHEMA) return undefined;
    if (!parsed.token || !parsed.endpoint || !parsed.instanceId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function removeStateFile(databasePath: string): void {
  const destination = stateFilePath(databasePath);
  try { unlinkSync(destination); } catch { /* 沒有狀態檔 */ }
  try { unlinkSync(`${destination}.tmp`); } catch { /* 沒有暫存檔 */ }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
}

export interface ControlServer {
  endpoint: string;
  close(): Promise<void>;
}

export interface ControlServerOptions {
  databasePath: string;
  token: string;
  instanceId: string;
  mode: LiveMode;
  getStatus: () => LiveStatus;
  onStop: () => void;
  allowRemoteStop?: boolean;
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const endpoint = controlEndpoint(options.databasePath);
  if (process.platform !== "win32") {
    try { unlinkSync(endpoint); } catch { /* 殘留 socket */ }
  }
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void reply(socket, line, options);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen(endpoint, () => {
      server.off("error", fail);
      resolve();
    });
  });
  if (process.platform !== "win32") {
    try { chmodSync(endpoint, 0o600); } catch { /* ignore */ }
  }
  return {
    endpoint,
    close: () => new Promise<void>(resolve => {
      server.close(() => {
        if (process.platform !== "win32") {
          try { unlinkSync(endpoint); } catch { /* ignore */ }
        }
        resolve();
      });
    }),
  };
}

async function reply(socket: net.Socket, line: string, options: ControlServerOptions): Promise<void> {
  let request: ControlRequest;
  try {
    request = JSON.parse(line) as ControlRequest;
  } catch {
    writeResponse(socket, { id: "", ok: false, error: { code: "AUTOUPDATE_UNRESPONSIVE", message: "控制請求不是有效 JSON。" } });
    return;
  }
  const id = typeof request.id === "string" ? request.id : "";
  if (request.token !== options.token) {
    writeResponse(socket, { id, ok: false, error: { code: "AUTOUPDATE_UNRESPONSIVE", message: "控制通道驗證失敗。" } });
    return;
  }
  if (request.method === "ping" || request.method === "status") {
    writeResponse(socket, { id, ok: true, result: options.getStatus() });
    return;
  }
  if (request.method === "stop") {
    if (options.allowRemoteStop === false || options.mode === "foreground") {
      writeResponse(socket, {
        id, ok: false,
        error: { code: "AUTOUPDATE_FOREGROUND_ACTIVE", message: "前景監看請在原終端按 Ctrl+C 結束，不能從另一個程序遠端停止。" },
      });
      return;
    }
    writeResponse(socket, { id, ok: true, result: { accepted: true } });
    options.onStop();
    return;
  }
  writeResponse(socket, { id, ok: false, error: { code: "AUTOUPDATE_UNRESPONSIVE", message: `未知控制方法：${String(request.method)}` } });
}

function writeResponse(socket: net.Socket, response: ControlResponse): void {
  try { socket.end(`${JSON.stringify(response)}\n`); }
  catch { try { socket.destroy(); } catch { /* ignore */ } }
}

export async function sendControlRequest(
  endpoint: string,
  token: string,
  method: ControlMethod,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<ControlResponse> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AutoupdateError("AUTOUPDATE_UNRESPONSIVE", "控制通道沒有在時限內回應。"));
    }, timeoutMs);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, token, method } satisfies ControlRequest)}\n`);
    });
    socket.on("data", chunk => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse);
      } catch {
        reject(new AutoupdateError("AUTOUPDATE_UNRESPONSIVE", "控制通道回應不是有效 JSON。"));
      }
      socket.end();
    });
    socket.on("error", error => {
      clearTimeout(timer);
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET") {
        reject(new AutoupdateError("AUTOUPDATE_NOT_RUNNING", "沒有正在執行的自動更新。"));
        return;
      }
      reject(error);
    });
  });
}

export function sameSettings(left: AutoupdateSettings, right: AutoupdateSettings): boolean {
  return left.debounceMs === right.debounceMs && left.reconcileMs === right.reconcileMs;
}
