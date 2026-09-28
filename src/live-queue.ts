import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  failedScopes: string[];
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
  return {
    root: row.root,
    generation: Number(row.generation),
    reason: row.reason,
    phase: row.phase,
    frontier: parseJsonArray<string>(row.frontier_json, []),
    failedScopes: parseJsonArray<string>(row.failed_scopes_json, []),
    checked: Number(row.checked),
    startedAtMs: Number(row.started_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    scopeAcks: parseJsonArray<ReconcileScopeAck>(row.scope_acks_json, []),
  };
}

function reconcileStateParams(state: ReconcileState): unknown[] {
  return [
    state.generation,
    state.reason,
    state.phase,
    JSON.stringify(state.frontier),
    JSON.stringify(state.failedScopes),
    state.checked,
    state.startedAtMs,
    state.updatedAtMs,
    JSON.stringify(state.scopeAcks),
    state.root,
  ];
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

  markDirtyScope(root: string, reason: string): WorkItem {
    return this.upsert(root, SCOPE_REL, "dirty-scope", reason);
  }

  markDowntimeGap(root: string): WorkItem {
    return this.upsert(root, SCOPE_REL, "downtime-gap", "restart");
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
      this.db.prepare("DELETE FROM work_items WHERE root = ?").run(root);
    });
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
        root, generation, reason, phase: "active", frontier: [root], failedScopes: [],
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
        JSON.stringify(state.failedScopes),
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
        JSON.stringify(state.failedScopes),
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
        JSON.stringify(state.failedScopes),
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

  finishReconcile(root: string, generation: number, complete: boolean, failedScopes: readonly string[]): void {
    this.runWrite("ack", () => {
      const state = this.getReconcile(root);
      if (!state || state.generation !== generation) throw new QueuePersistError("校正世代不存在。");
      state.phase = complete ? "complete" : "failed";
      state.frontier = [];
      state.failedScopes = [...new Set(failedScopes)];
      state.updatedAtMs = this.nowFn();
      this.db.prepare(`
        UPDATE reconcile_state SET
          phase = ?, frontier_json = ?, failed_scopes_json = ?, checked = ?,
          updated_at_ms = ?, scope_acks_json = ?
        WHERE root = ? AND generation = ?
      `).run(
        state.phase,
        JSON.stringify(state.frontier),
        JSON.stringify(state.failedScopes),
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
