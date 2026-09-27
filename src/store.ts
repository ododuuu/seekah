import { acquireWriteLock } from "./write-lock.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import {
  documentStatuses, TEXT_PARSE_VERSION, emptyStatusCounts, textParseExtensions,
  type Diagnostic, type SyncSummary, type DocumentRecord, type DocumentStatus, type TextBlock,
} from "./model.js";
import { throwIfAborted, yieldToEvents, type ProgressUpdate } from "./progress.js";
import { coversPath, resolveUserRootPath, samePath } from "./root-plan.js";
import { createTraceLog, type TraceLog } from "./trace-log.js";
import type { SearchTrace, SearchTraceRecorder } from "./search-trace.js";
import { RootError } from "./scanner.js";

export type DataDirSource = "LOCALDOCSEARCH_DATA_DIR" | "LOCALAPPDATA" | "XDG_DATA_HOME" | "home-fallback";
export interface RemovalResult {
  removed: number;
  protected: number;
}
export interface TrashedRoot { path: string; deletedAt: string; documentCount: number }

export function describeDatabaseLocation(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homedir = os.homedir(),
): { path: string; source: DataDirSource; sourceLabel: string } {
  let directory: string;
  let source: DataDirSource;
  if (env.LOCALDOCSEARCH_DATA_DIR) {
    directory = env.LOCALDOCSEARCH_DATA_DIR;
    source = "LOCALDOCSEARCH_DATA_DIR";
  } else if (platform === "win32" && env.LOCALAPPDATA) {
    directory = env.LOCALAPPDATA;
    source = "LOCALAPPDATA";
  } else if (platform !== "win32" && env.XDG_DATA_HOME) {
    directory = env.XDG_DATA_HOME;
    source = "XDG_DATA_HOME";
  } else {
    directory = platform === "win32" ? path.join(homedir, "AppData", "Local") : path.join(homedir, ".local", "share");
    source = "home-fallback";
  }
  const sourceLabel = {
    LOCALDOCSEARCH_DATA_DIR: "環境變數 LOCALDOCSEARCH_DATA_DIR",
    LOCALAPPDATA: "Windows LOCALAPPDATA",
    XDG_DATA_HOME: "XDG_DATA_HOME",
    "home-fallback": "使用者家目錄預設位置",
  }[source];
  return { path: path.join(directory, "LocalDocSearch", "index.db"), source, sourceLabel };
}

export function inspectDatabaseFile(databasePath: string): { exists: boolean; error: string | null } {
  try {
    const info = statSync(databasePath);
    if (info.isDirectory()) return { exists: false, error: "索引路徑是目錄，拒絕建立。" };
    return { exists: true, error: null };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code !== "ENOENT") return { exists: false, error: `無法存取索引（${code || "未知"}），不會把它當成新庫。` };
    try {
      const parent = statSync(path.dirname(databasePath));
      if (!parent.isDirectory()) return { exists: false, error: "索引上層路徑不是目錄，不會建立新庫。" };
      return { exists: false, error: null };
    } catch (parentError) {
      const parentCode = parentError instanceof Error && "code" in parentError ? String((parentError as NodeJS.ErrnoException).code) : "";
      if (parentCode === "ENOENT") return { exists: false, error: null };
      return { exists: false, error: `無法存取索引位置（${parentCode || "未知"}），不會建立新庫。` };
    }
  }
}

export function defaultDatabasePath(): string {
  return describeDatabaseLocation().path;
}

export function dataDirectory(databasePath = defaultDatabasePath()): string {
  return path.dirname(path.resolve(databasePath));
}

export function indexArtifactPaths(databasePath: string): string[] {
  const resolved = path.resolve(databasePath);
  const dir = path.dirname(resolved);
  return [
    resolved,
    `${resolved}-wal`, `${resolved}-shm`, `${resolved}-journal`,
    `${resolved}.writer.sqlite`, `${resolved}.writer.sqlite-wal`, `${resolved}.writer.sqlite-shm`, `${resolved}.writer.sqlite-journal`,
    `${resolved}.live.sqlite`, `${resolved}.live.sqlite-wal`, `${resolved}.live.sqlite-shm`, `${resolved}.live.sqlite-journal`,
    `${resolved}.work.sqlite`, `${resolved}.work.sqlite-wal`, `${resolved}.work.sqlite-shm`, `${resolved}.work.sqlite-journal`,
    path.join(dir, "autoupdate.json"),
    path.join(dir, "autoupdate.json.tmp"),
    path.join(dir, "autoupdate.log"),
    path.join(dir, "autoupdate.log.1"),
    path.join(dir, "autoupdate.log.2"),
    path.join(dir, "autoupdate.log.3"),
    path.join(dir, "autoupdate.log.4"),
    path.join(dir, "indexing.json"),
    path.join(dir, "indexing.json.tmp"),
    path.join(dir, "trace.log"),
    path.join(dir, "trace.log.1"),
    path.join(dir, "trace.log.2"),
    path.join(dir, "trace.log.3"),
    path.join(dir, "trace.log.4"),
  ];
}

export function isIndexArtifact(filePath: string, databasePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (indexArtifactPaths(databasePath).some(item => item === resolved)) return true;
  const base = path.basename(resolved);
  return base.startsWith("autoupdate-") && (base.endsWith(".sock") || base.endsWith(".sock.tmp"));
}

export interface StoredDocumentRow {
  id: number;
  path: string;
  filename: string;
  extension: string;
  size_bytes: number;
  modified_at_ms: number;
  status: DocumentStatus;
  parse_version?: number | null;
}

export interface StoredBlockRow {
  ordinal: number;
  heading: string | null;
  content: string;
  location_kind: TextBlock["locationKind"];
  location_value: string;
}

type StoredBlockDatabaseRow = StoredBlockRow & { id: number };
type SelectedBlockMetadataRow = {
  id: number;
  ordinal: number | null;
  heading: string | null;
  content: string | null;
  location_kind: TextBlock["locationKind"] | null;
  location_value: string | null;
};
const textChunkBytes = 64 * 1024;
const bloomBytes = 1024;
const NGRAM_INDEX_VERSION = "1";
const NGRAM_MIGRATION_VERSION = "ngram_1";
const UNIGRAM_TABLE = "search_unigrams";
const TRIGRAM_TABLE = "search_trigrams";

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function unigramToken(value: string): string {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) throw new Error("無法建立 unigram token。");
  return `u${codePoint.toString(16)}`;
}

function unigramText(value: string): string {
  return [...value].map(unigramToken).join(" ");
}

function trigramValues(value: string): string[] {
  const characters = [...normalizeSearchText(value)];
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= characters.length; index++) grams.add(characters.slice(index, index + 3).join(""));
  return [...grams];
}

function ftsMatch(value: string, useUnigrams: boolean): string {
  const terms = useUnigrams
    ? [...new Set([...normalizeSearchText(value)].map(unigramToken))]
    : trigramValues(value);
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function searchableDocumentText(filename: string, blocks: Iterable<Pick<StoredBlockRow, "heading" | "content">>): string {
  const fields = [filename];
  for (const block of blocks) {
    if (block.heading) fields.push(block.heading);
    fields.push(block.content);
  }
  return fields.join("\n");
}

function bloomHash(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

function buildBloom(blocks: readonly TextBlock[]): Uint8Array {
  const bloom = new Uint8Array(bloomBytes);
  for (const block of blocks) {
    const value = `${block.heading ?? ""}\u0000${block.content}`.normalize("NFKC").toLowerCase();
    for (const width of [2, 3]) {
      for (let index = 0; index + width <= value.length; index++) {
        const gram = value.slice(index, index + width);
        for (const seed of [0x811c9dc5, 0x9e3779b9]) {
          const bit = bloomHash(gram, seed) % (bloomBytes * 8);
          bloom[bit >>> 3]! |= 1 << (bit & 7);
        }
      }
    }
  }
  return bloom;
}

function bloomMayContain(bloom: Uint8Array, term: string, shortTermsReady = true): boolean {
  if (term.length < 2 || (term.length === 2 && !shortTermsReady)) return true;
  const width = term.length === 2 ? 2 : 3;
  for (let index = 0; index + width <= term.length; index++) {
    const gram = term.slice(index, index + width);
    for (const seed of [0x811c9dc5, 0x9e3779b9]) {
      const bit = bloomHash(gram, seed) % (bloomBytes * 8);
      if (!(bloom[bit >>> 3]! & (1 << (bit & 7)))) return false;
    }
  }
  return true;
}

// A payload only has to contain one trigram to be worth reading: the exact
// query can cross a payload boundary, and the complete owning block is still
// verified below.  Requiring every trigram here would incorrectly discard a
// long query split over payloads.
function bloomMayContainAny(bloom: Uint8Array, terms: readonly string[]): boolean {
  return terms.some(term => {
    if (term.length < 3) return true;
    for (let index = 0; index + 2 < term.length; index++) {
      const gram = term.slice(index, index + 3);
      let present = true;
      for (const seed of [0x811c9dc5, 0x9e3779b9]) {
        const bit = bloomHash(gram, seed) % (bloomBytes * 8);
        if (!(bloom[bit >>> 3]! & (1 << (bit & 7)))) { present = false; break; }
      }
      if (present) return true;
    }
    return false;
  });
}

function splitText(value: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + textChunkBytes);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(value.slice(start, end)); start = end;
  }
  return chunks;
}

