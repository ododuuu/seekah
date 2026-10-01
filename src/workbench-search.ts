import { isRecoveryRequired } from "./index-errors.js";
import { isSqliteBusy } from "./write-lock.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import type {
  WorkbenchSearchWorkerCommand,
  WorkbenchSearchWorkerInput,
  WorkbenchSearchWorkerMessage,
  WorkbenchSearchWorkerResult,
} from "./workbench-search-worker.js";

export const SEARCH_CANCELLED_MESSAGE = "搜尋已取消。";
export const SEARCH_CANCELLED_CODE = "SEARCH_CANCELLED";

export type SearchExecution =
  | { kind: "result"; result: WorkbenchSearchWorkerResult }
  | { kind: "cancelled" };

export const SEARCH_WORKER_MAX = 4;
export const SEARCH_WORKER_IDLE_MS = 120_000;

export interface WorkbenchSearchStats {
  workerCount: number;
  clientCount: number;
  maxWorkers: number;
}

interface SearchJob {
  readonly requestId: string;
  readonly resolve: (value: SearchExecution) => void;
  readonly reject: (reason?: unknown) => void;
  readonly cleanup: () => void;
  settled: boolean;
}

interface SearchWorkerController {
  readonly worker: Worker;
  readonly exit: Promise<number>;
  readonly clientId: string;
  active: SearchJob | undefined;
  stopping: boolean;
}

interface ClientState {
  worker: SearchWorkerController | undefined;
  stopping: Promise<void> | undefined;
  setupTail: Promise<void>;
  lastUsedAt: number;
  lastUsedOrder: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const SEARCH_WORKER_STOP_GRACE_MS = 2_000;

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = deferred<void>();
  const timer = setTimeout(resolve, milliseconds);
  timer.unref();
  return promise;
}

function workerError(message: string): Error {
  return new Error(message);
}

