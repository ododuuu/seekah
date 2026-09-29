import fs from "node:fs";
import path from "node:path";
import { acquireWriteLock } from "./write-lock.js";
import { loadIgnoreRules, type IgnoreRules } from "./ignore.js";
import { isIndexArtifact, type IndexStore } from "./store.js";
import { applyFileUpdate, type LocalUpdateResult } from "./local-update.js";
import { coversPath } from "./root-plan.js";
import { isWindowsVolumeSystemPath } from "./builtin-paths.js";
import { OperationCancelledError, throwIfAborted } from "./progress.js";
import { LiveWorkQueue, type ReconcileState, type ReconcileSeenKind } from "./live-queue.js";

export const DEFAULT_RECONCILE_BATCH_ENTRIES = 500;
export const DEFAULT_RECONCILE_BATCH_MS = 250;

export interface BackgroundReconcileOptions {
  maxEntries?: number;
  maxMs?: number;
  now?: () => number;
  signal?: AbortSignal;
  applyFileUpdate?: typeof applyFileUpdate;
  acquireLock?: typeof acquireWriteLock;
  sleep?: (ms: number) => Promise<void>;
  reason?: string;
}

export interface BackgroundReconcileResult {
  root: string;
  generation: number;
  started: boolean;
  done: boolean;
  complete: boolean;
  checked: number;
  updated: number;
  unchanged: number;
  removed: number;
  parserCalls: number;
  readFailures: string[];
  deferredChecks: string[];
  frontierCount: number;
  elapsedMs: number;
  pendingAfter: boolean;
}

type IgnoreContext = {
  root: string;
  rules: IgnoreRules;
  extras: { base: string; rules: IgnoreRules }[];
};

function uniquePush(values: string[], value: string): void {
  if (!values.some(existing => existing === value)) values.push(value);
}

function entryKind(entry: fs.Dirent): ReconcileSeenKind {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "ignored";
}

async function loadIgnoreContext(root: string, store: IndexStore): Promise<IgnoreContext> {
  const rules = await loadIgnoreRules(root);
  const extras: { base: string; rules: IgnoreRules }[] = [];
  for (const base of store.ignoreBases(root)) extras.push({ base, rules: await loadIgnoreRules(base) });
  return { root, rules, extras };
}

function shouldSkipEntry(context: IgnoreContext, fullPath: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory() && (entry.name.toLowerCase() === ".git" || entry.name.toLowerCase() === "node_modules"
    || entry.name.toLowerCase() === ".localdocsearch" || isWindowsVolumeSystemPath(fullPath))) return true;
  if (entry.isFile() && entry.name.startsWith("~$")) return true;
  const relative = path.relative(context.root, fullPath);
  if (context.rules.matches(relative, entry.isDirectory())) return true;
  return context.extras.some(item => coversPath(item.base, fullPath) && item.rules.matches(path.relative(item.base, fullPath), entry.isDirectory()));
}

function pendingBelow(queue: LiveWorkQueue, root: string, scope: string, scopeAcks: ReconcileState["scopeAcks"]): boolean {
  const captured = new Set(scopeAcks.map(item => `${item.relPath}\u0000${item.generation}`));
  return queue.list(root).some(item => {
    if (item.kind !== "path") return !captured.has(`${item.relPath}\u0000${item.generation}`);
    const absolute = path.resolve(root, item.relPath);
    return coversPath(scope, absolute) || coversPath(absolute, scope);
  });
}

function resultFrom(
  state: ReconcileState,
  startedAt: number,
  values: { started: boolean; done: boolean; complete: boolean; updated: number; unchanged: number; removed: number; parserCalls: number; pendingAfter: boolean },
  now: () => number,
): BackgroundReconcileResult {
  return {
    root: state.root,
    generation: state.generation,
    started: values.started,
    done: values.done,
    complete: values.complete,
    checked: state.checked,
    updated: values.updated,
    unchanged: values.unchanged,
    removed: values.removed,
    parserCalls: values.parserCalls,
    readFailures: [...state.readFailures],
    deferredChecks: [...state.deferredChecks],
    frontierCount: state.frontier.length,
    elapsedMs: Math.round((now() - startedAt) * 100) / 100,
    pendingAfter: values.pendingAfter,
  };
}