function compressText(value: string): Uint8Array {
  return brotliCompressSync(Buffer.from(value, "utf8"), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
}

export interface SearchCandidate {
  document: StoredDocumentRow;
  blocks: StoredBlockRow[];
}

export interface StreamingCandidate {
  document: StoredDocumentRow;
  blocks: Iterable<StoredBlockRow>;
  pruned?: boolean;
}

export interface StoredIssue {
  path: string;
  status: DocumentStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface LastSyncReport {
  attemptedAt: string | null;
  successfulAt: string | null;
  complete: boolean | null;
  errors: string[];
  notices: string[];
  summary: SyncSummary | null;
  diagnostics: Diagnostic[];
}

export interface UpsertTimings {
  compressMs: number;
  bloomMs: number;
  deleteMs: number;
  writeMs: number;
  commitMs: number;
}

export interface IndexFormatStatus {
  contentStorageVersion: string | null;
  payloadBloomVersion: string | null;
  ngramIndexVersion: string | null;
  ngramCompletedDocuments: number;
  ngramTablesReady: boolean;
  needsUpgrade: boolean;
  completedDocuments: number;
  totalDocuments: number;
  mappingIndexReady: boolean;
  textUpgradePending: number;
  textUpgradeByExtension: { extension: string; count: number }[];
}

export interface SearchScope {
  root: string;
  subtree?: string;
}

export interface MergeChildRootsOptions {
  beforeCommit?: () => void;
}

export interface UpgradeOptions {
  lockHeld?: boolean;
  signal?: AbortSignal;
  onProgress?: (update: ProgressUpdate) => void;
}

export const INDEX_STORAGE_FILES = [
  { suffix: "", label: "主庫" },
  { suffix: "-wal", label: "主庫 -wal" },
  { suffix: "-shm", label: "主庫 -shm" },
  { suffix: "-journal", label: "主庫 -journal" },
  { suffix: ".writer.sqlite", label: ".writer.sqlite" },
  { suffix: ".writer.sqlite-wal", label: ".writer.sqlite -wal" },
  { suffix: ".writer.sqlite-shm", label: ".writer.sqlite -shm" },
  { suffix: ".writer.sqlite-journal", label: ".writer.sqlite -journal" },
  { suffix: ".live.sqlite", label: ".live.sqlite" },
  { suffix: ".live.sqlite-wal", label: ".live.sqlite -wal" },
  { suffix: ".live.sqlite-shm", label: ".live.sqlite -shm" },
  { suffix: ".live.sqlite-journal", label: ".live.sqlite -journal" },
  { suffix: ".work.sqlite", label: ".work.sqlite" },
  { suffix: ".work.sqlite-wal", label: ".work.sqlite -wal" },
  { suffix: ".work.sqlite-shm", label: ".work.sqlite -shm" },
  { suffix: ".work.sqlite-journal", label: ".work.sqlite -journal" },
] as const;

export interface StorageFileEntry {
  label: string;
  suffix: string;
  path: string;
  bytes: number | null;
  missing: boolean;
  unknown: boolean;
}

export interface StorageFootprint {
  files: StorageFileEntry[];
  totalBytes: number | null;
  incomplete: boolean;
  approximate: boolean;
}

export interface ExtensionStats {
  extension: string;
  documents: number;
  sourceBytes: number;
  statuses: Record<DocumentStatus, number>;
}

export function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function collectIndexStorage(
  databasePath: string,
  statFn: (target: string) => { size: number } = path => statSync(path),
): StorageFootprint {
  const files: StorageFileEntry[] = INDEX_STORAGE_FILES.map(item => {
    const filePath = `${databasePath}${item.suffix}`;
    try {
      const info = statFn(filePath);
      return { label: item.label, suffix: item.suffix, path: filePath, bytes: info.size, missing: false, unknown: false };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code === "ENOENT") return { label: item.label, suffix: item.suffix, path: filePath, bytes: null, missing: true, unknown: false };
      return { label: item.label, suffix: item.suffix, path: filePath, bytes: null, missing: false, unknown: true };
    }
  });
  const present = files.filter(item => !item.missing);
  const incomplete = present.some(item => item.unknown);
  const totalBytes = incomplete ? null : present.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const liveSidecars = new Set(["-wal", "-shm", "-journal", ".writer.sqlite-wal", ".writer.sqlite-shm", ".writer.sqlite-journal", ".live.sqlite-wal", ".live.sqlite-shm", ".live.sqlite-journal", ".work.sqlite-wal", ".work.sqlite-shm", ".work.sqlite-journal"]);
  const approximate = files.some(item => !item.missing && liveSidecars.has(item.suffix));
  return { files, totalBytes, incomplete, approximate };
}


// Node.js 22.16.0 起支援建構時設定 timeout，但目前鎖定的 @types/node
// 尚未宣告此欄位。必須在 sqlite3_open_v2() 後、任何查詢前就安裝
// 零等待 busy handler，不能只依賴稍後執行的 PRAGMA。
function databaseOptions(options: { readOnly?: boolean } = {}): ConstructorParameters<typeof DatabaseSync>[1] {
  return { ...options, timeout: 0 } as ConstructorParameters<typeof DatabaseSync>[1];
}

export interface IndexStoreOptions {
  readOnly?: boolean;
}

export class IndexStore {
  private readonly db: DatabaseSync;
  private readonly readOnly: boolean;
  readonly databasePath: string;
  private documentByPathSql: ReturnType<DatabaseSync["prepare"]> | null = null;
  private documentByIdSql: ReturnType<DatabaseSync["prepare"]> | null = null;
  private parseVersionKnown: boolean | null = null;
  private shortTermsReady = false;
  private latestSearchTrace: SearchTrace | null = null;
  private traceLog: TraceLog | undefined;
  private cachedWrites: {
    upsertDocument: ReturnType<DatabaseSync["prepare"]>;
    bindRoot: ReturnType<DatabaseSync["prepare"]>;
    deleteBlocks: ReturnType<DatabaseSync["prepare"]>;
    deletePayloads: ReturnType<DatabaseSync["prepare"]>;
    deletePayloadBlocks: ReturnType<DatabaseSync["prepare"]>;
    deletePayloadBlooms: ReturnType<DatabaseSync["prepare"]>;
    deleteBloom: ReturnType<DatabaseSync["prepare"]>;
    deleteNgramUnigrams: ReturnType<DatabaseSync["prepare"]>;
    deleteNgramTrigrams: ReturnType<DatabaseSync["prepare"]>;
    deleteNgramMigration: ReturnType<DatabaseSync["prepare"]>;
    insertNgramUnigrams: ReturnType<DatabaseSync["prepare"]>;
    insertNgramTrigrams: ReturnType<DatabaseSync["prepare"]>;
    insertNgramMigration: ReturnType<DatabaseSync["prepare"]>;
    insertBlock: ReturnType<DatabaseSync["prepare"]>;
    lastId: ReturnType<DatabaseSync["prepare"]>;
    insertPayload: ReturnType<DatabaseSync["prepare"]>;
    insertPayloadBlock: ReturnType<DatabaseSync["prepare"]>;
    insertPayloadBloom: ReturnType<DatabaseSync["prepare"]>;
    upsertBloom: ReturnType<DatabaseSync["prepare"]>;
  } | null = null;

  constructor(databasePath = defaultDatabasePath(), options: IndexStoreOptions = {}) {
    this.databasePath = databasePath;
    this.readOnly = options.readOnly ?? false;
    if (this.readOnly) {
      this.db = new DatabaseSync(databasePath, databaseOptions({ readOnly: true }));
      this.db.exec("PRAGMA query_only = ON");
      this.db.exec("PRAGMA busy_timeout = 0");
      this.shortTermsReady = this.metadata("payload_bloom_version") === "2";
      return;
    }
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const fresh = !existsSync(databasePath);
    const release = acquireWriteLock(databasePath);
    try {
      this.db = new DatabaseSync(databasePath, databaseOptions());
      this.db.exec("PRAGMA busy_timeout = 0");
      this.initializeSchema();
      if (fresh) {
        this.db.exec(`INSERT OR REPLACE INTO metadata(key, value) VALUES
          ('content_storage_version', '2'), ('payload_bloom_version', '2'), ('multi_root_version', '1'),
          ('root_merge_version', '1'), ('ngram_index_version', '${NGRAM_INDEX_VERSION}')`);
      }
    } finally { release(); }
    this.shortTermsReady = this.metadata("payload_bloom_version") === "2";
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
        extension TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
        indexed_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
        error_code TEXT, error_message TEXT, parse_version INTEGER
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, heading TEXT, content TEXT NOT NULL,
        location_kind TEXT NOT NULL, location_value TEXT NOT NULL,
        UNIQUE(document_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS blocks_document_id ON blocks(document_id);
      CREATE TABLE IF NOT EXISTS block_payloads (
        block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY(block_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS document_payloads (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY(document_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS document_blooms (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, bloom BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_payload_blocks (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        payload_ordinal INTEGER NOT NULL, block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        PRIMARY KEY(document_id, payload_ordinal, block_id)
      );
      CREATE INDEX IF NOT EXISTS document_payload_blocks_document_block ON document_payload_blocks(document_id, block_id);
      CREATE INDEX IF NOT EXISTS document_payload_blocks_block_id ON document_payload_blocks(block_id);
      CREATE TABLE IF NOT EXISTS document_payload_blooms (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        payload_ordinal INTEGER NOT NULL, bloom BLOB NOT NULL,
        PRIMARY KEY(document_id, payload_ordinal)
      );
      CREATE TABLE IF NOT EXISTS index_migration_documents (
        version TEXT NOT NULL,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        PRIMARY KEY(version, document_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_unigrams USING fts5(
        text, content='', contentless_delete=1, detail=none,
        tokenize='unicode61 remove_diacritics 0'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_trigrams USING fts5(
        text, content='', contentless_delete=1, detail=none,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS roots (path TEXT PRIMARY KEY, report TEXT);
      CREATE TABLE IF NOT EXISTS document_roots (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL REFERENCES roots(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS document_roots_path ON document_roots(root_path);
      CREATE TABLE IF NOT EXISTS root_ignore_scopes (
        root_path TEXT NOT NULL REFERENCES roots(path) ON DELETE CASCADE,
        base_path TEXT NOT NULL,
        PRIMARY KEY (root_path, base_path)
      );
      CREATE TABLE IF NOT EXISTS root_merge_history (
        parent_path TEXT NOT NULL REFERENCES roots(path) ON DELETE CASCADE,
        former_path TEXT NOT NULL,
        merged_at TEXT NOT NULL,
        document_count INTEGER NOT NULL,
        PRIMARY KEY (parent_path, former_path)
      );
      CREATE TABLE IF NOT EXISTS root_trash (
        path TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL,
        document_count INTEGER NOT NULL
      );
    `);
    this.ensureColumn("documents", "parse_version", "INTEGER");
  }

  private ensureColumn(table: string, column: string, sqlType: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(item => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
    }
  }

  formatStatus(): IndexFormatStatus {
    const contentStorageVersion = this.metadata("content_storage_version");
    const payloadBloomVersion = this.metadata("payload_bloom_version");
    const ngramIndexVersion = this.metadata("ngram_index_version");
    const ngramTablesReady = this.hasNgramTables();
    const totalDocuments = this.hasTable("documents")
      ? Number((this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count) : 0;
    const completedDocuments = this.hasTable("index_migration_documents")
      ? Number((this.db.prepare("SELECT count(*) AS count FROM index_migration_documents WHERE version = 'payload_bloom_2'").get() as { count: number }).count) : 0;
    const ngramCompletedDocuments = this.hasTable("index_migration_documents")
      ? Number((this.db.prepare(`SELECT count(*) AS count FROM index_migration_documents WHERE version = ?`).get(NGRAM_MIGRATION_VERSION) as { count: number }).count) : 0;
    const pending = this.textUpgradePending();
    return { contentStorageVersion, payloadBloomVersion, ngramIndexVersion, ngramCompletedDocuments, ngramTablesReady,
      needsUpgrade: contentStorageVersion !== "2" || payloadBloomVersion !== "2" || this.metadata("multi_root_version") !== "1"
        || this.metadata("root_merge_version") !== "1" || ngramIndexVersion !== NGRAM_INDEX_VERSION || !ngramTablesReady,
      completedDocuments, totalDocuments,
      mappingIndexReady: this.mappingIndexReady(),
      textUpgradePending: pending.total,
      textUpgradeByExtension: pending.byExtension };
  }

  ngramIndexReady(): boolean {
    return this.metadata("ngram_index_version") === NGRAM_INDEX_VERSION && this.hasNgramTables();
  }

  private hasNgramTables(): boolean {
    return this.hasTable(UNIGRAM_TABLE) && this.hasTable(TRIGRAM_TABLE);
  }

  async upgrade(options: UpgradeOptions = {}): Promise<void> {
    if (this.readOnly) throw new Error("唯讀索引不能執行升級。");
    const release = options.lockHeld ? undefined : acquireWriteLock(this.databasePath);
    try {
      throwIfAborted(options.signal);
      if (this.metadata("content_storage_version") !== "2") {
        options.onProgress?.({ stage: "upgrade", message: "升級舊索引文字儲存格式" });
        await this.migratePayloads(options);
      }
      if (this.metadata("multi_root_version") !== "1") this.migrateMultiRoot();
      if (this.metadata("root_merge_version") !== "1") this.migrateRootMerge();
      if (this.metadata("payload_bloom_version") !== "2") await this.migratePayloadBlooms(options);
      if (!this.ngramIndexReady()) await this.migrateNgramIndex(options);
    } finally { release?.(); }
  }

  private migrateMultiRoot(): void {
    if (this.metadata("multi_root_version") !== "1") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const oldRoot = this.getRoot();
        if (oldRoot) {
          this.db.prepare("INSERT OR IGNORE INTO roots(path, report) VALUES (?, ?)").run(oldRoot, JSON.stringify(this.getLastSyncReport()));
          this.db.prepare("INSERT OR IGNORE INTO document_roots SELECT id, ? FROM documents").run(oldRoot);
        }
        this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('multi_root_version', '1')").run();
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }

  private migrateRootMerge(): void {
    if (this.metadata("root_merge_version") !== "1") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('root_merge_version', '1')").run();
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  roots(): string[] {
    return (this.db.prepare("SELECT path FROM roots ORDER BY path").all() as { path: string }[]).map(row => row.path);
  }
  trashRoots(): TrashedRoot[] {
    if (!this.hasTable("root_trash")) return [];
    const rows = this.db.prepare("SELECT path, deleted_at AS deletedAt, document_count AS documentCount FROM root_trash ORDER BY deleted_at DESC")
      .all() as unknown as { path: string; deletedAt: string; documentCount: number }[];
    return rows.map(row => ({ path: row.path, deletedAt: row.deletedAt, documentCount: Number(row.documentCount) }));
  }

  deleteConfirmationEnabled(): boolean {
    return this.metadata("ui_delete_confirmation") !== "false";
  }

  setDeleteConfirmationEnabled(enabled: boolean): void {
    if (this.readOnly) throw new Error("唯讀索引不能變更工作台設定。");
    this.db.prepare("INSERT INTO metadata(key, value) VALUES ('ui_delete_confirmation', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(enabled ? "true" : "false");
  }

  moveRootsToTrash(roots: readonly string[]): TrashedRoot[] {
    const release = acquireWriteLock(this.databasePath);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const unique = [...new Set(roots)];
        const now = new Date().toISOString();
        const result: TrashedRoot[] = [];
        const writes = this.writes();
        for (const root of unique) {
          if (!this.roots().includes(root)) throw new RootError("只能刪除目前已登錄的根目錄。");
          const documentCount = this.documentCountForRoot(root);
          this.db.prepare("INSERT OR REPLACE INTO root_trash(path, deleted_at, document_count) VALUES (?, ?, ?)")
            .run(root, now, documentCount);
          const documents = this.db.prepare("SELECT document_id FROM document_roots WHERE root_path = ?").all(root) as { document_id: number }[];
          for (const document of documents) {
            writes.deleteNgramUnigrams.run(document.document_id);
            writes.deleteNgramTrigrams.run(document.document_id);
          }
          this.db.prepare("DELETE FROM documents WHERE id IN (SELECT document_id FROM document_roots WHERE root_path = ?)").run(root);
          this.db.prepare("DELETE FROM root_merge_history WHERE parent_path = ? OR former_path = ?").run(root, root);
          this.db.prepare("DELETE FROM roots WHERE path = ?").run(root);
          result.push({ path: root, deletedAt: now, documentCount });
        }
        if (this.getRoot() && !this.roots().includes(this.getRoot()!)) {
          this.db.prepare("DELETE FROM metadata WHERE key = 'root' OR key LIKE 'last_%'").run();
          const next = this.roots()[0];
          if (next) this.setRoot(next);
        }
        this.db.exec("COMMIT");
        return result;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } finally { release(); }
  }

  purgeTrashRoots(roots: readonly string[]): number {
    if (this.readOnly) throw new Error("唯讀索引不能清空垃圾桶。");
    const unique = [...new Set(roots)];
    if (!unique.length || !this.hasTable("root_trash")) return 0;
    const release = acquireWriteLock(this.databasePath);
    try {
      const statement = this.db.prepare("DELETE FROM root_trash WHERE path = ?");
      let removed = 0;
      for (const root of unique) removed += Number(statement.run(root).changes);
      return removed;
    } finally { release(); }
  }

  registerRoot(root: string): void { this.db.prepare("INSERT OR IGNORE INTO roots(path) VALUES (?)").run(root); }

  documentCountForRoot(root: string): number {
    return Number((this.db.prepare("SELECT count(*) AS count FROM document_roots WHERE root_path = ?").get(root) as { count: number }).count);
  }

  ignoreBases(root: string): string[] {
    return (this.db.prepare("SELECT base_path FROM root_ignore_scopes WHERE root_path = ? ORDER BY base_path")
      .all(root) as { base_path: string }[]).map(row => row.base_path);
  }

  private matchRoot(value: string, roots: readonly string[] = this.roots()): string | undefined {
    return roots.find(item => samePath(item, value));
  }

  findMergedParent(former: string): string | null {
    const registered = this.roots();
    if (this.matchRoot(former, registered)) return null;
    const history = this.db.prepare("SELECT parent_path, former_path FROM root_merge_history")
      .all() as { parent_path: string; former_path: string }[];
    const parentOf = new Map(history.map(row => [row.former_path, row.parent_path]));
    if (process.platform === "win32") {
      for (const row of history) parentOf.set(row.former_path.toLowerCase(), row.parent_path);
    }
    let cursor = former;
    const seen = new Set<string>();
    while (!seen.has(cursor.toLowerCase())) {
      seen.add(cursor.toLowerCase());
      const parent = parentOf.get(cursor) ?? (process.platform === "win32" ? parentOf.get(cursor.toLowerCase()) : undefined);
      if (!parent) break;
      const live = this.matchRoot(parent, registered);
      if (live) return live;
      cursor = parent;
    }
    for (const root of registered) {
      if (this.ignoreBases(root).some(base => samePath(base, former) || coversPath(base, former))) return root;
      if (coversPath(root, former)) return root;
    }
    return null;
  }

  resolveSearchScope(input: string): SearchScope {
    const requested = resolveUserRootPath(input);
    const roots = this.roots();
    const exact = this.matchRoot(requested, roots);
    if (exact) return { root: exact };
    for (const root of roots) {
      const bases = this.ignoreBases(root);
      if (bases.some(base => samePath(base, requested) || coversPath(base, requested))) {
        return samePath(root, requested) ? { root } : { root, subtree: requested };
      }
    }
    const covering = roots.filter(root => coversPath(root, requested));
    if (covering[0]) {
      const root = covering.reduce((best, item) => coversPath(best, item) ? item : best);
      return samePath(root, requested) ? { root } : { root, subtree: requested };
    }
    const merged = this.findMergedParent(requested);
    if (merged) return samePath(merged, requested) ? { root: merged } : { root: merged, subtree: requested };
    throw new RootError("該根目錄未登錄；請以 roots 顯示的路徑操作。");
  }

  ownershipBase(id: number, filePath: string): string | null {
    const root = this.documentRoot(id);
    if (!root) return null;
    if (coversPath(root, filePath)) return root;
    return this.ignoreBases(root).find(base => coversPath(base, filePath)) ?? root;
  }

  mergeChildRoots(parent: string, children: readonly string[], options: MergeChildRootsOptions = {}): { transferred: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO roots(path) VALUES (?)").run(parent);
      let transferred = 0;
      const mergedAt = new Date().toISOString();
      for (const child of children) {
        const count = this.documentCountForRoot(child);
        transferred += count;
        this.db.prepare(`INSERT OR IGNORE INTO root_ignore_scopes(root_path, base_path)
          SELECT ?, base_path FROM root_ignore_scopes WHERE root_path = ?`).run(parent, child);
        this.db.prepare("INSERT OR IGNORE INTO root_ignore_scopes(root_path, base_path) VALUES (?, ?)").run(parent, child);
        this.db.prepare("UPDATE root_merge_history SET parent_path = ? WHERE parent_path = ?").run(parent, child);
        this.db.prepare(`INSERT INTO root_merge_history(parent_path, former_path, merged_at, document_count)
          VALUES (?, ?, ?, ?) ON CONFLICT(parent_path, former_path) DO UPDATE SET merged_at=excluded.merged_at, document_count=excluded.document_count`)
          .run(parent, child, mergedAt, count);
        this.db.prepare("UPDATE document_roots SET root_path = ? WHERE root_path = ?").run(parent, child);
        this.db.prepare("DELETE FROM roots WHERE path = ?").run(child);
      }
      const previous = this.getLastSyncReport(parent);
      this.db.prepare("UPDATE roots SET report = ? WHERE path = ?").run(JSON.stringify({
        attemptedAt: mergedAt, successfulAt: previous.successfulAt, complete: false,
        errors: [], notices: children.map(child => `已合併子根：${child}`), summary: null, diagnostics: [],
      } satisfies LastSyncReport), parent);
      options.beforeCommit?.();
      this.db.exec("COMMIT");
      return { transferred };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  documentRoot(id: number): string | null {
    return (this.db.prepare("SELECT root_path FROM document_roots WHERE document_id = ?").get(id) as { root_path: string } | undefined)?.root_path ?? null;
  }

  removeRoot(root: string): number {
    const release = acquireWriteLock(this.databasePath);
    try { return this.removeRootLocked(root); } finally { release(); }
  }

  private removeRootLocked(root: string): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const writes = this.writes();
      const documents = this.db.prepare("SELECT document_id FROM document_roots WHERE root_path = ?").all(root) as { document_id: number }[];
      for (const document of documents) {
        writes.deleteNgramUnigrams.run(document.document_id);
        writes.deleteNgramTrigrams.run(document.document_id);
      }
      const result = this.db.prepare("DELETE FROM documents WHERE id IN (SELECT document_id FROM document_roots WHERE root_path = ?)").run(root);
      this.db.prepare("DELETE FROM roots WHERE path = ?").run(root);
      if (this.getRoot() === root) {
        this.db.prepare("DELETE FROM metadata WHERE key = 'root' OR key LIKE 'last_%'").run();
        const next = this.roots()[0];
        if (next) this.setRoot(next);
      }
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }

  getRoot(): string | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'root'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setRoot(root: string): void {
    this.db.prepare("INSERT INTO metadata (key, value) VALUES ('root', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(root);
  }

  getDocumentById(id: number): StoredDocumentRow | undefined {
    return this.documentByIdStmt().get(id) as StoredDocumentRow | undefined;
  }

  getDocument(filePath: string): StoredDocumentRow | undefined {
    return this.documentByPathStmt().get(filePath) as StoredDocumentRow | undefined;
  }

  private documentsHaveParseVersion(): boolean {
    if (this.parseVersionKnown === null) {
      if (!this.hasTable("documents")) this.parseVersionKnown = false;
      else {
        const columns = this.db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
        this.parseVersionKnown = columns.some(item => item.name === "parse_version");
      }
    }
    return this.parseVersionKnown;
  }

  private documentByPathStmt(): ReturnType<DatabaseSync["prepare"]> {
    if (!this.documentByPathSql) {
      const parseVersion = this.documentsHaveParseVersion() ? "parse_version" : "NULL AS parse_version";
      this.documentByPathSql = this.db.prepare(`SELECT id, path, filename, extension, size_bytes, modified_at_ms, status, ${parseVersion} FROM documents WHERE path = ?`);
      this.documentByIdSql = this.db.prepare(`SELECT id, path, filename, extension, size_bytes, modified_at_ms, status, ${parseVersion} FROM documents WHERE id = ?`);
    }
    return this.documentByPathSql;
  }

  private documentByIdStmt(): ReturnType<DatabaseSync["prepare"]> {
    this.documentByPathStmt();
    return this.documentByIdSql!;
  }

  mappingIndexReady(): boolean {
    if (!this.hasTable("document_payload_blocks")) return false;
    return Boolean(this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = 'document_payload_blocks_block_id'").get());
  }

  explainBlockLookup(): string {
    const rows = this.db.prepare("EXPLAIN QUERY PLAN SELECT block_id FROM document_payload_blocks WHERE block_id = ?").all(1) as { detail: string }[];
    return rows.map(row => row.detail).join("\n");
  }

  textUpgradePending(): { total: number; byExtension: { extension: string; count: number }[] } {
    if (!this.hasTable("documents")) return { total: 0, byExtension: [] };
    const extensions = [...textParseExtensions];
    const placeholders = extensions.map(() => "?").join(", ");
    const versionClause = this.documentsHaveParseVersion() ? " AND (parse_version IS NULL OR parse_version < ?)" : "";
    const values = this.documentsHaveParseVersion() ? [...extensions, TEXT_PARSE_VERSION] : extensions;
    const rows = this.db.prepare(`SELECT extension, count(*) AS count FROM documents
      WHERE status != 'too_large' AND extension IN (${placeholders})${versionClause}
      GROUP BY extension ORDER BY extension`).all(...values) as { extension: string; count: number }[];
    const byExtension = rows.map(row => ({ extension: row.extension, count: Number(row.count) }));
    return { total: byExtension.reduce((sum, row) => sum + row.count, 0), byExtension };
  }

  contentStats(): { documents: number; blocks: number; payloads: number; mappings: number } {
    const countOf = (table: string) => this.hasTable(table)
      ? Number((this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count) : 0;
    return { documents: countOf("documents"), blocks: countOf("blocks"), payloads: countOf("document_payloads"), mappings: countOf("document_payload_blocks") };
  }

  private writes() {
    if (!this.cachedWrites) {
      this.cachedWrites = {
        upsertDocument: this.db.prepare(`INSERT INTO documents
          (path, filename, extension, size_bytes, modified_at_ms, indexed_at_ms, status, error_code, error_message, parse_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET filename=excluded.filename, extension=excluded.extension,
          size_bytes=excluded.size_bytes, modified_at_ms=excluded.modified_at_ms,
          indexed_at_ms=excluded.indexed_at_ms, status=excluded.status,
          error_code=excluded.error_code, error_message=excluded.error_message,
          parse_version=excluded.parse_version`),
        bindRoot: this.db.prepare("INSERT INTO document_roots(document_id, root_path) VALUES (?, ?) ON CONFLICT(document_id) DO UPDATE SET root_path=excluded.root_path"),
        deleteBlocks: this.db.prepare("DELETE FROM blocks WHERE document_id = ?"),
        deletePayloads: this.db.prepare("DELETE FROM document_payloads WHERE document_id = ?"),
        deletePayloadBlocks: this.db.prepare("DELETE FROM document_payload_blocks WHERE document_id = ?"),
        deletePayloadBlooms: this.db.prepare("DELETE FROM document_payload_blooms WHERE document_id = ?"),
        deleteBloom: this.db.prepare("DELETE FROM document_blooms WHERE document_id = ?"),
        deleteNgramUnigrams: this.db.prepare(`DELETE FROM ${UNIGRAM_TABLE} WHERE rowid = ?`),
        deleteNgramTrigrams: this.db.prepare(`DELETE FROM ${TRIGRAM_TABLE} WHERE rowid = ?`),
        deleteNgramMigration: this.db.prepare("DELETE FROM index_migration_documents WHERE version = ? AND document_id = ?"),
        insertNgramUnigrams: this.db.prepare(`INSERT INTO ${UNIGRAM_TABLE}(rowid, text) VALUES (?, ?)`),
        insertNgramTrigrams: this.db.prepare(`INSERT INTO ${TRIGRAM_TABLE}(rowid, text) VALUES (?, ?)`),
        insertNgramMigration: this.db.prepare("INSERT OR REPLACE INTO index_migration_documents(version, document_id) VALUES (?, ?)"),
        insertBlock: this.db.prepare("INSERT INTO blocks (document_id, ordinal, heading, content, location_kind, location_value) VALUES (?, ?, ?, ?, ?, ?)"),
        lastId: this.db.prepare("SELECT last_insert_rowid() AS id"),
        insertPayload: this.db.prepare("INSERT INTO document_payloads (document_id, ordinal, payload) VALUES (?, ?, ?)"),
        insertPayloadBlock: this.db.prepare("INSERT INTO document_payload_blocks (document_id, payload_ordinal, block_id) VALUES (?, ?, ?)"),
        insertPayloadBloom: this.db.prepare("INSERT INTO document_payload_blooms (document_id, payload_ordinal, bloom) VALUES (?, ?, ?)"),
        upsertBloom: this.db.prepare("INSERT INTO document_blooms(document_id, bloom) VALUES (?, ?) ON CONFLICT(document_id) DO UPDATE SET bloom=excluded.bloom"),
      };
    }
    return this.cachedWrites;
  }
  private replaceNgramDocument(
    documentId: number,
    text: string,
    writes = this.writes(),
  ): void {
    writes.deleteNgramUnigrams.run(documentId);
    writes.deleteNgramTrigrams.run(documentId);
    writes.deleteNgramMigration.run(NGRAM_MIGRATION_VERSION, documentId);
    if (!this.ngramIndexReady()) return;
    const normalized = normalizeSearchText(text);
    writes.insertNgramUnigrams.run(documentId, unigramText(normalized));
    writes.insertNgramTrigrams.run(documentId, normalized);
    writes.insertNgramMigration.run(NGRAM_MIGRATION_VERSION, documentId);
  }


  touchMetadata(document: DocumentRecord, root?: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parseVersion = textParseExtensions.has(document.extension) ? TEXT_PARSE_VERSION : null;
      const writes = this.writes();
      writes.upsertDocument.run(document.path, document.filename, document.extension, document.sizeBytes,
        document.modifiedAtMs, Date.now(), document.status, document.errorCode, document.errorMessage, parseVersion);
      const row = this.getDocument(document.path)!;
      if (root) writes.bindRoot.run(row.id, root);
      this.replaceNgramDocument(row.id, document.filename, writes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsert(document: DocumentRecord, root?: string, timings?: UpsertTimings): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parseVersion = textParseExtensions.has(document.extension) ? TEXT_PARSE_VERSION : null;
      const writes = this.writes();
      const writeStarted = performance.now();
      writes.upsertDocument.run(document.path, document.filename, document.extension, document.sizeBytes,
        document.modifiedAtMs, Date.now(), document.status, document.errorCode, document.errorMessage, parseVersion);
      const row = this.getDocument(document.path)!;
      if (root) writes.bindRoot.run(row.id, root);
      if (timings) timings.writeMs += performance.now() - writeStarted;
      const deleteStarted = performance.now();
      writes.deletePayloadBlocks.run(row.id);
      writes.deletePayloads.run(row.id);
      writes.deletePayloadBlooms.run(row.id);
      writes.deleteBloom.run(row.id);
      writes.deleteBlocks.run(row.id);
      if (timings) timings.deleteMs += performance.now() - deleteStarted;
      const entries: { id: number; ordinal: number; content: string }[] = [];
      for (const block of document.blocks) {
        const insertStarted = performance.now();
        writes.insertBlock.run(row.id, block.ordinal, block.heading, "", block.locationKind, block.locationValue);
        const blockId = (writes.lastId.get() as { id: number }).id;
        if (timings) timings.writeMs += performance.now() - insertStarted;
        entries.push({ id: blockId, ordinal: block.ordinal, content: block.content });
      }
      this.writeDocumentPayloads(row.id, entries, timings);
      const bloomStarted = performance.now();
      const bloom = buildBloom(document.blocks);
      if (timings) timings.bloomMs += performance.now() - bloomStarted;
      const bloomWrite = performance.now();
      writes.upsertBloom.run(row.id, bloom);
      if (timings) timings.writeMs += performance.now() - bloomWrite;
      this.replaceNgramDocument(row.id, searchableDocumentText(document.filename, document.blocks), writes);
      const commitStarted = performance.now();
      this.db.exec("COMMIT");
      if (timings) timings.commitMs += performance.now() - commitStarted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeMissing(
    knownPaths: Set<string>,
    root?: string,
    subtree?: string,
    protectedScopes: readonly string[] = [],
  ): RemovalResult {
    let removed = 0;
    let protectedCount = 0;
    const rows = (root ? this.db.prepare("SELECT id, path FROM documents WHERE id IN (SELECT document_id FROM document_roots WHERE root_path = ?)").all(root) : this.db.prepare("SELECT id, path FROM documents").all()) as { id: number; path: string }[];
    const writes = this.writes();
    const remove = this.db.prepare("DELETE FROM documents WHERE path = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (subtree && !coversPath(subtree, row.path)) continue;
        if (knownPaths.has(row.path)) continue;
        if (protectedScopes.some(scope => coversPath(scope, row.path))) {
          protectedCount++;
          continue;
        }
        writes.deleteNgramUnigrams.run(row.id);
        writes.deleteNgramTrigrams.run(row.id);
        remove.run(row.path);
        removed++;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { removed, protected: protectedCount };
  }

  removeDocument(filePath: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT id FROM documents WHERE path = ?").get(filePath) as { id: number } | undefined;
      if (row) {
        const writes = this.writes();
        writes.deleteNgramUnigrams.run(row.id);
        writes.deleteNgramTrigrams.run(row.id);
      }
      const result = this.db.prepare("DELETE FROM documents WHERE path = ?").run(filePath);
      this.db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearDocuments(root?: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const documents = root
        ? this.db.prepare("SELECT document_id AS id FROM document_roots WHERE root_path = ?").all(root) as { id: number }[]
        : this.db.prepare("SELECT id FROM documents").all() as { id: number }[];
      const writes = this.writes();
      for (const document of documents) {
        writes.deleteNgramUnigrams.run(document.id);
        writes.deleteNgramTrigrams.run(document.id);
      }
      if (root) this.db.prepare("DELETE FROM documents WHERE id IN (SELECT document_id FROM document_roots WHERE root_path = ?)").run(root);
      else this.db.exec("DELETE FROM documents");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** SQLite connection-local marker that changes after another connection commits. */
  dataVersion(): number {
    return (this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  }
  recordSearchTrace(trace: SearchTrace, persist = false): void {
    this.latestSearchTrace = trace;
    if (persist) (this.traceLog ??= createTraceLog(dataDirectory(this.databasePath))).write(trace);
  }

  lastSearchTrace(): SearchTrace | null {
    const trace = this.latestSearchTrace;
    if (!trace) return null;
    return {
      ...trace,
      candidateSources: [...trace.candidateSources],
      phasesMs: { ...trace.phasesMs },
      phaseSelfMs: { ...trace.phaseSelfMs },
      counts: { ...trace.counts },
      diagnostics: structuredClone(trace.diagnostics),
    };
  }

  private documentWhere(types?: readonly string[], root?: string, subtree?: string): { sql: string; values: string[] } {
    const filters: string[] = [];
    const values: string[] = [];
    if (types) { filters.push(`extension IN (${types.map(() => "?").join(",")})`); values.push(...types); }
    if (root) { filters.push("id IN (SELECT document_id FROM document_roots WHERE root_path = ?)"); values.push(root); }
    if (subtree) {
      const sep = path.sep;
      const prefix = `${subtree.endsWith(sep) ? subtree : subtree + sep}`
        .replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      if (process.platform === "win32") {
        filters.push("(lower(path) = lower(?) OR lower(path) LIKE lower(?) ESCAPE '\\')");
        values.push(subtree, `${prefix}%`);
      } else {
        filters.push("(path = ? OR path LIKE ? ESCAPE '\\')");
        values.push(subtree, `${prefix}%`);
      }
    }
    return { sql: filters.length ? ` WHERE ${filters.join(" AND ")}` : "", values };
  }

  candidates(types?: readonly string[], root?: string, subtree?: string): SearchCandidate[] {
    const { sql, values } = this.documentWhere(types, root, subtree);
    const documents = this.db.prepare(`SELECT id, path, filename, extension, size_bytes, modified_at_ms, status FROM documents${sql}`)
      .all(...values) as unknown as StoredDocumentRow[];
    return documents.map(document => ({ document, blocks: this.blocksFor(document.id) }));
  }
  // FTS5 rowids are document IDs; payload ordinals are pruned separately by payload Bloom summaries.
  private postingDocumentIds(terms: readonly string[] | undefined, allTerms: boolean, trace?: SearchTraceRecorder): Set<number> | undefined {
    if (!terms?.length || !this.ngramIndexReady()) return undefined;
    const started = performance.now();
    try {
      const required = allTerms ? terms : [terms[0]!];
      let result: Set<number> | undefined;
      for (const term of required) {
        const characters = [...normalizeSearchText(term)];
        if (!characters.length) return new Set();
        const useUnigrams = characters.length < 3;
        const query = ftsMatch(term, useUnigrams);
        if (!query) return new Set();
        const table = useUnigrams ? UNIGRAM_TABLE : TRIGRAM_TABLE;
        const rows = this.db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(query) as { rowid: number }[];
        const ids = new Set(rows.map(row => Number(row.rowid)));
        if (!result) result = ids;
        else for (const id of result) if (!ids.has(id)) result.delete(id);
        if (!result.size) return result;
      }
      return result ?? new Set();
    } finally {
      trace?.addPhase("postingsLookup", performance.now() - started);
    }
  }

  *streamCandidates(types?: readonly string[], root?: string, terms?: readonly string[], allTerms = false,
    subtree?: string, trace?: SearchTraceRecorder): Generator<StreamingCandidate> {
    const postingIds = this.postingDocumentIds(terms, allTerms, trace);
    if (postingIds) trace?.addCandidateSource("postings");
    else if (terms?.length) trace?.addCandidateSource("bloom-fallback");
    else trace?.addCandidateSource("document-scan");
    const base = this.documentWhere(types, root, subtree);
    if (trace) {
      const started = performance.now();
      const row = this.db.prepare(`SELECT count(*) AS count FROM documents${base.sql}`).get(...base.values) as { count: number };
      trace.addPhase("documentEnumeration", performance.now() - started);
      trace.setCount("documentsInScope", Number(row.count));
    }
    if (postingIds && !postingIds.size) return;
    const sql = postingIds
      ? `${base.sql ? `${base.sql} AND` : " WHERE"} id IN (SELECT value FROM json_each(?))`
      : base.sql;
    const values = postingIds ? [...base.values, JSON.stringify([...postingIds])] : base.values;
    const documents = this.db.prepare(`SELECT id, path, filename, extension, size_bytes, modified_at_ms, status FROM documents${sql}`);
    const bloom = this.db.prepare("SELECT bloom FROM document_blooms WHERE document_id = ?");
    const payloadBlooms = this.db.prepare("SELECT payload_ordinal, bloom FROM document_payload_blooms WHERE document_id = ? ORDER BY payload_ordinal");
    const iterator = (documents.iterate(...values) as Iterable<StoredDocumentRow>)[Symbol.iterator]();
    while (true) {
      const started = performance.now();
      const next = iterator.next();
      trace?.addPhase("documentEnumeration", performance.now() - started);
      if (next.done) return;
      const document = next.value;
      trace?.increment("documentsConsidered");
      yield this.candidateFromBlooms(document, bloom, payloadBlooms, terms, allTerms, trace);
    }
  }

  *streamCandidatesByIds(ids: readonly number[], terms?: readonly string[], allTerms = false,
    trace?: SearchTraceRecorder): Generator<StreamingCandidate> {
    trace?.addCandidateSource("restricted-ids");
    if (!ids.length) {
      trace?.setCount("documentsInScope", 0);
      return;
    }
    const uniqueIds = [...new Set(ids)];
    trace?.setCount("documentsInScope", uniqueIds.length);
    const postingIds = this.postingDocumentIds(terms, allTerms, trace);
    if (postingIds) trace?.addCandidateSource("postings");
    else if (terms?.length) trace?.addCandidateSource("bloom-fallback");
    if (!postingIds && !terms?.length) trace?.addCandidateSource("document-scan");
    const selected = uniqueIds.filter(id => !postingIds || postingIds.has(id));
    if (!selected.length) return;
    const bloom = this.db.prepare("SELECT bloom FROM document_blooms WHERE document_id = ?");
    const payloadBlooms = this.db.prepare("SELECT payload_ordinal, bloom FROM document_payload_blooms WHERE document_id = ? ORDER BY payload_ordinal");
    const started = performance.now();
    const rows = this.db.prepare(`SELECT id, path, filename, extension, size_bytes, modified_at_ms, status FROM documents
      WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(selected)) as unknown as StoredDocumentRow[];
    trace?.addPhase("documentEnumeration", performance.now() - started);
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const id of selected) {
      const document = byId.get(id);
      if (!document) continue;
      trace?.increment("documentsConsidered");
      yield this.candidateFromBlooms(document, bloom, payloadBlooms, terms, allTerms, trace);
    }
  }

  private candidateFromBlooms(
    document: StoredDocumentRow,
    bloom: { get(id: number): unknown },
    payloadBlooms: { all(id: number): unknown },
    terms?: readonly string[],
    allTerms = false,
    trace?: SearchTraceRecorder,
  ): StreamingCandidate {
    const documentBloomStarted = performance.now();
    const row = bloom.get(document.id) as { bloom: Uint8Array } | undefined;
    if (row) trace?.addCandidateSource("document-bloom");
    const filename = document.filename.normalize("NFKC").toLowerCase();
    const requiredTerms = !terms ? [] : allTerms
      ? terms.filter(term => !filename.includes(term))
      : filename.includes(terms[0]!) ? [] : terms;
    const possible = !terms || !row || (allTerms
      ? requiredTerms.every(term => bloomMayContain(row.bloom, term, this.shortTermsReady))
      : requiredTerms.length === 0 || bloomMayContain(row.bloom, requiredTerms[0]!, this.shortTermsReady));
    trace?.addPhase("documentBloom", performance.now() - documentBloomStarted);
    if (!possible) {
      trace?.increment("documentsPruned");
      return { document, blocks: [], pruned: true };
    }
    trace?.increment("documentsAfterPruning");
    const payloadBloomStarted = performance.now();
    const summaries = payloadBlooms.all(document.id) as { payload_ordinal: number; bloom: Uint8Array }[];
    // Missing payload summaries are an old/incomplete index: retain the
    // document-level fallback rather than risking a false negative.
    const candidates = !terms || !summaries.length || terms.some(term => term.length < 3)
      ? undefined
      : summaries.filter(summary => bloomMayContainAny(summary.bloom, allTerms ? terms : [terms[0]!]))
        .map(summary => summary.payload_ordinal);
    trace?.addPhase("payloadBloom", performance.now() - payloadBloomStarted);
    trace?.increment("payloadsConsidered", summaries.length);
    trace?.increment("payloadsAfterPruning", candidates?.length ?? summaries.length);
    trace?.increment("bloomSelectedPayloads", candidates?.length ?? 0);
    if (terms?.some(term => term.length >= 3)) trace?.addCandidateSource("payload-bloom");
    // A trigram may straddle two compressed payloads.  The document bloom
    // has already established that the document is possible, so an empty
    // payload set must conservatively read it rather than lose that match.
    return { document, blocks: candidates?.length
      ? this.streamBlocksFor(document.id, candidates, trace)
      : this.streamBlocksFor(document.id, undefined, trace) };
  }

  candidateByPath(filePath: string, trace?: SearchTraceRecorder): SearchCandidate | undefined {
    const started = performance.now();
    const document = this.db.prepare("SELECT id, path, filename, extension, size_bytes, modified_at_ms, status FROM documents WHERE path = ?")
      .get(filePath) as StoredDocumentRow | undefined;
    trace?.addPhase("documentEnumeration", performance.now() - started);
    if (!document) return undefined;
    trace?.increment("documentsConsidered");
    trace?.increment("documentsAfterPruning");
    const blocks = this.blocksFor(document.id, trace);
    return { document, blocks };
  }

  blockSource(documentId: number, ordinal: number, source: "heading" | "content", trace?: SearchTraceRecorder): string | null {
    const started = performance.now();
    const blockQuery = this.db.prepare("SELECT id FROM blocks WHERE document_id = ? AND ordinal = ?");
    trace?.recordPayloadSql("blocksMetadata", "prepare", performance.now() - started);
    let executeStarted = performance.now();
    const block = blockQuery.get(documentId, ordinal) as { id: number } | undefined;
    trace?.recordPayloadSql("blocksMetadata", "execute", performance.now() - executeStarted);
    if (block) trace?.increment("blocksMetadataRows");
    if (!block) {
      trace?.addPhase("payloadLookup", performance.now() - started);
      return null;
    }
    const prepareStarted = performance.now();
    const mappingQuery = this.db.prepare("SELECT payload_ordinal FROM document_payload_blocks WHERE document_id = ? AND block_id = ? ORDER BY payload_ordinal");
    trace?.recordPayloadSql("owningBlockMapping", "prepare", performance.now() - prepareStarted);
    executeStarted = performance.now();
    const payloads = mappingQuery.all(documentId, block.id) as { payload_ordinal: number }[];
    trace?.recordPayloadSql("owningBlockMapping", "execute", performance.now() - executeStarted);
    trace?.increment("owningBlockMappingRows", payloads.length);
    trace?.addPhase("payloadLookup", performance.now() - started);
    // Legacy/incomplete maps remain readable through the full-document path.
    for (const blockSource of this.streamBlocksFor(documentId, payloads.length ? payloads.map(row => row.payload_ordinal) : undefined, trace, true)) {
      if (blockSource.ordinal === ordinal) return source === "heading" ? blockSource.heading : blockSource.content;
    }
    return null;
  }

  private blocksFor(documentId: number, trace?: SearchTraceRecorder): StoredBlockRow[] {
    return [...this.streamBlocksFor(documentId, undefined, trace)];
  }
  private readAllBlockMetadata(documentId: number, trace?: SearchTraceRecorder): StoredBlockDatabaseRow[] {
    const started = performance.now();
    const blocksQuery = this.db.prepare("SELECT id, ordinal, heading, content, location_kind, location_value FROM blocks WHERE document_id = ? ORDER BY ordinal");
    trace?.recordPayloadSql("blocksMetadata", "prepare", performance.now() - started);
    const executeStarted = performance.now();
    const blocks = blocksQuery.all(documentId) as unknown as StoredBlockDatabaseRow[];
    trace?.recordPayloadSql("blocksMetadata", "execute", performance.now() - executeStarted);
    trace?.increment("blocksMetadataRows", blocks.length);
    return blocks;
  }

  private selectedBlockMetadata(documentId: number, candidateJson: string,
    trace?: SearchTraceRecorder): SelectedBlockMetadataRow[] {
    const started = performance.now();
    const blocksQuery = this.db.prepare(`WITH selected AS MATERIALIZED (
      SELECT DISTINCT m.block_id
      FROM json_each(?) AS seed
      CROSS JOIN document_payload_blocks AS m
      WHERE m.document_id = ?
        AND m.payload_ordinal = seed.value
    )
    SELECT s.block_id AS id,
      b.ordinal, b.heading, b.content, b.location_kind, b.location_value
    FROM selected AS s
    LEFT JOIN blocks AS b
      ON b.id = s.block_id AND b.document_id = ?`);
    trace?.recordPayloadSql("blocksMetadata", "prepare", performance.now() - started);
    const executeStarted = performance.now();
    const rows = blocksQuery.all(candidateJson, documentId, documentId) as unknown as SelectedBlockMetadataRow[];
    trace?.recordPayloadSql("blocksMetadata", "execute", performance.now() - executeStarted);
    trace?.increment("blocksMetadataRows", rows.length);
    return rows;
  }

  private *streamBlocksFor(documentId: number, candidatePayloads?: readonly number[],
    trace?: SearchTraceRecorder, snippet = false): Generator<StoredBlockRow> {
    const lookupStarted = performance.now();
    let blocks: StoredBlockDatabaseRow[] | undefined;
    let selectedMetadataRows: SelectedBlockMetadataRow[] | undefined;
    let selectedPayloads: readonly number[] | undefined;
    let candidateJson = "";
    if (candidatePayloads === undefined) {
      blocks = this.readAllBlockMetadata(documentId, trace);
    } else {
      if (!candidatePayloads.length) {
        trace?.addPhase("payloadLookup", performance.now() - lookupStarted);
        return;
      }
      selectedPayloads = [...new Set(candidatePayloads)];
      trace?.increment("candidatePayloadOrdinals", selectedPayloads.length);
      candidateJson = JSON.stringify(selectedPayloads);
      selectedMetadataRows = this.selectedBlockMetadata(documentId, candidateJson, trace);
      if (!selectedMetadataRows.length) {
        selectedMetadataRows = undefined;
        blocks = this.readAllBlockMetadata(documentId, trace);
      }
    }
    let payloads: { ordinal: number; payload: Uint8Array }[];
    if (selectedMetadataRows) {
      const prepareStarted = performance.now();
      const payloadQuery = this.db.prepare(`WITH selected AS MATERIALIZED (
        SELECT DISTINCT m.block_id
        FROM json_each(?) AS seed
        CROSS JOIN document_payload_blocks AS m
        WHERE m.document_id = ?
          AND m.payload_ordinal = seed.value
      )
      SELECT p.ordinal, p.payload
      FROM document_payloads AS p
      WHERE p.document_id = ?
        AND p.ordinal IN (
          SELECT DISTINCT m.payload_ordinal
          FROM selected AS s
          CROSS JOIN document_payload_blocks AS m
            INDEXED BY document_payload_blocks_document_block
          WHERE m.document_id = ?
            AND m.block_id = s.block_id
        )
      ORDER BY p.ordinal`);
      trace?.recordPayloadSql("payloadBlob", "prepare", performance.now() - prepareStarted);
      const executeStarted = performance.now();
      payloads = payloadQuery.all(candidateJson, documentId, documentId, documentId) as { ordinal: number; payload: Uint8Array }[];
      trace?.recordPayloadSql("payloadBlob", "execute", performance.now() - executeStarted);
    } else {
      const prepareStarted = performance.now();
      const payloadQuery = this.db.prepare("SELECT ordinal, payload FROM document_payloads WHERE document_id = ? ORDER BY ordinal");
      trace?.recordPayloadSql("payloadBlob", "prepare", performance.now() - prepareStarted);
      const executeStarted = performance.now();
      payloads = payloadQuery.all(documentId) as { ordinal: number; payload: Uint8Array }[];
      trace?.recordPayloadSql("payloadBlob", "execute", performance.now() - executeStarted);
      trace?.increment("fullDocumentFallbacks");
    }
    trace?.recordPayloadReadPass(documentId, payloads, selectedMetadataRows ? selectedPayloads : undefined, snippet);
    trace?.addPhase("payloadLookup", performance.now() - lookupStarted);
    let selectedMetadata: Map<number, StoredBlockDatabaseRow | null> | undefined;
    if (selectedMetadataRows) {
      selectedMetadata = new Map<number, StoredBlockDatabaseRow | null>();
      for (const row of selectedMetadataRows) {
        if (row.ordinal === null) {
          selectedMetadata.set(row.id, null);
          continue;
        }
        // The SQLite row already has the StoredBlockDatabaseRow fields; avoid a second object allocation.
        const block = row as unknown as StoredBlockDatabaseRow;
        selectedMetadata.set(row.id, block);
      }
      selectedMetadataRows = undefined;
      trace?.increment("owningBlocksFound", selectedMetadata.size);
    }
    if (!payloads.length) {
      const inlineBlocks = selectedMetadata
        ? [...selectedMetadata.values()]
          .filter((block): block is StoredBlockDatabaseRow => block !== null)
          .sort((a, b) => a.ordinal - b.ordinal)
        : blocks!;
      for (const block of inlineBlocks) {
        if (!block.content) throw new Error("索引文字 payload 遺失，請執行 rebuild。");
        yield { ordinal: block.ordinal, heading: block.heading, content: block.content,
          location_kind: block.location_kind, location_value: block.location_value };
      }
      return;
    }
    const metadata = selectedMetadata ?? new Map(blocks!.map(block => [block.id, block]));
    let pending: { id: number; content: string } | null = null;
    for (const payload of payloads) {
      const decompressStarted = performance.now();
      const decompressed = brotliDecompressSync(payload.payload);
      const decodeStarted = performance.now();
      const values = JSON.parse(decompressed.toString("utf8")) as [number, string][];
      const decodeEnded = performance.now();
      trace?.increment("payloadBrotliMs", decodeStarted - decompressStarted);
      trace?.increment("payloadDecodeParseMs", decodeEnded - decodeStarted);
      trace?.addPhase("payloadDecompression", decodeEnded - decompressStarted);
      trace?.recordPayloadDecompression(documentId, payload.ordinal, decompressed.byteLength, snippet);
      for (const [id, content] of values) {
        if (selectedMetadata && !selectedMetadata.has(id)) continue;
        if (pending && pending.id !== id) {
          const block = metadata.get(pending.id);
          if (!block) throw new Error("索引 payload 指向未知區塊，請執行 rebuild。");
          yield { ordinal: block.ordinal, heading: block.heading, content: pending.content,
            location_kind: block.location_kind, location_value: block.location_value };
          pending = null;
        }
        if (pending) pending.content += content;
        else pending = { id, content };
      }
    }
    if (pending) {
      const block = metadata.get(pending.id);
      if (!block) throw new Error("索引 payload 指向未知區塊，請執行 rebuild。");
      yield { ordinal: block.ordinal, heading: block.heading, content: pending.content,
        location_kind: block.location_kind, location_value: block.location_value };
    }
  }



  private writeDocumentPayloads(documentId: number, entries: { id: number; ordinal: number; content: string }[], timings?: UpsertTimings): void {
    const writes = this.writes();
    let batch: [number, string][] = []; let bytes = 2; let ordinal = 0;
    const flush = () => {
      if (!batch.length) return;
      const compressStarted = performance.now();
      const payload = compressText(JSON.stringify(batch));
      if (timings) timings.compressMs += performance.now() - compressStarted;
      const bloomStarted = performance.now();
      const byBlock = new Map<number, string>();
      for (const [id, content] of batch) byBlock.set(id, (byBlock.get(id) ?? "") + content);
      const bloom = buildBloom([...byBlock.values()].map((content, index) => ({ ordinal: index, heading: null, content, locationKind: "line" as const, locationValue: "" })));
      if (timings) timings.bloomMs += performance.now() - bloomStarted;
      const writeStarted = performance.now();
      writes.insertPayload.run(documentId, ordinal, payload);
      for (const id of new Set(batch.map(item => item[0]))) writes.insertPayloadBlock.run(documentId, ordinal, id);
      writes.insertPayloadBloom.run(documentId, ordinal, bloom);
      if (timings) timings.writeMs += performance.now() - writeStarted;
      ordinal++; batch = []; bytes = 2;
    };
    for (const entry of [...entries].sort((a, b) => a.ordinal - b.ordinal)) {
      for (const chunk of splitText(entry.content)) {
        const item: [number, string] = [entry.id, chunk]; const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (batch.length ? 1 : 0);
        if (batch.length && bytes + itemBytes > textChunkBytes) flush();
        batch.push(item); bytes += itemBytes;
      }
    }
    flush();
  }

  private async migratePayloads(options: UpgradeOptions): Promise<void> {
    if (this.metadata("content_storage_version") === "2") return;
    const documents = this.db.prepare(`SELECT d.id, d.path FROM documents d
      WHERE NOT EXISTS (SELECT 1 FROM index_migration_documents m
        WHERE m.version = 'content_storage_2' AND m.document_id = d.id)
      ORDER BY d.id`).all() as { id: number; path: string }[];
    const total = Number((this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count);
    let completed = total - documents.length;
    options.onProgress?.({ stage: "upgrade", message: "升級舊索引文字儲存格式", current: completed, total });
    const blocksQuery = this.db.prepare("SELECT id, ordinal, content FROM blocks WHERE document_id = ? ORDER BY ordinal");
    const legacyQuery = this.db.prepare("SELECT payload FROM block_payloads WHERE block_id = ? ORDER BY ordinal");
    const writes = this.writes();
    for (const document of documents) {
      throwIfAborted(options.signal);
      options.onProgress?.({ stage: "upgrade", message: "升級舊索引文字儲存格式", current: completed, total, path: document.path });
      const blocks = blocksQuery.all(document.id) as { id: number; ordinal: number; content: string }[];
      const entries = blocks.map(block => ({
        id: block.id,
        ordinal: block.ordinal,
        content: block.content || Buffer.concat((legacyQuery.all(block.id) as { payload: Uint8Array }[]).map(item => brotliDecompressSync(item.payload))).toString("utf8"),
      }));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        writes.deletePayloadBlocks.run(document.id);
        writes.deletePayloads.run(document.id);
        writes.deletePayloadBlooms.run(document.id);
        this.writeDocumentPayloads(document.id, entries);
        this.db.prepare("DELETE FROM block_payloads WHERE block_id IN (SELECT id FROM blocks WHERE document_id = ?)").run(document.id);
        this.db.prepare("UPDATE blocks SET content = '' WHERE document_id = ?").run(document.id);
        this.db.prepare("INSERT OR REPLACE INTO index_migration_documents(version, document_id) VALUES ('content_storage_2', ?)").run(document.id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      completed++;
      options.onProgress?.({ stage: "upgrade", message: "升級舊索引文字儲存格式", current: completed, total, path: document.path });
      await yieldToEvents();
    }
    throwIfAborted(options.signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('content_storage_version', '2')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async migratePayloadBlooms(options: UpgradeOptions): Promise<void> {
    if (this.metadata("payload_bloom_version") === "2") return;
    const documents = this.db.prepare(`SELECT d.id, d.path FROM documents d
      WHERE NOT EXISTS (SELECT 1 FROM index_migration_documents m
        WHERE m.version = 'payload_bloom_2' AND m.document_id = d.id)
      ORDER BY d.id`).all() as { id: number; path: string }[];
    const total = Number((this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count);
    let completed = total - documents.length;
    options.onProgress?.({ stage: "upgrade", message: "建立短詞搜尋摘要", current: completed, total });
    const blocksQuery = this.db.prepare("SELECT id, heading FROM blocks WHERE document_id = ? ORDER BY ordinal");
    const payloadsQuery = this.db.prepare("SELECT ordinal, payload FROM document_payloads WHERE document_id = ? ORDER BY ordinal");
    for (const document of documents) {
      throwIfAborted(options.signal);
      options.onProgress?.({ stage: "upgrade", message: "建立短詞搜尋摘要", current: completed, total, path: document.path });
      const blocks = blocksQuery.all(document.id) as { id: number; heading: string | null }[];
      const metadata = new Map(blocks.map(block => [block.id, block]));
      const payloads = payloadsQuery.all(document.id) as { ordinal: number; payload: Uint8Array }[];
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM document_payload_blocks WHERE document_id = ?").run(document.id);
        this.db.prepare("DELETE FROM document_payload_blooms WHERE document_id = ?").run(document.id);
        const insertBlock = this.db.prepare("INSERT INTO document_payload_blocks(document_id, payload_ordinal, block_id) VALUES (?, ?, ?)");
        const insertBloom = this.db.prepare("INSERT INTO document_payload_blooms(document_id, payload_ordinal, bloom) VALUES (?, ?, ?)");
        const documentContent = new Map<number, string>();
        let payloadIndex = 0;
        for (const payload of payloads) {
          throwIfAborted(options.signal);
          const values = JSON.parse(brotliDecompressSync(payload.payload).toString("utf8")) as [number, string][];
          const content = new Map<number, string>();
          for (const [blockId, fragment] of values) {
            if (!metadata.has(blockId)) throw new Error("索引 payload 指向未知區塊，無法安全升級。");
            content.set(blockId, (content.get(blockId) ?? "") + fragment);
            documentContent.set(blockId, (documentContent.get(blockId) ?? "") + fragment);
          }
          for (const blockId of content.keys()) insertBlock.run(document.id, payload.ordinal, blockId);
          insertBloom.run(document.id, payload.ordinal, buildBloom([...content].map(([blockId, value], ordinal) => ({
            ordinal, heading: metadata.get(blockId)?.heading ?? null, content: value, locationKind: "line" as const, locationValue: "",
          }))));
          payloadIndex++;
          if (payloadIndex % 16 === 0) {
            options.onProgress?.({ stage: "upgrade", message: `建立短詞搜尋摘要（payload ${payloadIndex}/${payloads.length}）`,
              current: completed, total, path: document.path });
            await yieldToEvents();
          }
        }
        this.db.prepare("INSERT INTO document_blooms(document_id, bloom) VALUES (?, ?) ON CONFLICT(document_id) DO UPDATE SET bloom=excluded.bloom")
          .run(document.id, buildBloom(blocks.map((block, ordinal) => ({
            ordinal, heading: block.heading, content: documentContent.get(block.id) ?? "", locationKind: "line" as const, locationValue: "",
          }))));
        this.db.prepare("INSERT OR REPLACE INTO index_migration_documents(version, document_id) VALUES ('payload_bloom_2', ?)").run(document.id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      completed++;
      options.onProgress?.({ stage: "upgrade", message: "建立短詞搜尋摘要", current: completed, total, path: document.path });
      await yieldToEvents();
    }
    throwIfAborted(options.signal);
    this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('payload_bloom_version', '2')").run();
    this.shortTermsReady = true;
    options.onProgress?.({ stage: "upgrade", message: "短詞搜尋摘要升級完成", current: total, total });
  }
  private async migrateNgramIndex(options: UpgradeOptions): Promise<void> {
    if (this.ngramIndexReady()) return;
    if (!this.hasNgramTables()) throw new Error("SQLite FTS5 搜尋索引不可用，無法安全升級。");
    const documents = this.db.prepare(`SELECT d.id, d.path, d.filename FROM documents d
      WHERE NOT EXISTS (SELECT 1 FROM index_migration_documents m
        WHERE m.version = ? AND m.document_id = d.id)
      ORDER BY d.id`).all(NGRAM_MIGRATION_VERSION) as { id: number; path: string; filename: string }[];
    const total = Number((this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count);
    let completed = total - documents.length;
    options.onProgress?.({ stage: "upgrade", message: "建立 unigram／trigram 搜尋 postings", current: completed, total });
    const writes = this.writes();
    for (const document of documents) {
      throwIfAborted(options.signal);
      options.onProgress?.({ stage: "upgrade", message: "建立 unigram／trigram 搜尋 postings", current: completed, total, path: document.path });
      const blocks = [...this.streamBlocksFor(document.id)];
      const normalized = normalizeSearchText(searchableDocumentText(document.filename, blocks));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        writes.deleteNgramUnigrams.run(document.id);
        writes.deleteNgramTrigrams.run(document.id);
        writes.insertNgramUnigrams.run(document.id, unigramText(normalized));
        writes.insertNgramTrigrams.run(document.id, normalized);
        writes.insertNgramMigration.run(NGRAM_MIGRATION_VERSION, document.id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      completed++;
      options.onProgress?.({ stage: "upgrade", message: "建立 unigram／trigram 搜尋 postings", current: completed, total, path: document.path });
      await yieldToEvents();
    }
    throwIfAborted(options.signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('ngram_index_version', ?)").run(NGRAM_INDEX_VERSION);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    options.onProgress?.({ stage: "upgrade", message: "unigram／trigram 搜尋 postings 升級完成", current: total, total });
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, count(*) AS count FROM documents GROUP BY status").all() as { status: string; count: number }[];
    const counts = Object.fromEntries(documentStatuses.map(status => [status, 0]));
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  documentIssues(): StoredIssue[] {
    return this.db.prepare(`SELECT path, status, error_code AS errorCode, error_message AS errorMessage
      FROM documents WHERE error_code IS NOT NULL ORDER BY path`).all() as unknown as StoredIssue[];
  }

  storageFootprint(): StorageFootprint {
    return collectIndexStorage(this.databasePath);
  }

  extensionStats(): ExtensionStats[] {
    const rows = this.db.prepare(`SELECT extension, status, count(*) AS count, sum(size_bytes) AS bytes
      FROM documents GROUP BY extension, status`).all() as { extension: string; status: DocumentStatus; count: number; bytes: number | null }[];
    const byExtension = new Map<string, ExtensionStats>();
    for (const row of rows) {
      const key = row.extension;
      const current = byExtension.get(key) ?? {
        extension: key, documents: 0, sourceBytes: 0, statuses: emptyStatusCounts(),
      };
      current.documents += Number(row.count);
      current.sourceBytes += Number(row.bytes ?? 0);
      current.statuses[row.status] = Number(row.count);
      byExtension.set(key, current);
    }
    return [...byExtension.values()].sort((a, b) => a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0);
  }

  private metadata(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  recordSync(root: string, complete: boolean, errors: string[], notices: string[], summary?: SyncSummary, diagnostics: Diagnostic[] = []): void {
    this.registerRoot(root);
    const previous = this.getLastSyncReport(root);
    const attemptedAt = new Date().toISOString();
    const rootChanged = this.getRoot() !== root;
    const set = this.db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE roots SET report = ? WHERE path = ?").run(JSON.stringify({
        attemptedAt, successfulAt: complete ? attemptedAt : previous.successfulAt, complete,
        errors, notices, summary: summary ?? null, diagnostics,
      }), root);
      set.run("root", root);
      set.run("last_sync_attempt", attemptedAt);
      set.run("last_sync_complete", complete ? "1" : "0");
      set.run("last_sync_errors", JSON.stringify(errors));
      set.run("last_sync_notices", JSON.stringify(notices));
      set.run("last_sync_summary", JSON.stringify(summary ?? null));
      set.run("last_sync_diagnostics", JSON.stringify(diagnostics));
      if (rootChanged) this.db.prepare("DELETE FROM metadata WHERE key IN ('last_successful_sync', 'last_sync')").run();
      if (complete) set.run("last_successful_sync", attemptedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getLastSyncReport(root?: string): LastSyncReport {
    if (root) {
      const row = this.db.prepare("SELECT report FROM roots WHERE path = ?").get(root) as { report: string | null } | undefined;
      if (row?.report) return JSON.parse(row.report) as LastSyncReport;
      return { attemptedAt: null, successfulAt: null, complete: null, errors: [], notices: [], summary: null, diagnostics: [] };
    }
    const parseList = (key: string): string[] => {
      try {
        const value = JSON.parse(this.metadata(key) ?? "[]");
        return Array.isArray(value) && value.every(item => typeof item === "string") ? value : [];
      } catch {
        return [];
      }
    };
    const complete = this.metadata("last_sync_complete");
    return {
      attemptedAt: this.metadata("last_sync_attempt") ?? this.metadata("last_sync"),
      successfulAt: this.metadata("last_successful_sync") ?? this.metadata("last_sync"),
      complete: complete === null ? null : complete === "1",
      errors: parseList("last_sync_errors"),
      notices: parseList("last_sync_notices"),
      summary: JSON.parse(this.metadata("last_sync_summary") ?? "null") as SyncSummary | null,
      diagnostics: JSON.parse(this.metadata("last_sync_diagnostics") ?? "[]") as Diagnostic[],
    };
  }

  getLastSync(): string | null {
    return this.getLastSyncReport().attemptedAt;
  }
}