export class WorkbenchSearchManager {
  private readonly clients = new Map<string, ClientState>();
  private readonly workers = new Set<SearchWorkerController>();
  private readonly delayMs: number;
  private readonly idleMs: number;
  private capacityTail: Promise<void> = Promise.resolve();
  private useOrder = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly databasePath: string, delayMs = 0, idleMs = SEARCH_WORKER_IDLE_MS) {
    this.delayMs = Number.isSafeInteger(delayMs) ? Math.max(0, delayMs) : 0;
    this.idleMs = Number.isSafeInteger(idleMs) ? Math.max(1, idleMs) : SEARCH_WORKER_IDLE_MS;
  }

  stats(): WorkbenchSearchStats {
    return {
      workerCount: this.workers.size,
      clientCount: this.clients.size,
      maxWorkers: SEARCH_WORKER_MAX,
    };
  }

  async cancel(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    const release = await this.acquireClientSetup(client);
    try {
      await this.cancelActive(client);
      if (client.stopping) await client.stopping;
    } finally {
      release();
    }
  }

  async run(clientId: string, input: WorkbenchSearchWorkerInput, request: IncomingMessage, response: ServerResponse): Promise<SearchExecution> {
    if (this.closing) throw new Error("搜尋 manager 已關閉。");
    const client: ClientState = this.clients.get(clientId) ?? {
      worker: undefined,
      stopping: undefined,
      setupTail: Promise.resolve(),
      lastUsedAt: 0,
      lastUsedOrder: 0,
      idleTimer: undefined,
    };
    this.clients.set(clientId, client);
    const releaseSetup = await this.acquireClientSetup(client);
    try {
      this.touchClient(client);
      await this.cancelActive(client);
      this.clients.set(clientId, client);
      if (client.stopping) await client.stopping;
      let controller = client.worker;
      if (!controller) {
        await this.ensureCapacity();
        controller = client.worker ?? this.createWorker(clientId, client);
      }
      this.touchClient(client);
      const requestId = randomUUID();
      const { promise, resolve, reject } = deferred<SearchExecution>();
      let job!: SearchJob;
      const onDisconnected = (): void => {
        if (job.settled || response.writableEnded) return;
        void this.cancelJob(client, controller, job);
      };
      const onRequestClose = (): void => {
        if (request.aborted) onDisconnected();
      };
      const onResponseClose = (): void => {
        if (!response.writableEnded) onDisconnected();
      };
      request.once("aborted", onDisconnected);
      request.once("close", onRequestClose);
      response.once("close", onResponseClose);
      job = {
        requestId,
        resolve,
        reject,
        cleanup: () => {
          request.off("aborted", onDisconnected);
          request.off("close", onRequestClose);
          response.off("close", onResponseClose);
        },
        settled: false,
      };
      controller.active = job;
      const command: WorkbenchSearchWorkerCommand = {
        type: "search",
        requestId,
        input: { ...input, ...(this.delayMs > 0 ? { delayMs: this.delayMs } : {}) },
      };
      try {
        controller.worker.postMessage(command);
      } catch (error) {
        this.settleRejected(controller, job, error);
        void this.discardWorker(client, controller);
      }
      return promise;
    } finally {
      releaseSetup();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    this.closing = true;
    this.closePromise = this.closeWorkers();
    await this.closePromise;
  }

  private async closeWorkers(): Promise<void> {
    const pendingSetups = [...this.clients.values()].map(client => client.setupTail);
    await Promise.all(pendingSetups);
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(async client => {
      this.clearIdleTimer(client);
      const controller = client.worker;
      if (!controller) {
        if (client.stopping) await client.stopping;
        return;
      }
      client.worker = undefined;
      if (controller.active) {
        this.settleCancelled(controller, controller.active);
        await this.stopWorker(client, controller);
        return;
      }
      controller.stopping = true;
      try { controller.worker.postMessage({ type: "close" }); } catch { /* worker already stopped */ }
      const exited = await Promise.race([controller.exit.then(() => true), sleep(SEARCH_WORKER_STOP_GRACE_MS).then(() => false)]);
      if (!exited) await controller.worker.terminate();
      this.workers.delete(controller);
    }));
  }

  private async acquireClientSetup(client: ClientState): Promise<() => void> {
    const previous = client.setupTail;
    let release!: () => void;
    client.setupTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }

  private async ensureCapacity(): Promise<void> {
    const previous = this.capacityTail;
    let release!: () => void;
    this.capacityTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      while (this.workers.size >= SEARCH_WORKER_MAX) {
        const candidates = [...this.workers].filter(controller => !controller.stopping);
        if (candidates.length === 0) {
          const stopping = [...this.workers]
            .map(controller => this.clients.get(controller.clientId)?.stopping)
            .filter((promise): promise is Promise<void> => promise !== undefined);
          if (stopping.length > 0) {
            await Promise.race(stopping);
            continue;
          }
        }
        candidates.sort((left, right) =>
          (this.clients.get(left.clientId)?.lastUsedOrder ?? 0) - (this.clients.get(right.clientId)?.lastUsedOrder ?? 0));
        const controller = candidates[0];
        if (!controller) throw new Error("搜尋 worker 容量管理失敗。");
        const client = this.clients.get(controller.clientId);
        if (!client) {
          await controller.exit;
          continue;
        }
        if (controller.active) this.settleCancelled(controller, controller.active);
        if (client.worker === controller) client.worker = undefined;
        this.clearIdleTimer(client);
        await this.stopWorker(client, controller);
      }
    } finally {
      release();
    }
  }

  private createWorker(clientId: string, client: ClientState): SearchWorkerController {
    const execArgv = process.execArgv.filter((argument, index) =>
      argument !== "--input-type" && !argument.startsWith("--input-type=") && process.execArgv[index - 1] !== "--input-type");
    const worker = new Worker(new URL("./workbench-search-worker.js", import.meta.url), {
      workerData: { databasePath: this.databasePath },
      execArgv,
    });
    const { promise: exit, resolve: resolveExit } = deferred<number>();
    const controller: SearchWorkerController = { worker, exit, clientId, active: undefined, stopping: false };
    this.workers.add(controller);
    worker.on("message", message => this.onMessage(client, controller, message as WorkbenchSearchWorkerMessage));
    worker.on("error", error => this.onWorkerError(client, controller, error));
    worker.once("exit", code => {
      resolveExit(code);
      this.onWorkerExit(client, controller, code);
    });
    client.worker = controller;
    return controller;
  }

  private touchClient(client: ClientState): void {
    client.lastUsedAt = Date.now();
    client.lastUsedOrder = ++this.useOrder;
    this.clearIdleTimer(client);
  }

  private clearIdleTimer(client: ClientState): void {
    if (client.idleTimer === undefined) return;
    clearTimeout(client.idleTimer);
    client.idleTimer = undefined;
  }

  private scheduleIdleStop(client: ClientState, controller: SearchWorkerController): void {
    if (client.worker !== controller || controller.active || controller.stopping) return;
    client.lastUsedAt = Date.now();
    client.lastUsedOrder = ++this.useOrder;
    this.clearIdleTimer(client);
    const timer = setTimeout(() => {
      client.idleTimer = undefined;
      if (client.worker !== controller || controller.active || controller.stopping) return;
      const remaining = this.idleMs - (Date.now() - client.lastUsedAt);
      if (remaining > 0) {
        this.scheduleIdleStop(client, controller);
        return;
      }
      client.worker = undefined;
      void this.stopWorker(client, controller).then(() => this.removeClientIfUnused(controller.clientId, client));
    }, this.idleMs);
    timer.unref();
    client.idleTimer = timer;
  }

  private removeClientIfUnused(clientId: string, client: ClientState): void {
    if (client.worker === undefined && client.stopping === undefined && client.idleTimer === undefined &&
      this.clients.get(clientId) === client) {
      this.clients.delete(clientId);
    }
  }

  private onMessage(client: ClientState, controller: SearchWorkerController, message: WorkbenchSearchWorkerMessage): void {
    const job = controller.active;
    if (!job || message.requestId !== job.requestId || job.settled) return;
    if (message.type === "result") this.settleResult(controller, job, message.result);
    else {
      const error = new Error(message.message);
      Object.assign(error, {
        ...(message.code ? { code: message.code } : {}),
        ...(message.errcode === undefined ? {} : { errcode: message.errcode }),
      });
      this.settleRejected(controller, job, error);
      if (isSqliteBusy(error) || isRecoveryRequired(error) || ("code" in error && error.code === "SEARCH_INDEX_CHANGED")) {
        void this.discardWorker(client, controller);
      }
    }
  }

  private onWorkerError(client: ClientState, controller: SearchWorkerController, error: Error): void {
    const job = controller.active;
    if (job && !job.settled) this.settleRejected(controller, job, error);
    this.clearIdleTimer(client);
    if (client.worker === controller) client.worker = undefined;
    void this.stopWorker(client, controller);
  }

  private onWorkerExit(client: ClientState, controller: SearchWorkerController, code: number): void {
    const job = controller.active;
    if (job && !job.settled && !controller.stopping) {
      this.settleRejected(controller, job, workerError(`搜尋工作執行緒結束（${code}）。`));
    }
    this.workers.delete(controller);
    this.clearIdleTimer(client);
    if (client.worker === controller) client.worker = undefined;
    this.removeClientIfUnused(controller.clientId, client);
  }

  private async cancelActive(client: ClientState): Promise<void> {
    if (client.stopping) await client.stopping;
    const controller = client.worker;
    const job = controller?.active;
    if (!controller || !job) return;
    this.settleCancelled(controller, job);
    client.worker = undefined;
    this.clearIdleTimer(client);
    await this.stopWorker(client, controller);
  }

  private async cancelJob(client: ClientState, controller: SearchWorkerController, job: SearchJob): Promise<void> {
    if (job.settled) return;
    this.settleCancelled(controller, job);
    if (client.worker === controller) client.worker = undefined;
    this.clearIdleTimer(client);
    await this.stopWorker(client, controller);
  }

  private async discardWorker(client: ClientState, controller: SearchWorkerController): Promise<void> {
    if (client.worker === controller) client.worker = undefined;
    this.clearIdleTimer(client);
    await this.stopWorker(client, controller);
  }

  private async stopWorker(client: ClientState, controller: SearchWorkerController): Promise<void> {
    if (client.stopping) {
      await client.stopping;
      return;
    }
    controller.stopping = true;
    this.clearIdleTimer(client);
    const stopping = controller.worker.terminate().then(() => undefined, () => undefined);
    client.stopping = stopping;
    try { await stopping; }
    finally {
      this.workers.delete(controller);
      if (client.stopping === stopping) client.stopping = undefined;
      this.removeClientIfUnused(controller.clientId, client);
    }
  }

  private settleResult(controller: SearchWorkerController, job: SearchJob, result: WorkbenchSearchWorkerResult): void {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    if (controller.active === job) controller.active = undefined;
    const client = this.clients.get(controller.clientId);
    if (client) this.scheduleIdleStop(client, controller);
    job.resolve({ kind: "result", result });
  }

  private settleCancelled(controller: SearchWorkerController, job: SearchJob): void {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    if (controller.active === job) controller.active = undefined;
    job.resolve({ kind: "cancelled" });
  }

  private settleRejected(controller: SearchWorkerController, job: SearchJob, error: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    if (controller.active === job) controller.active = undefined;
    const client = this.clients.get(controller.clientId);
    if (client) this.scheduleIdleStop(client, controller);
    job.reject(error);
  }
}

export function searchClientId(request: IncomingMessage): string {
  const value = request.headers["x-localdocsearch-client"];
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value) ? value : "anonymous";
}
