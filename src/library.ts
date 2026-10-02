import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { documentReference } from "./document-reference.js";
import { parseTypes, type SearchField, type SearchMode, type SearchSort } from "./search.js";
import { samePath } from "./root-plan.js";
import { dataDirectory, type IndexStore } from "./store.js";

export const RECENT_LIMIT = 100;
export const PINNED_LIMIT = 100;
export const GROUP_LIMIT = 50;
export const GROUP_ITEM_LIMIT = 200;
export const SAVED_SEARCH_LIMIT = 100;

export type LibraryAction = "open" | "select" | "context" | "mcp";

export interface LibraryDocument {
  path: string;
  reference: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastAction: LibraryAction | null;
}

export interface LibraryGroup {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: LibraryDocument[];
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  root: string | null;
  types: string[];
  sort: SearchSort;
  field: SearchField;
  mode: SearchMode;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryDocumentInput {
  path: string;
  reference: string | null;
  name: string;
}

export interface SavedSearchInput {
  name: string;
  query: string;
  root?: string | null;
  types?: readonly string[];
  sort?: SearchSort;
  field?: SearchField;
  mode?: SearchMode;
}

export interface LibraryStoreOptions {
  now?: () => Date;
}

export class LibraryError extends Error {
  constructor(message: string, public readonly statusCode = 400, public readonly code = "LIBRARY_INVALID") {
    super(message);
    this.name = "LibraryError";
  }
}

export class LibraryNotFoundError extends LibraryError {
  constructor(message = "文件庫項目不存在。") { super(message, 404, "LIBRARY_NOT_FOUND"); }
}

export class LibraryConflictError extends LibraryError {
  constructor(message: string) { super(message, 409, "LIBRARY_CONFLICT"); }
}

export class LibraryUnavailableError extends LibraryError {
  constructor(message = "本機文件庫暫時無法使用。") { super(message, 503, "LIBRARY_UNAVAILABLE"); }
}

type SqlRow = Record<string, unknown>;

function sqlRow(value: unknown): SqlRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibraryUnavailableError("本機文件庫資料格式無效。");
  return value as SqlRow;
}

function optionalSqlRow(value: unknown): SqlRow | undefined {
  return value === undefined ? undefined : sqlRow(value);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new LibraryUnavailableError("本機文件庫資料格式無效。");
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new LibraryUnavailableError("本機文件庫資料格式無效。");
  return value;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new LibraryUnavailableError("本機文件庫資料格式無效。");
  return value;
}

function actionValue(row: SqlRow, key: string): LibraryAction | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (value !== "open" && value !== "select" && value !== "context" && value !== "mcp") {
    throw new LibraryUnavailableError("本機文件庫事件格式無效。");
  }
  return value;
}
function searchSortValue(row: SqlRow, key: string): SearchSort {
  const value = requiredString(row, key);
  if (value !== "relevance" && value !== "filename" && value !== "modified") {
    throw new LibraryUnavailableError("本機文件庫搜尋排序格式無效。");
  }
  return value;
}

function searchFieldValue(row: SqlRow, key: string): SearchField {
  const value = requiredString(row, key);
  if (value !== "all" && value !== "filename" && value !== "content") {
    throw new LibraryUnavailableError("本機文件庫搜尋欄位格式無效。");
  }
  return value;
}

function searchModeValue(row: SqlRow, key: string): SearchMode {
  const value = requiredString(row, key);
  if (value !== "phrase" && value !== "all-terms") {
    throw new LibraryUnavailableError("本機文件庫搜尋模式格式無效。");
  }
  return value;
}


