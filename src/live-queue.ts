import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { samePath } from "./root-plan.js";

export const WORK_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_QUEUE_LIMIT = 10_000;
export const SCOPE_REL = ".";

export type WorkKind = "path" | "dirty-scope" | "downtime-gap";
export type QueuePersistOp = "upsert" | "ack";

export class QueuePersistError extends Error {
  readonly code = "QUEUE_PERSIST_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "QueuePersistError";
  }
}

export interface WorkItem {
  root: string;
  relPath: string;
  generation: number;
  kind: WorkKind;
  reason: string | null;
  createdAtMs: number;
}

export interface WorkStateCleanupReport {
  roots: number;
  workItems: number;
  reconcileStates: number;
  reconcileSeen: number;
}

export type ReconcilePhase = "active" | "complete" | "failed";

export interface ReconcileScopeAck {
  relPath: string;
  generation: number;
}

export interface ReconcileState {
  root: string;
  generation: number;
  reason: string;
  phase: ReconcilePhase;
  frontier: string[];
  readFailures: string[];
  deferredChecks: string[];
  checked: number;
  startedAtMs: number;
  updatedAtMs: number;
  scopeAcks: ReconcileScopeAck[];
}

export type ReconcileSeenKind = "file" | "directory" | "ignored" | "link";

function parseJsonArray<T>(value: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function parseFailureScopes(value: string, root: string): { readFailures: string[]; deferredChecks: string[] } {
  const unknown = { readFailures: [], deferredChecks: [root] };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.some(item => typeof item !== "string")) return unknown;
      // 舊版只有一個 failed scope 陣列；保守視為讀取失敗，維持未完成語意。
      return { readFailures: parsed, deferredChecks: [] };
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (!Array.isArray(record.readFailures) || !Array.isArray(record.deferredChecks)) return unknown;
      if (record.readFailures.some(item => typeof item !== "string")
        || record.deferredChecks.some(item => typeof item !== "string")) return unknown;
      return {
        readFailures: record.readFailures,
        deferredChecks: record.deferredChecks,
      };
    }
  } catch {
    // 格式損壞時保守標為延後核對，不能把未確認狀態當成完成。
  }
  return unknown;
}

function failureScopesJson(state: Pick<ReconcileState, "readFailures" | "deferredChecks">): string {
  return JSON.stringify({ readFailures: state.readFailures, deferredChecks: state.deferredChecks });
}

