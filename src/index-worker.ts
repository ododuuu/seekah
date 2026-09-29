import { parentPort, workerData } from "node:worker_threads";
import { IndexStore } from "./store.js";
import { sync, type SyncReport } from "./sync.js";
import { OperationCancelledError, type ProgressUpdate } from "./progress.js";
import { IndexBusyError, isSqliteBusy } from "./write-lock.js";
import { INDEX_BUSY_CLIENT_MESSAGE, INDEX_RECOVERY_REQUIRED_MESSAGE, isRecoveryRequired } from "./index-errors.js";

interface IndexWorkerInput {
  databasePath: string;
  roots: string[];
  root?: string;
  upgradeOnly: boolean;
}

interface IndexWorkerReport {
  root: string;
  complete: boolean;
  found: number;
  updated: number;
  unchanged: number;
  removed: number;
}

type IndexWorkerMessage =
  | { type: "progress"; progress: ProgressUpdate }
  | { type: "complete"; reports: IndexWorkerReport[] }
  | { type: "stopped"; message: string }
  | { type: "error"; message: string; code?: string };

if (!parentPort) throw new Error("索引工作執行緒缺少 parent port。");
const workerPort = parentPort as NonNullable<typeof parentPort>;

const input = workerData as IndexWorkerInput;
const abort = new AbortController();
workerPort.on("message", message => {
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "stop") abort.abort();
});

function post(message: IndexWorkerMessage): void {
  workerPort.postMessage(message);
}

function reportOf(report: SyncReport): IndexWorkerReport {
  return {
    root: report.root,
    complete: report.complete,
    found: report.found,
    updated: report.updated,
    unchanged: report.unchanged,
    removed: report.removed,
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function run(): Promise<void> {
  const store = new IndexStore(input.databasePath);
  try {
    if (input.upgradeOnly) {
      await store.upgrade({
        signal: abort.signal,
        onProgress: progress => post({ type: "progress", progress }),
      });
      post({ type: "complete", reports: [] });
      return;
    }
    const reports: IndexWorkerReport[] = [];
    for (const root of input.roots) {
      const report = await sync(root, store, {
        requireRegistered: input.root === undefined,
        signal: abort.signal,
        onProgress: progress => post({ type: "progress", progress }),
      });
      reports.push(reportOf(report));
    }
    if (reports.every(report => report.complete)) store.purgeTrashRoots(input.roots);
    post({ type: "complete", reports });
  } catch (error) {
    if (error instanceof OperationCancelledError || abort.signal.aborted) {
      post({ type: "stopped", message: "索引同步已停止。" });
    } else if (isRecoveryRequired(error)) {
      post({ type: "error", message: INDEX_RECOVERY_REQUIRED_MESSAGE, code: "INDEX_RECOVERY_REQUIRED" });
    } else {
      const busy = error instanceof IndexBusyError || isSqliteBusy(error);
      const code = busy ? "INDEX_BUSY" : errorCode(error);
      post({
        type: "error",
        message: busy ? INDEX_BUSY_CLIENT_MESSAGE : error instanceof Error ? error.message : "索引無法完成。",
        ...(code ? { code } : {}),
      });
    }
  } finally {
    store.close();
    workerPort.close();
  }
}

void run().catch(error => {
  if (isRecoveryRequired(error)) {
    post({ type: "error", message: INDEX_RECOVERY_REQUIRED_MESSAGE, code: "INDEX_RECOVERY_REQUIRED" });
  } else {
    const busy = error instanceof IndexBusyError || isSqliteBusy(error);
    post({
      type: "error",
      message: busy ? INDEX_BUSY_CLIENT_MESSAGE : error instanceof Error ? error.message : "索引無法完成。",
      ...(busy ? { code: "INDEX_BUSY" } : {}),
    });
  }
  workerPort.close();
});