function documentRow(value: unknown): DocumentRow {
  const row = sqlRow(value);
  return {
    path_key: requiredString(row, "path_key"),
    path: requiredString(row, "path"),
    reference: nullableString(row, "reference"),
    name: requiredString(row, "name"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    last_used_at: nullableString(row, "last_used_at"),
    last_action: actionValue(row, "last_action"),
  };
}

function groupRow(value: unknown): GroupRow {
  const row = sqlRow(value);
  return { id: requiredNumber(row, "id"), name: requiredString(row, "name"), created_at: requiredString(row, "created_at"), updated_at: requiredString(row, "updated_at") };
}

function savedSearchRow(value: unknown): SavedSearchRow {
  const row = sqlRow(value);
  return {
    id: requiredNumber(row, "id"),
    name: requiredString(row, "name"),
    query: requiredString(row, "query"),
    root: nullableString(row, "root"),
    types_json: requiredString(row, "types_json"),
    sort: searchSortValue(row, "sort"),
    field: searchFieldValue(row, "field"),
    mode: searchModeValue(row, "mode"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  };
}

function countValue(value: unknown): number {
  const count = requiredNumber(sqlRow(value), "count");
  return count;
}


interface DocumentRow {
  path_key: string;
  path: string;
  reference: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_action: LibraryAction | null;
}

interface GroupRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

interface SavedSearchRow {
  id: number;
  name: string;
  query: string;
  root: string | null;
  types_json: string;
  sort: SearchSort;
  field: SearchField;
  mode: SearchMode;
  created_at: string;
  updated_at: string;
}

function databaseOptions(): ConstructorParameters<typeof DatabaseSync>[1] {
  return { timeout: 1_500 } as ConstructorParameters<typeof DatabaseSync>[1];
}

function pathParts(filePath: string): { path: string; key: string } {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.length > 32_768) {
    throw new LibraryError("文件路徑無效或超過長度上限。", 400, "LIBRARY_PATH_INVALID");
  }
  const resolved = path.resolve(filePath);
  if (!path.isAbsolute(resolved)) throw new LibraryError("文件路徑必須是絕對路徑。", 400, "LIBRARY_PATH_INVALID");
  const key = process.platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved;
  return { path: resolved, key };
}

export function libraryPathKey(filePath: string): string {
  return pathParts(filePath).key;
}

function validReference(reference: string | null): string | null {
  if (reference === null) return null;
  if (typeof reference !== "string" || !/^[1-9]\d*-[0-9a-f]{16}$/u.test(reference)) {
    throw new LibraryError("文件代碼格式無效。", 400, "LIBRARY_REFERENCE_INVALID");
  }
  return reference;
}

function validName(value: string, label: string): string {
  if (typeof value !== "string") throw new LibraryError(`${label}無效。`, 400, "LIBRARY_NAME_INVALID");
  const name = value.normalize("NFKC").trim();
  const length = [...name].length;
  if (!name || length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new LibraryError(`${label}必須是 1～80 個可顯示字元。`, 400, "LIBRARY_NAME_INVALID");
  }
  return name;
}

function validDocumentInput(input: LibraryDocumentInput): { path: string; pathKey: string; reference: string | null; name: string } {
  const normalized = pathParts(input.path);
  return { path: normalized.path, pathKey: normalized.key, reference: validReference(input.reference), name: validName(input.name, "文件名稱") };
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new LibraryError("文件庫時間無效。", 503, "LIBRARY_UNAVAILABLE");
  return value.toISOString();
}

function nameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("und");
}

function asDocument(row: DocumentRow): LibraryDocument {
  return {
    path: row.path,
    reference: row.reference,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    lastAction: row.last_action,
  };
}

function parseTypesInput(types: readonly string[] | undefined): string[] {
  if (types === undefined || types.length === 0) return [];
  if (!Array.isArray(types) || types.length > 50 || types.some(value => typeof value !== "string" || value.length > 254)) {
    throw new LibraryError("檔案類型條件無效。", 400, "LIBRARY_TYPES_INVALID");
  }
  try { return parseTypes(types.join(",")); }
  catch { throw new LibraryError("檔案類型條件無效。", 400, "LIBRARY_TYPES_INVALID"); }
}