export async function runBackgroundReconcileBatch(
  root: string,
  store: IndexStore,
  queue: LiveWorkQueue,
  options: BackgroundReconcileOptions = {},
): Promise<BackgroundReconcileResult> {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_RECONCILE_BATCH_ENTRIES;
  const maxMs = options.maxMs ?? DEFAULT_RECONCILE_BATCH_MS;
  const startedAt = now();
  const existing = queue.reconcileStatus(root);
  const state = queue.beginReconcile(root, options.reason ?? "daemon");
  const started = !existing || existing.phase !== "active";
  const applyUpdate = options.applyFileUpdate ?? applyFileUpdate;
  const acquire = options.acquireLock ?? acquireWriteLock;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  let parserCalls = 0;
  let processed = 0;
  let release: (() => void) | undefined;
  let context: IgnoreContext;
  try {
    context = await loadIgnoreContext(root, store);
    release = acquire(store.databasePath);
    while (state.frontier.length > 0) {
      throwIfAborted(options.signal);
      const directory = state.frontier[state.frontier.length - 1]!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        uniquePush(state.readFailures, directory);
        state.frontier.pop();
        queue.saveReconcile(state);
        continue;
      }
      let interrupted = false;
      for (const entry of entries) {
        throwIfAborted(options.signal);
        const fullPath = path.join(directory, entry.name);
        if (queue.hasReconcileSeen(root, state.generation, fullPath)) continue;
        const kind = entryKind(entry);
        const skip = shouldSkipEntry(context, fullPath, entry);
        if (skip || kind === "link" || kind === "ignored") {
          state.checked++;
          queue.saveReconcileStep(state, fullPath, skip ? "ignored" : kind);
        } else if (kind === "directory") {
          state.frontier.push(fullPath);
          state.checked++;
          queue.saveReconcileStep(state, fullPath, "directory");
        } else if (kind === "file" && !isIndexArtifact(fullPath, store.databasePath)) {
          let result: LocalUpdateResult;
          try {
            const updateOptions = {
              lockHeld: true,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.now ? { now: options.now } : {}),
              ...(options.sleep ? { sleep: options.sleep } : {}),
            };
            result = await applyUpdate(fullPath, root, store, updateOptions);
          } catch (error) {
            if (error instanceof OperationCancelledError) throw error;
            uniquePush(state.readFailures, fullPath);
            result = { kind: "unstable", path: fullPath, root, updated: 0, added: 0, removed: 0, unchanged: 0,
              parserCalls: 0, complete: false, deferred: false, diagnostics: [], notices: [] };
          }
          state.checked++;
          updated += result.updated;
          unchanged += result.unchanged;
          removed += result.removed;
          parserCalls += result.parserCalls;
          if (!result.complete) {
            const deferred = result.deferred || result.diagnostics.some(item => item.code === "FILE_UNSTABLE");
            uniquePush(deferred ? state.deferredChecks : state.readFailures, fullPath);
          }
          queue.saveReconcileStep(state, fullPath, "file");
        } else {
          state.checked++;
          queue.saveReconcileStep(state, fullPath, "ignored");
        }
        processed++;
        if (processed >= maxEntries || (processed > 0 && now() - startedAt >= maxMs)) {
          interrupted = true;
          break;
        }
      }
      if (interrupted) break;
      state.frontier.pop();
      const readFailureBelow = state.readFailures.some(item => coversPath(directory, item));
      const deferredBelow = state.deferredChecks.some(item => coversPath(directory, item));
      const pending = pendingBelow(queue, root, directory, state.scopeAcks);
      if (!readFailureBelow && !deferredBelow && !pending) {
        const known = new Set(queue.reconcileSeenPaths(root, state.generation));
        const removal = await store.removeMissing(known, root, directory);
        removed += removal.removed;
      } else if (pending && !state.deferredChecks.some(item => coversPath(directory, item))) {
        uniquePush(state.deferredChecks, directory);
      }
      queue.saveReconcile(state);
    }
    if (state.frontier.length > 0) {
      return resultFrom(state, startedAt, { started, done: false, complete: false, updated, unchanged, removed, parserCalls, pendingAfter: true }, now);
    }
    const pendingAfter = queue.reconcilePendingAfter(root, state.scopeAcks);
    if (pendingAfter && !state.deferredChecks.some(item => coversPath(root, item))) {
      uniquePush(state.deferredChecks, root);
    }
    const complete = state.readFailures.length === 0 && state.deferredChecks.length === 0 && !pendingAfter;
    queue.finishReconcile(root, state.generation, complete, state.readFailures, state.deferredChecks);
    return resultFrom(state, startedAt, { started, done: true, complete, updated, unchanged, removed, parserCalls, pendingAfter }, now);
  } finally {
    release?.();
  }
}