function reconcileStateFromRow(row: {
  root: string;
  generation: number;
  reason: string;
  phase: ReconcilePhase;
  frontier_json: string;
  failed_scopes_json: string;
  checked: number;
  started_at_ms: number;
  updated_at_ms: number;
  scope_acks_json: string;
}): ReconcileState {
  const failures = parseFailureScopes(row.failed_scopes_json, row.root);
  return {
    root: row.root,
    generation: Number(row.generation),
    reason: row.reason,
    phase: row.phase,
    frontier: parseJsonArray<string>(row.frontier_json, []),
    readFailures: failures.readFailures,
    deferredChecks: failures.deferredChecks,
    checked: Number(row.checked),
    startedAtMs: Number(row.started_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    scopeAcks: parseJsonArray<ReconcileScopeAck>(row.scope_acks_json, []),
  };
}

export interface LiveWorkQueueOptions {
  now?: () => number;
  limit?: number;
  persistHook?: (op: QueuePersistOp, phase: "before-commit" | "after-commit") => void;
}

function databaseOptions(): ConstructorParameters<typeof DatabaseSync>[1] {
  return { timeout: 0 } as ConstructorParameters<typeof DatabaseSync>[1];
}

export function workStatePath(indexDatabasePath: string): string {
  return `${path.resolve(indexDatabasePath)}.work.sqlite`;
}

type RootRow = { root: string };

function stateRoots(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT root FROM work_items
    UNION
    SELECT root FROM reconcile_state
    UNION
    SELECT root FROM reconcile_seen
  `).all() as RootRow[]).map(row => row.root);
}

function deleteRootStateRows(db: DatabaseSync, roots: readonly string[]): WorkStateCleanupReport {
  const report: WorkStateCleanupReport = { roots: 0, workItems: 0, reconcileStates: 0, reconcileSeen: 0 };
  report.roots = roots.length;
  const deleteWorkItems = db.prepare("DELETE FROM work_items WHERE root = ?");
  const deleteReconcileStates = db.prepare("DELETE FROM reconcile_state WHERE root = ?");
  const deleteReconcileSeen = db.prepare("DELETE FROM reconcile_seen WHERE root = ?");
  for (const root of roots) {
    report.workItems += Number(deleteWorkItems.run(root).changes);
    report.reconcileStates += Number(deleteReconcileStates.run(root).changes);
    report.reconcileSeen += Number(deleteReconcileSeen.run(root).changes);
  }
  return report;
}

export function purgeWorkStateRoots(indexDatabasePath: string, roots: readonly string[]): WorkStateCleanupReport {
  if (!roots.length || !existsSync(workStatePath(indexDatabasePath))) {
    return { roots: 0, workItems: 0, reconcileStates: 0, reconcileSeen: 0 };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(workStatePath(indexDatabasePath), databaseOptions());
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    const selected = stateRoots(db).filter(row => roots.some(root => samePath(root, row)));
    const report = deleteRootStateRows(db, selected);
    db.exec("COMMIT");
    return report;
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch { /* 交易可能尚未開始 */ }
    if (error instanceof QueuePersistError) throw error;
    throw new QueuePersistError(error instanceof Error ? error.message : "工作狀態庫無法清理。");
  } finally {
    db?.close();
  }
}

export class LiveWorkQueue {
  readonly filePath: string;
  readonly reopened: boolean;
  readonly limit: number;
  private readonly db: DatabaseSync;
  private readonly persistHook?: LiveWorkQueueOptions["persistHook"];
  private readonly nowFn: () => number;

  constructor(indexDatabasePath: string, options: LiveWorkQueueOptions = {}) {
    this.filePath = workStatePath(indexDatabasePath);
    this.reopened = existsSync(this.filePath);
    this.limit = options.limit ?? DEFAULT_QUEUE_LIMIT;
    this.persistHook = options.persistHook;
    this.nowFn = options.now ?? Date.now;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    let opened: DatabaseSync | undefined;
    try {
      opened = new DatabaseSync(this.filePath, databaseOptions());
      this.db = opened;
      this.db.exec("PRAGMA busy_timeout = 0");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.initialize();
    } catch (error) {
      try { opened?.close(); } catch { /* 開啟失敗仍須放掉 handle */ }
      throw new QueuePersistError(error instanceof Error ? error.message : "工作狀態庫無法開啟。");
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * `reason`：`event` 來自檔案事件；`expand` 來自資料夾展開（SPEC §56.1），排在事件之後。
   * 已是 `event` 的待辦不會因展開而降為 `expand`。
   */
  acceptPath(root: string, relPath: string, reason: "event" | "expand" = "event"): WorkItem {
    const parts = relPath.replace(/\\/gu, "/").split("/").filter(Boolean);
    if (!relPath || relPath === SCOPE_REL || parts.includes("..") || parts.includes(".")) {
      throw new QueuePersistError("工作佇列路徑無效。");
    }
    return this.upsert(root, relPath, "path", reason);
  }

  /** 以 path work item 表示根目錄／子目錄的有界 expansion；根目錄用空 rel_path，保留 "." dirty scope。 */
  acceptDirectory(root: string, relPath: string): WorkItem {
    const normalized = relPath === "" || relPath === SCOPE_REL ? "" : relPath;
    const parts = normalized.replace(/\\/gu, "/").split("/").filter(Boolean);
    if (parts.includes("..") || (normalized && parts.includes("."))) {
      throw new QueuePersistError("工作佇列目錄路徑無效。");
    }
    return this.upsert(root, normalized, "path", "expand");
  }

  markDirtyScope(root: string, reason: string): WorkItem {
    return this.upsert(root, SCOPE_REL, "dirty-scope", reason);
  }

  markDowntimeGap(root: string): WorkItem {
    return this.upsert(root, SCOPE_REL, "downtime-gap", "restart");
  }

  hasDowntimeGap(root: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM work_items WHERE root = ? AND kind = 'downtime-gap' LIMIT 1").get(root) as { ok: number } | undefined;
    return Boolean(row);
  }

  skipDowntimeGap(root: string): void {
    this.runWrite("ack", () => {
      this.db.prepare("DELETE FROM work_items WHERE root = ? AND kind = 'downtime-gap'").run(root);
    });
  }


  ack(root: string, relPath: string, generation: number): void {
    this.runWrite("ack", () => {
      this.db.prepare("DELETE FROM work_items WHERE root = ? AND rel_path = ? AND generation <= ?").run(root, relPath, generation);
    });
  }

  ackUpTo(root: string, generation: number): void {
    this.runWrite("ack", () => {
      this.db.prepare("DELETE FROM work_items WHERE root = ? AND generation <= ?").run(root, generation);
    });
  }

  maxGeneration(root: string): number {
    const row = this.db.prepare("SELECT MAX(generation) AS g FROM work_items WHERE root = ?").get(root) as { g: number | null } | undefined;
    return Number(row?.g ?? 0);
  }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number };
    return Number(row.n);
  }

  pendingPathCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE kind = 'path'").get() as { n: number };
    return Number(row.n);
  }

  oldestCreatedAtMs(): number | null {
    const row = this.db.prepare("SELECT MIN(created_at_ms) AS t FROM work_items").get() as { t: number | null } | undefined;
    return row?.t == null ? null : Number(row.t);
  }

  hasScope(root: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM work_items WHERE root = ? AND rel_path = ?").get(root, SCOPE_REL) as { ok: number } | undefined;
    return Boolean(row);
  }

  listPaths(root: string): WorkItem[] {
    return this.list(root).filter(item => item.kind === "path");
  }

  list(root?: string): WorkItem[] {
    const rows = (root === undefined
      ? this.db.prepare("SELECT root, rel_path, generation, kind, reason, created_at_ms FROM work_items ORDER BY created_at_ms, root, rel_path").all()
      : this.db.prepare("SELECT root, rel_path, generation, kind, reason, created_at_ms FROM work_items WHERE root = ? ORDER BY created_at_ms, rel_path").all(root)
    ) as Array<{ root: string; rel_path: string; generation: number; kind: WorkKind; reason: string | null; created_at_ms: number }>;
    return rows.map(row => ({
      root: row.root,
      relPath: row.rel_path,
      generation: row.generation,
      kind: row.kind,
      reason: row.reason,
      createdAtMs: row.created_at_ms,
    }));
  }

  overflowIfNeeded(root: string): boolean {
    if (this.pendingPathCount() <= this.limit) return false;
    this.markDirtyScope(root, "overflow");
    this.runWrite("ack", () => {
      this.db.prepare("DELETE FROM work_items WHERE root = ? AND kind = 'path'").run(root);
    });
    return true;
  }

  isolateRoot(root: string): void {
    this.runWrite("ack", () => {
      deleteRootStateRows(this.db, [root]);
    });
  }

  cleanupOrphanRoots(activeRoots: readonly string[]): WorkStateCleanupReport {
    const orphanRoots = [...new Set(stateRoots(this.db).filter(root => !activeRoots.some(active => samePath(active, root))))];
    if (!orphanRoots.length) return { roots: 0, workItems: 0, reconcileStates: 0, reconcileSeen: 0 };
    let report: WorkStateCleanupReport | undefined;
    this.runWrite("ack", () => {
      report = deleteRootStateRows(this.db, orphanRoots);
    });
    return report!;
  }

  getReconcile(root: string): ReconcileState | undefined {
    const row = this.db.prepare(`
      SELECT root, generation, reason, phase, frontier_json, failed_scopes_json,
             checked, started_at_ms, updated_at_ms, scope_acks_json
      FROM reconcile_state WHERE root = ?
    `).get(root) as {
      root: string;
      generation: number;
      reason: string;
      phase: ReconcilePhase;
      frontier_json: string;
      failed_scopes_json: string;
      checked: number;
      started_at_ms: number;
      updated_at_ms: number;
      scope_acks_json: string;
    } | undefined;
    return row ? reconcileStateFromRow(row) : undefined;
  }

  beginReconcile(root: string, reason: string): ReconcileState {
    let state: ReconcileState | undefined;
    this.runWrite("upsert", () => {
      const existing = this.getReconcile(root);
      if (existing?.phase === "active") {
        state = existing;
        return;
      }
      const generation = (existing?.generation ?? 0) + 1;
      const now = this.nowFn();
      const scopeAcks = this.list(root)
        .filter(item => item.kind !== "path")
        .map(item => ({ relPath: item.relPath, generation: item.generation }));
      state = {
        root, generation, reason, phase: "active", frontier: [root], readFailures: [], deferredChecks: [],
        checked: 0, startedAtMs: now, updatedAtMs: now, scopeAcks,
      };
      this.db.prepare(`
        INSERT INTO reconcile_state(
          root, generation, reason, phase, frontier_json, failed_scopes_json,
          checked, started_at_ms, updated_at_ms, scope_acks_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root) DO UPDATE SET
          generation = excluded.generation,
          reason = excluded.reason,
          phase = excluded.phase,
          frontier_json = excluded.frontier_json,
          failed_scopes_json = excluded.failed_scopes_json,
          checked = excluded.checked,
          started_at_ms = excluded.started_at_ms,
          updated_at_ms = excluded.updated_at_ms,
          scope_acks_json = excluded.scope_acks_json
      `).run(
        root,
        state.generation,
        state.reason,
        state.phase,
        JSON.stringify(state.frontier),
        failureScopesJson(state),
        state.checked,
        state.startedAtMs,
        state.updatedAtMs,
        JSON.stringify(state.scopeAcks),
      );
      this.db.prepare("DELETE FROM reconcile_seen WHERE root = ?").run(root);
    });
    if (!state) throw new QueuePersistError("校正狀態寫入後無法讀回。");
    return state;
  }

  saveReconcile(state: ReconcileState): void {
    state.updatedAtMs = this.nowFn();
    this.runWrite("upsert", () => {
      const result = this.db.prepare(`
        UPDATE reconcile_state SET
          reason = ?, phase = ?, frontier_json = ?, failed_scopes_json = ?,
          checked = ?, started_at_ms = ?, updated_at_ms = ?, scope_acks_json = ?
        WHERE root = ? AND generation = ?
      `).run(
        state.reason,
        state.phase,
        JSON.stringify(state.frontier),
        failureScopesJson(state),
        state.checked,
        state.startedAtMs,
        state.updatedAtMs,
        JSON.stringify(state.scopeAcks),
        state.root,
        state.generation,
      );
      if (Number(result.changes) !== 1) throw new QueuePersistError("校正世代不存在。");
    });
  }

  saveReconcileStep(state: ReconcileState, seenPath: string, kind: ReconcileSeenKind): void {
    state.updatedAtMs = this.nowFn();
    this.runWrite("upsert", () => {
      this.db.prepare(`
        INSERT OR IGNORE INTO reconcile_seen(root, generation, path, kind)
        VALUES (?, ?, ?, ?)
      `).run(state.root, state.generation, seenPath, kind);
      const result = this.db.prepare(`
        UPDATE reconcile_state SET
          reason = ?, phase = ?, frontier_json = ?, failed_scopes_json = ?,
          checked = ?, started_at_ms = ?, updated_at_ms = ?, scope_acks_json = ?
        WHERE root = ? AND generation = ?
      `).run(
        state.reason,
        state.phase,
        JSON.stringify(state.frontier),
        failureScopesJson(state),
        state.checked,
        state.startedAtMs,
        state.updatedAtMs,
        JSON.stringify(state.scopeAcks),
        state.root,
        state.generation,
      );
      if (Number(result.changes) !== 1) throw new QueuePersistError("校正步驟保存失敗。");
    });
  }
  saveReconcileSteps(state: ReconcileState, steps: readonly { seenPath: string; kind: ReconcileSeenKind }[]): void {
    if (steps.length === 0) {
      this.saveReconcile(state);
      return;
    }
    state.updatedAtMs = this.nowFn();
    this.runWrite("upsert", () => {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO reconcile_seen(root, generation, path, kind)
        VALUES (?, ?, ?, ?)
      `);
      for (const s of steps) {
        insert.run(state.root, state.generation, s.seenPath, s.kind);
      }
      const result = this.db.prepare(`
        UPDATE reconcile_state SET
          reason = ?, phase = ?, frontier_json = ?, failed_scopes_json = ?,
          checked = ?, started_at_ms = ?, updated_at_ms = ?, scope_acks_json = ?
        WHERE root = ? AND generation = ?
      `).run(
        state.reason,
        state.phase,
        JSON.stringify(state.frontier),
        failureScopesJson(state),
        state.checked,
        state.startedAtMs,
        state.updatedAtMs,
        JSON.stringify(state.scopeAcks),
        state.root,
        state.generation,
      );
      if (Number(result.changes) !== 1) throw new QueuePersistError("校正批次保存失敗。");
    });
  }
  hasReconcileSeen(root: string, generation: number, seenPath: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 AS found FROM reconcile_seen
      WHERE root = ? AND generation = ? AND path = ?
    `).get(root, generation, seenPath));
  }

  reconcileSeenPaths(root: string, generation: number): string[] {
    return (this.db.prepare(`
      SELECT path FROM reconcile_seen
      WHERE root = ? AND generation = ? AND kind = 'file'
      ORDER BY path
    `).all(root, generation) as { path: string }[]).map(row => row.path);
  }

  finishReconcile(
    root: string,
    generation: number,
    complete: boolean,
    readFailures: readonly string[],
    deferredChecks: readonly string[],
  ): void {
    this.runWrite("ack", () => {
      const state = this.getReconcile(root);
      if (!state || state.generation !== generation) throw new QueuePersistError("校正世代不存在。");
      state.phase = complete ? "complete" : "failed";
      state.frontier = [];
      state.readFailures = [...new Set(readFailures)];
      state.deferredChecks = [...new Set(deferredChecks)];
      state.updatedAtMs = this.nowFn();
      this.db.prepare(`
        UPDATE reconcile_state SET
          phase = ?, frontier_json = ?, failed_scopes_json = ?, checked = ?,
          updated_at_ms = ?, scope_acks_json = ?
        WHERE root = ? AND generation = ?
      `).run(
        state.phase,
        JSON.stringify(state.frontier),
        failureScopesJson(state),
        state.checked,
        state.updatedAtMs,
        JSON.stringify(state.scopeAcks),
        root,
        generation,
      );
      for (const item of state.scopeAcks) {
        this.db.prepare(`
          DELETE FROM work_items
          WHERE root = ? AND rel_path = ? AND generation = ?
        `).run(root, item.relPath, item.generation);
      }
      this.db.prepare("DELETE FROM reconcile_seen WHERE root = ? AND generation = ?").run(root, generation);
    });
  }

  reconcilePendingAfter(root: string, scopeAcks: readonly ReconcileScopeAck[]): boolean {
    const captured = new Set(scopeAcks.map(item => `${item.relPath}\u0000${item.generation}`));
    return this.list(root).some(item => item.kind === "path" || !captured.has(`${item.relPath}\u0000${item.generation}`));
  }

  reconcileStatus(root: string): ReconcileState | undefined {
    return this.getReconcile(root);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (root, rel_path)
      );
      CREATE TABLE IF NOT EXISTS reconcile_state (
        root TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        reason TEXT NOT NULL,
        phase TEXT NOT NULL,
        frontier_json TEXT NOT NULL,
        failed_scopes_json TEXT NOT NULL,
        checked INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        scope_acks_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reconcile_seen (
        root TEXT NOT NULL,
        generation INTEGER NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (root, generation, path)
      );
      CREATE INDEX IF NOT EXISTS reconcile_seen_scope
        ON reconcile_seen(root, generation, kind, path);
    `);
    const version = this.db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version && Number(version.value) !== WORK_STATE_SCHEMA_VERSION) {
      throw new QueuePersistError(`工作狀態庫版本不相容：${version.value}`);
    }
    if (!version) {
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', ?)").run(String(WORK_STATE_SCHEMA_VERSION));
    }
  }

  private upsert(root: string, relPath: string, kind: WorkKind, reason: string): WorkItem {
    let stored: WorkItem | undefined;
    this.runWrite("upsert", () => {
      const existing = this.db.prepare("SELECT generation, created_at_ms FROM work_items WHERE root = ? AND rel_path = ?").get(root, relPath) as { generation: number; created_at_ms: number } | undefined;
      const generation = existing ? existing.generation + 1 : 1;
      const createdAtMs = existing ? existing.created_at_ms : this.nowFn();
      this.db.prepare(`
        INSERT INTO work_items(root, rel_path, generation, kind, reason, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(root, rel_path) DO UPDATE SET
          generation = excluded.generation,
          kind = excluded.kind,
          reason = CASE WHEN excluded.reason = 'expand' AND work_items.reason = 'event' THEN work_items.reason ELSE excluded.reason END
      `).run(root, relPath, generation, kind, reason, createdAtMs);
      stored = { root, relPath, generation, kind, reason, createdAtMs };
    });
    if (!stored) throw new QueuePersistError("工作佇列寫入後無法讀回。");
    return stored;
  }

  private runWrite(op: QueuePersistOp, fn: () => void): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      fn();
      this.persistHook?.(op, "before-commit");
      this.db.exec("COMMIT");
      try { this.persistHook?.(op, "after-commit"); } catch { /* 落盤已完成；after-commit 例外不能當成未寫入 */ }
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 可能尚未開啟交易 */ }
      if (error instanceof QueuePersistError) throw error;
      throw new QueuePersistError(error instanceof Error ? error.message : "工作佇列無法落盤。");
    }
  }
}