function savedSearchInput(input: SavedSearchInput): {
  name: string; query: string; root: string | null; types: string[]; sort: SearchSort; field: SearchField; mode: SearchMode;
} {
  const name = validName(input.name, "已存搜尋名稱");
  if (typeof input.query !== "string" || input.query.length > 1_000) {
    throw new LibraryError("搜尋關鍵字長度無效。", 400, "LIBRARY_QUERY_INVALID");
  }
  const query = input.query.normalize("NFKC").trim();
  let root: string | null = null;
  if (input.root !== undefined && input.root !== null) {
    if (typeof input.root !== "string" || !input.root.trim() || input.root.length > 32_768) {
      throw new LibraryError("搜尋根目錄條件無效。", 400, "LIBRARY_ROOT_INVALID");
    }
    root = path.resolve(input.root.trim());
  }
  const sort = input.sort ?? "relevance";
  const field = input.field ?? "all";
  const mode = input.mode ?? "phrase";
  if (!(["relevance", "filename", "modified"] as const).includes(sort)) throw new LibraryError("搜尋排序條件無效。", 400, "LIBRARY_SORT_INVALID");
  if (!(["all", "filename", "content"] as const).includes(field)) throw new LibraryError("搜尋欄位條件無效。", 400, "LIBRARY_FIELD_INVALID");
  if (!(["phrase", "all-terms"] as const).includes(mode)) throw new LibraryError("搜尋模式條件無效。", 400, "LIBRARY_MODE_INVALID");
  return { name, query, root, types: parseTypesInput(input.types), sort, field, mode };
}

function isCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("not a database") || message.includes("malformed") || message.includes("disk image") || message.includes("integrity");
}

function corruptionPath(filePath: string): string {
  const stamp = new Date().toISOString().replaceAll(/[^0-9]/gu, "").slice(0, 17);
  return `${filePath}.corrupt-${stamp}-${randomUUID().slice(0, 8)}`;
}

function moveAside(filePath: string): string {
  const target = corruptionPath(filePath);
  renameSync(filePath, target);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${filePath}${suffix}`;
    if (existsSync(sidecar)) renameSync(sidecar, `${target}${suffix}`);
  }
  return target;
}

function integrityCheck(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
  if (row?.integrity_check !== "ok") throw new Error(`library integrity check failed: ${String(row?.integrity_check ?? "unknown")}`);
}

export function libraryDatabasePath(databasePath: string): string {
  return path.join(dataDirectory(databasePath), "library.sqlite");
}

export class LibraryStore {
  readonly filePath: string;
  private readonly now: () => Date;
  private db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string, options: LibraryStoreOptions = {}) {
    this.filePath = libraryDatabasePath(databasePath);
    this.now = options.now ?? (() => new Date());
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = this.openWithRecovery();
  }

  private openDatabase(): DatabaseSync {
    const db = new DatabaseSync(this.filePath, databaseOptions());
    try {
    db.exec("PRAGMA busy_timeout = 1500; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    integrityCheck(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recent_files (
        path_key TEXT PRIMARY KEY, path TEXT NOT NULL, reference TEXT, name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT NOT NULL, last_action TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recent_files_order ON recent_files(last_used_at DESC, updated_at DESC);
      CREATE TABLE IF NOT EXISTS pinned_files (
        path_key TEXT PRIMARY KEY, path TEXT NOT NULL, reference TEXT, name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, last_action TEXT
      );
      CREATE TABLE IF NOT EXISTS library_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_files (
        group_id INTEGER NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
        path_key TEXT NOT NULL, path TEXT NOT NULL, reference TEXT, name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (group_id, path_key)
      );
      CREATE TABLE IF NOT EXISTS saved_searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, query TEXT NOT NULL, root TEXT,
        types_json TEXT NOT NULL, sort TEXT NOT NULL, field TEXT NOT NULL, mode TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO library_metadata(key, value) VALUES ('schema_version', '1');
    `);
      return db;
    } catch (error) {
      try { db.close(); } catch { /* 開啟失敗仍須釋放 handle。 */ }
      throw error;
    }
  }

  private openWithRecovery(): DatabaseSync {
    const existed = existsSync(this.filePath);
    let opened: DatabaseSync | undefined;
    try {
      opened = this.openDatabase();
      return opened;
    } catch (error) {
      try { opened?.close(); } catch { /* 開啟失敗仍須釋放 handle。 */ }
      if (!existed || !isCorruption(error)) {
        if (error instanceof LibraryError) throw error;
        throw new LibraryUnavailableError();
      }
      try { moveAside(this.filePath); }
      catch { throw new LibraryUnavailableError("損壞的本機文件庫無法隔離，未覆寫原檔。"); }
      try {
        return this.openDatabase();
      } catch {
        throw new LibraryUnavailableError("本機文件庫無法建立。");
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) throw new LibraryUnavailableError("本機文件庫已關閉。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 交易可能尚未開始。 */ }
      throw error;
    }
  }

  listRecent(): LibraryDocument[] {
    const rows = this.db.prepare(`SELECT path_key, path, reference, name, created_at, updated_at, last_used_at, last_action
      FROM recent_files ORDER BY last_used_at DESC, updated_at DESC, path_key LIMIT ?`).all(RECENT_LIMIT);
    return rows.map(value => asDocument(documentRow(value)));
  }

  recordRecent(input: LibraryDocumentInput & { action: LibraryAction }): LibraryDocument {
    const value = validDocumentInput(input);
    const now = nowIso(this.now);
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO recent_files(path_key, path, reference, name, created_at, updated_at, last_used_at, last_action)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path_key) DO UPDATE SET path=excluded.path, reference=excluded.reference, name=excluded.name,
          updated_at=excluded.updated_at, last_used_at=excluded.last_used_at, last_action=excluded.last_action`)
        .run(value.pathKey, value.path, value.reference, value.name, now, now, now, input.action);
      this.db.prepare(`DELETE FROM recent_files WHERE path_key NOT IN
        (SELECT path_key FROM recent_files ORDER BY last_used_at DESC, updated_at DESC, path_key LIMIT ?)`)
        .run(RECENT_LIMIT);
      const row = this.db.prepare(`SELECT path_key, path, reference, name, created_at, updated_at, last_used_at, last_action
        FROM recent_files WHERE path_key = ?`).get(value.pathKey);
      return asDocument(documentRow(row));
    });
  }

  listPinned(): LibraryDocument[] {
    const rows = this.db.prepare(`SELECT path_key, path, reference, name, created_at, updated_at,
      last_used_at, last_action FROM pinned_files ORDER BY updated_at DESC, path_key`).all();
    return rows.map(value => asDocument(documentRow(value)));
  }

  upsertPinned(input: LibraryDocumentInput): LibraryDocument {
    const value = validDocumentInput(input);
    const now = nowIso(this.now);
    return this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 AS present FROM pinned_files WHERE path_key = ?").get(value.pathKey);
      if (!exists) {
        const count = countValue(this.db.prepare("SELECT count(*) AS count FROM pinned_files").get());
        if (count >= PINNED_LIMIT) throw new LibraryConflictError("已釘選文件已達 100 筆上限。");
      }
      this.db.prepare(`INSERT INTO pinned_files(path_key, path, reference, name, created_at, updated_at, last_used_at, last_action)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(path_key) DO UPDATE SET path=excluded.path, reference=excluded.reference, name=excluded.name, updated_at=excluded.updated_at`)
        .run(value.pathKey, value.path, value.reference, value.name, now, now);
      const row = this.db.prepare(`SELECT path_key, path, reference, name, created_at, updated_at,
        last_used_at, last_action FROM pinned_files WHERE path_key = ?`).get(value.pathKey);
      return asDocument(documentRow(row));
    });
  }

  removePinned(input: { path?: string; reference?: string | null }): boolean {
    const reference = input.reference === undefined ? undefined : validReference(input.reference);
    const key = input.path === undefined ? undefined : pathParts(input.path).key;
    if (!key && !reference) throw new LibraryError("釘選刪除需要 path 或 reference。", 400, "LIBRARY_IDENTITY_INVALID");
    return this.transaction(() => {
      let result;
      if (key) result = this.db.prepare("DELETE FROM pinned_files WHERE path_key = ?").run(key);
      else {
        if (!reference) throw new LibraryError("釘選刪除需要 path 或 reference。", 400, "LIBRARY_IDENTITY_INVALID");
        result = this.db.prepare("DELETE FROM pinned_files WHERE reference = ?").run(reference);
      }
      return Number(result.changes) > 0;
    });
  }

  listGroups(): LibraryGroup[] {
    const groupRows = this.db.prepare("SELECT id, name, created_at, updated_at FROM library_groups ORDER BY name_key, id").all();
    const groups = groupRows.map(groupRow);
    const items = this.db.prepare(`SELECT path_key, path, reference, name, created_at, updated_at,
      NULL AS last_used_at, NULL AS last_action FROM group_files WHERE group_id = ? ORDER BY name COLLATE NOCASE, path_key`);
    return groups.map(group => ({
      id: Number(group.id), name: group.name, createdAt: group.created_at, updatedAt: group.updated_at,
      items: items.all(group.id).map(value => asDocument(documentRow(value))),
    }));
  }

  getGroup(id: number): LibraryGroup {
    if (!Number.isSafeInteger(id) || id < 1) throw new LibraryNotFoundError("分類 id 無效。");
    const groupValue = optionalSqlRow(this.db.prepare("SELECT id, name, created_at, updated_at FROM library_groups WHERE id = ?").get(id));
    if (!groupValue) throw new LibraryNotFoundError("分類不存在。");
    const group = groupRow(groupValue);
    const items = this.db.prepare(`SELECT path_key, path, reference, name, created_at, updated_at,
      NULL AS last_used_at, NULL AS last_action FROM group_files WHERE group_id = ? ORDER BY name COLLATE NOCASE, path_key`).all(id);
    return { id: Number(group.id), name: group.name, createdAt: group.created_at, updatedAt: group.updated_at,
      items: items.map(value => asDocument(documentRow(value))) };
  }

  createGroup(rawName: string): LibraryGroup {
    const name = validName(rawName, "分類名稱");
    const now = nowIso(this.now);
    return this.transaction(() => {
      const count = countValue(this.db.prepare("SELECT count(*) AS count FROM library_groups").get());
      if (count >= GROUP_LIMIT) throw new LibraryConflictError("分類已達 50 個上限。");
      try {
        const result = this.db.prepare(`INSERT INTO library_groups(name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?)`)
          .run(name, nameKey(name), now, now);
        return this.getGroup(Number(result.lastInsertRowid));
      } catch (error) {
        if (String(error).toLowerCase().includes("unique")) throw new LibraryConflictError("分類名稱已存在。");
        throw error;
      }
    });
  }

  renameGroup(id: number, rawName: string): LibraryGroup {
    const name = validName(rawName, "分類名稱");
    const now = nowIso(this.now);
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 AS present FROM library_groups WHERE id = ?").get(id)) throw new LibraryNotFoundError("分類不存在。");
      try {
        this.db.prepare("UPDATE library_groups SET name = ?, name_key = ?, updated_at = ? WHERE id = ?").run(name, nameKey(name), now, id);
      } catch (error) {
        if (String(error).toLowerCase().includes("unique")) throw new LibraryConflictError("分類名稱已存在。");
        throw error;
      }
      return this.getGroup(id);
    });
  }

  deleteGroup(id: number): boolean {
    return this.transaction(() => {
      const result = this.db.prepare("DELETE FROM library_groups WHERE id = ?").run(id);
      if (!Number(result.changes)) throw new LibraryNotFoundError("分類不存在。");
      return true;
    });
  }

  addGroupItem(id: number, input: LibraryDocumentInput): LibraryGroup {
    const value = validDocumentInput(input);
    const now = nowIso(this.now);
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 AS present FROM library_groups WHERE id = ?").get(id)) throw new LibraryNotFoundError("分類不存在。");
      const exists = this.db.prepare("SELECT 1 AS present FROM group_files WHERE group_id = ? AND path_key = ?").get(id, value.pathKey);
      if (!exists) {
        const count = countValue(this.db.prepare("SELECT count(*) AS count FROM group_files WHERE group_id = ?").get(id));
        if (count >= GROUP_ITEM_LIMIT) throw new LibraryConflictError("分類文件已達 200 筆上限。");
      }
      this.db.prepare(`INSERT INTO group_files(group_id, path_key, path, reference, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id, path_key) DO UPDATE SET path=excluded.path, reference=excluded.reference,
          name=excluded.name, updated_at=excluded.updated_at`)
        .run(id, value.pathKey, value.path, value.reference, value.name, now, now);
      return this.getGroup(id);
    });
  }

  removeGroupItem(id: number, input: { path?: string; reference?: string | null }): boolean {
    const reference = input.reference === undefined ? undefined : validReference(input.reference);
    const key = input.path === undefined ? undefined : pathParts(input.path).key;
    if (!key && !reference) throw new LibraryError("分類文件刪除需要 path 或 reference。", 400, "LIBRARY_IDENTITY_INVALID");
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 AS present FROM library_groups WHERE id = ?").get(id)) throw new LibraryNotFoundError("分類不存在。");
      let result;
      if (key) result = this.db.prepare("DELETE FROM group_files WHERE group_id = ? AND path_key = ?").run(id, key);
      else {
        if (!reference) throw new LibraryError("分類文件刪除需要 path 或 reference。", 400, "LIBRARY_IDENTITY_INVALID");
        result = this.db.prepare("DELETE FROM group_files WHERE group_id = ? AND reference = ?").run(id, reference);
      }
      return Number(result.changes) > 0;
    });
  }

  listSavedSearches(): SavedSearch[] {
    const rows = this.db.prepare(`SELECT id, name, query, root, types_json, sort, field, mode, created_at, updated_at
      FROM saved_searches ORDER BY updated_at DESC, id DESC`).all();
    return rows.map(value => this.savedSearch(savedSearchRow(value)));
  }

  getSavedSearch(id: number): SavedSearch {
    if (!Number.isSafeInteger(id) || id < 1) throw new LibraryNotFoundError("已存搜尋 id 無效。");
    const rowValue = optionalSqlRow(this.db.prepare(`SELECT id, name, query, root, types_json, sort, field, mode, created_at, updated_at
      FROM saved_searches WHERE id = ?`).get(id));
    if (!rowValue) throw new LibraryNotFoundError("已存搜尋不存在。");
    return this.savedSearch(savedSearchRow(rowValue));
  }

  private savedSearch(row: SavedSearchRow): SavedSearch {
    let types: string[] = [];
    try {
      const parsed = JSON.parse(row.types_json);
      if (Array.isArray(parsed) && parsed.every(value => typeof value === "string")) types = parsed;
    } catch { /* 損壞條件不應讓整個文件庫無法讀取。 */ }
    return { id: Number(row.id), name: row.name, query: row.query, root: row.root, types, sort: row.sort, field: row.field,
      mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  createSavedSearch(input: SavedSearchInput): SavedSearch {
    const value = savedSearchInput(input);
    const now = nowIso(this.now);
    return this.transaction(() => {
      const count = countValue(this.db.prepare("SELECT count(*) AS count FROM saved_searches").get());
      if (count >= SAVED_SEARCH_LIMIT) throw new LibraryConflictError("已存搜尋已達 100 筆上限。");
      const result = this.db.prepare(`INSERT INTO saved_searches(name, query, root, types_json, sort, field, mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.name, value.query, value.root, JSON.stringify(value.types), value.sort, value.field, value.mode, now, now);
      return this.getSavedSearch(Number(result.lastInsertRowid));
    });
  }

  updateSavedSearch(id: number, input: SavedSearchInput): SavedSearch {
    const value = savedSearchInput(input);
    const now = nowIso(this.now);
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 AS present FROM saved_searches WHERE id = ?").get(id)) throw new LibraryNotFoundError("已存搜尋不存在。");
      this.db.prepare(`UPDATE saved_searches SET name = ?, query = ?, root = ?, types_json = ?, sort = ?, field = ?, mode = ?, updated_at = ? WHERE id = ?`)
        .run(value.name, value.query, value.root, JSON.stringify(value.types), value.sort, value.field, value.mode, now, id);
      return this.getSavedSearch(id);
    });
  }

  deleteSavedSearch(id: number): boolean {
    return this.transaction(() => {
      const result = this.db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
      if (!Number(result.changes)) throw new LibraryNotFoundError("已存搜尋不存在。");
      return true;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function indexedLibraryDocument(store: IndexStore, reference: string, expectedPath?: string): LibraryDocumentInput {
  if (typeof reference !== "string" || !/^[1-9]\d*-[0-9a-f]{16}$/u.test(reference)) {
    throw new LibraryError("文件代碼格式無效。", 400, "LIBRARY_REFERENCE_INVALID");
  }
  const id = Number(reference.slice(0, reference.indexOf("-")));
  const row = store.getDocumentById(id);
  if (!row || documentReference(row.id, row.path) !== reference || !store.ownershipBase(row.id, row.path)) {
    throw new LibraryError("文件代碼已失效，請重新搜尋。", 400, "LIBRARY_REFERENCE_STALE");
  }
  if (expectedPath !== undefined && !samePath(row.path, expectedPath)) {
    throw new LibraryError("文件代碼與路徑不相符。", 400, "LIBRARY_PATH_MISMATCH");
  }
  return { path: path.resolve(row.path), reference, name: row.filename };
}
