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
import { blocksContaining, buildChunks, decodeChunk, derivedLocation, type BuiltChunk, type ChunkBlock } from "./chunk-store.js";
import { OperationCancelledError, throwIfAborted, yieldToEvents, type ProgressUpdate } from "./progress.js";
import { coversPath, resolveUserRootPath, samePath } from "./root-plan.js";
import { createTraceLog, type TraceLog } from "./trace-log.js";
import type { SearchTrace, SearchTraceRecorder } from "./search-trace.js";
import { RootError } from "./scanner.js";

export type DataDirSource = "LOCALDOCSEARCH_DATA_DIR" | "LOCALAPPDATA" | "XDG_DATA_HOME" | "home-fallback";
export interface RemovalResult {
  removed: number;
  protected: number;
}
export interface RemoveMissingOptions {
  signal?: AbortSignal;
  onProgress?: (update: ProgressUpdate) => void;
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

// 0.38.0 block-level index (SPEC §50／D081).
const BLOCK_INDEX_VERSION = "1";
const BLOCK_MIGRATION_VERSION = "block_index_1";
// 0.39.0 chunk store (SPEC §52／D083).
const CHUNK_STORE_VERSION = "1";
const CHUNK_MIGRATION_VERSION = "chunk_store_1";
const CHUNK_TABLES = { tri: "search_chunk_trigrams", uni: "search_chunk_unigrams", bi: "search_chunk_bigrams" } as const;
// Everything the chunk store replaces; dropped (children first) when its migration completes.
const PRE_CHUNK_TABLES = ["block_payloads", "document_payload_blocks", "document_payloads", "blocks",
  "search_block_trigrams", "search_block_unigrams", "search_block_bigrams",
  "document_blooms", "document_payload_blooms", "search_unigrams", "search_trigrams"] as const;
// A migration's per-document markers are obsolete once its metadata version is written.
const COMPLETED_MIGRATION_MARKERS = [
  { key: "content_storage_version", value: "2", marker: "content_storage_2" },
  { key: "block_index_version", value: BLOCK_INDEX_VERSION, marker: BLOCK_MIGRATION_VERSION },
  { key: "chunk_store_version", value: CHUNK_STORE_VERSION, marker: CHUNK_MIGRATION_VERSION },
] as const;
// removeMissing commits deletions in batches of this many documents (SPEC §51.3).
const REMOVE_BATCH_SIZE = 1000;
const LEGACY_SEARCH_TABLES = ["document_blooms", "document_payload_blooms", UNIGRAM_TABLE, TRIGRAM_TABLE] as const;
const BLOCK_TABLES = { tri: "search_block_trigrams", uni: "search_block_unigrams", bi: "search_block_bigrams" } as const;
const FILENAME_TABLES = { tri: "search_filename_trigrams", uni: "search_filename_unigrams", bi: "search_filename_bigrams" } as const;
const HEADING_TABLES = { tri: "search_heading_trigrams", uni: "search_heading_unigrams", bi: "search_heading_bigrams" } as const;
type IndexTables = { tri: string; uni: string; bi: string };

// Per-connection page cache (negative = KiB). The 2 MiB SQLite default makes FTS5
// segment merges and large posting scans on multi-GiB indexes re-read pages.
const PAGE_CACHE_KIB = -65_536;
// Read-only connections map up to this much of the database file.
const MMAP_BYTES = 1024 * 1024 * 1024;

const ftsString = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Deduplicated `u<hex>` code point and `b<hex>x<hex>` adjacent-pair tokens of normalized text. */
function shortTokens(normalized: string): { unigrams: string; bigrams: string } {
  const unigrams = new Set<string>();
  const bigrams = new Set<string>();
  let previous: string | undefined;
  for (const character of normalized) {
    const hex = character.codePointAt(0)!.toString(16);
    unigrams.add(hex);
    if (previous !== undefined) bigrams.add(`${previous}x${hex}`);
    previous = hex;
  }
  return { unigrams: [...unigrams].map(item => `u${item}`).join(" "), bigrams: [...bigrams].map(item => `b${item}`).join(" ") };
}

export interface IndexMatch { table: keyof IndexTables; match: string; exact: boolean }

/**
 * FTS query for one normalized term. 1 and 2 code points use exact tokens; 3+
 * uses the trigram table (a phrase when `phrase`, else an AND superset).
 * SQLite ends an FTS5 query string at U+0000, so such trigrams fall back to a
 * unigram AND superset that callers must verify.
 */
function indexMatch(term: string, phrase: boolean): IndexMatch {
  const characters = [...term];
  const hex = (character: string) => character.codePointAt(0)!.toString(16);
  if (characters.length === 1) return { table: "uni", match: ftsString(`u${hex(characters[0]!)}`), exact: true };
  if (characters.length === 2) return { table: "bi", match: ftsString(`b${hex(characters[0]!)}x${hex(characters[1]!)}`), exact: true };
  if (term.includes("\u0000")) {
    return { table: "uni", match: [...new Set(characters.map(character => ftsString(`u${hex(character)}`)))].join(" AND "), exact: false };
  }
  if (phrase) return { table: "tri", match: ftsString(term), exact: true };
  return { table: "tri", match: trigramValues(term).map(ftsString).join(" AND "), exact: false };
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
  blockIndexVersion: string | null;
  blockIndexCompletedDocuments: number;
  chunkStoreVersion: string | null;
  chunkStoreCompletedDocuments: number;
  /** Pre-0.39.0 blocks, payloads or search structures still present (dropped when the chunk store migration completes). */
  legacySearchStructures: boolean;
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
  private blockIndexReadyCache = false;
  private chunkStoreReadyCache = false;
  private readonly scopeCounts = new Map<string, number>();
  private latestSearchTrace: SearchTrace | null = null;
  private traceLog: TraceLog | undefined;
  private cachedWrites: ReturnType<IndexStore["createWrites"]> | null = null;
  private chunkByIdSql: ReturnType<DatabaseSync["prepare"]> | null = null;
  private blockMetaSql: ReturnType<DatabaseSync["prepare"]> | null = null;
  private cachedWritesSchema = -1;

  constructor(databasePath = defaultDatabasePath(), options: IndexStoreOptions = {}) {
    this.databasePath = databasePath;
    this.readOnly = options.readOnly ?? false;
    if (this.readOnly) {
      this.db = new DatabaseSync(databasePath, databaseOptions({ readOnly: true }));
      this.db.exec("PRAGMA query_only = ON");
      this.db.exec("PRAGMA busy_timeout = 0");
      this.db.exec(`PRAGMA cache_size = ${PAGE_CACHE_KIB}`);
      // Searches open a fresh read-only connection each time; memory-mapped reads avoid
      // a system call per page when verifying chunks on a cold page cache (SPEC §52.2).
      this.db.exec(`PRAGMA mmap_size = ${MMAP_BYTES}`);
      this.shortTermsReady = this.metadata("payload_bloom_version") === "2";
      return;
    }
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const fresh = !existsSync(databasePath);
    const release = acquireWriteLock(databasePath);
    try {
      this.db = new DatabaseSync(databasePath, databaseOptions());
      this.db.exec("PRAGMA busy_timeout = 0");
      this.db.exec(`PRAGMA cache_size = ${PAGE_CACHE_KIB}`);
      this.initializeSchema(fresh);
      if (fresh) {
        // A fresh index starts on the chunk store and never creates blocks, payloads or older search structures.
        this.db.exec(`INSERT OR REPLACE INTO metadata(key, value) VALUES
          ('content_storage_version', '2'), ('multi_root_version', '1'),
          ('root_merge_version', '1'), ('chunk_store_version', '${CHUNK_STORE_VERSION}')`);
      } else {
        this.purgeCompletedMigrationMarkers();
      }
    } finally { release(); }
    this.shortTermsReady = this.metadata("payload_bloom_version") === "2";
  }

  /** Markers only track an in-progress migration; 0.38.0 left them behind after completion (SPEC §51.2). */
  private purgeCompletedMigrationMarkers(): void {
    const completed = COMPLETED_MIGRATION_MARKERS
      .filter(({ key, value }) => this.metadata(key) === value)
      .map(({ marker }) => marker);
    if (!completed.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM index_migration_documents WHERE version = ?");
      for (const marker of completed) remove.run(marker);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private initializeSchema(fresh: boolean): void {
    this.initializeCoreSchema();
    // Blocks, payloads and the older search structures exist only on indexes
    // created before 0.39.0, until their chunk store migration completes (SPEC §52.4).
    if (fresh || this.metadata("chunk_store_version") === CHUNK_STORE_VERSION) return;
    this.initializeLegacyContentSchema();
    if (this.metadata("block_index_version") !== BLOCK_INDEX_VERSION) this.initializeLegacySearchSchema();
  }

  private initializeLegacyContentSchema(): void {
    this.db.exec(`
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
      CREATE TABLE IF NOT EXISTS document_payload_blocks (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        payload_ordinal INTEGER NOT NULL, block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        PRIMARY KEY(document_id, payload_ordinal, block_id)
      );
      CREATE INDEX IF NOT EXISTS document_payload_blocks_document_block ON document_payload_blocks(document_id, block_id);
      CREATE INDEX IF NOT EXISTS document_payload_blocks_block_id ON document_payload_blocks(block_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS ${BLOCK_TABLES.tri} USING fts5(
        text, content='', contentless_delete=1, detail=full, tokenize='trigram case_sensitive 1'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${BLOCK_TABLES.uni} USING fts5(
        text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 0'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${BLOCK_TABLES.bi} USING fts5(
        text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 0'
      );
    `);
  }

  private initializeLegacySearchSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_blooms (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, bloom BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_payload_blooms (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        payload_ordinal INTEGER NOT NULL, bloom BLOB NOT NULL,
        PRIMARY KEY(document_id, payload_ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_unigrams USING fts5(
        text, content='', contentless_delete=1, detail=none,
        tokenize='unicode61 remove_diacritics 0'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_trigrams USING fts5(
        text, content='', contentless_delete=1, detail=none,
        tokenize='trigram'
      );
    `);
  }

  private initializeCoreSchema(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
        extension TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
        indexed_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
        error_code TEXT, error_message TEXT, parse_version INTEGER
      );
      CREATE TABLE IF NOT EXISTS document_chunks (
        id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, text BLOB NOT NULL, layout BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_chunks_document ON document_chunks(document_id, ordinal);
      CREATE TABLE IF NOT EXISTS block_meta (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, heading TEXT, location_kind TEXT NOT NULL, location_value TEXT NOT NULL,
        PRIMARY KEY(document_id, ordinal)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS index_migration_documents (
        version TEXT NOT NULL,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        PRIMARY KEY(version, document_id)
      );
      -- Deleting a document cascades here by document_id alone (SPEC §51.1).
      CREATE INDEX IF NOT EXISTS index_migration_documents_document ON index_migration_documents(document_id);
      CREATE TABLE IF NOT EXISTS search_headings (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        min_ordinal INTEGER NOT NULL, heading TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_headings_document ON search_headings(document_id);
      ${/* Text is already NFKC + toLowerCase(); a case-sensitive trigram tokenizer adds no second
        folding (FTS5 would fold final sigma ς to σ), so a trigram phrase is an exact substring. */ ""}
      ${[CHUNK_TABLES, FILENAME_TABLES, HEADING_TABLES].map(tables => `
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tables.tri} USING fts5(
        text, content='', contentless_delete=1, detail=none, tokenize='trigram case_sensitive 1'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tables.uni} USING fts5(
        text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 0'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tables.bi} USING fts5(
        text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 0'
      );`).join("")}
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
    // Markers exist only while the migration runs; a finished index counts every document (SPEC §51.2).
    const blockIndexCompletedDocuments = this.blockIndexReady() ? totalDocuments : this.hasTable("index_migration_documents")
      ? Number((this.db.prepare("SELECT count(*) AS count FROM index_migration_documents WHERE version = ?").get(BLOCK_MIGRATION_VERSION) as { count: number }).count) : 0;
    const chunkStoreCompletedDocuments = this.chunkStoreReady() ? totalDocuments : this.hasTable("index_migration_documents")
      ? Number((this.db.prepare("SELECT count(*) AS count FROM index_migration_documents WHERE version = ?").get(CHUNK_MIGRATION_VERSION) as { count: number }).count) : 0;
    return { contentStorageVersion, payloadBloomVersion, ngramIndexVersion, ngramCompletedDocuments, ngramTablesReady,
      blockIndexVersion: this.metadata("block_index_version"), blockIndexCompletedDocuments,
      chunkStoreVersion: this.metadata("chunk_store_version"), chunkStoreCompletedDocuments,
      legacySearchStructures: PRE_CHUNK_TABLES.some(table => this.hasTable(table)),
      needsUpgrade: contentStorageVersion !== "2" || this.metadata("multi_root_version") !== "1"
        || this.metadata("root_merge_version") !== "1" || !this.chunkStoreReady(),
      completedDocuments, totalDocuments,
      mappingIndexReady: this.mappingIndexReady(),
      textUpgradePending: pending.total,
      textUpgradeByExtension: pending.byExtension };
  }

  ngramIndexReady(): boolean {
    return this.metadata("ngram_index_version") === NGRAM_INDEX_VERSION && this.hasNgramTables();
  }

  /** True when every document is in the block index (SPEC §50); otherwise search uses the §48 path. */
  blockIndexReady(): boolean {
    // Only "ready" is cached: another writer may finish the migration (and drop
    // the legacy tables) while a long-lived read-only connection stays open.
    if (!this.blockIndexReadyCache) {
      this.blockIndexReadyCache = this.metadata("block_index_version") === BLOCK_INDEX_VERSION
        && this.hasTable(BLOCK_TABLES.tri) && this.hasTable("search_headings");
    }
    return this.blockIndexReadyCache;
  }

  /** True when every document is in the chunk store (SPEC §52); otherwise search uses the pre-0.39 paths. */
  chunkStoreReady(): boolean {
    // Only "ready" is cached, as for blockIndexReady(): another writer may finish the migration.
    if (!this.chunkStoreReadyCache) {
      this.chunkStoreReadyCache = this.metadata("chunk_store_version") === CHUNK_STORE_VERSION && this.hasTable("document_chunks");
    }
    return this.chunkStoreReadyCache;
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
      // The chunk store replaces the payload Bloom／ngram and block index
      // migrations; every older structure is dropped when it completes (SPEC §52.4).
      if (!this.chunkStoreReady()) await this.migrateChunkStore(options);
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

  /** Workbench total count mode (SPEC §52.3); fast unless explicitly set to exact. */
  searchTotalMode(): "fast" | "exact" {
    return this.metadata("search_total_mode") === "exact" ? "exact" : "fast";
  }
  setSearchTotalMode(mode: "fast" | "exact"): void {
    if (this.readOnly) throw new Error("唯讀索引不能變更工作台設定。");
    this.db.prepare("INSERT INTO metadata(key, value) VALUES ('search_total_mode', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(mode);
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
          for (const document of documents) this.deleteSearchRows(document.document_id, writes);
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
      const documents = this.db.prepare("SELECT document_id FROM document_roots WHERE root_path = ?").all(root) as { document_id: number }[];
      for (const document of documents) this.deleteSearchRows(document.document_id);
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
    // Another writer (e.g. a finished block index migration) may drop the legacy
    // tables under a long-lived store such as the autoupdate daemon; re-prepare.
    const schema = Number((this.db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
    if (!this.cachedWrites || this.cachedWritesSchema !== schema) {
      this.cachedWrites = this.createWrites();
      this.cachedWritesSchema = schema;
    }
    return this.cachedWrites;
  }

  private createWrites() {
    const prepare = (sql: string) => this.db.prepare(sql);
    const legacyBloom = this.hasTable("document_blooms") && this.hasTable("document_payload_blooms");
    const legacyNgram = this.hasNgramTables();
    // Pre-0.39.0 content (blocks + payload docstore) is kept current until the chunk
    // store migration completes, so read-only pre-migration search stays correct (SPEC §52.4).
    const legacyContent = this.hasTable("blocks") && this.hasTable("document_payloads") && this.hasTable("document_payload_blocks");
    // A 0.38.0 index searches through its block index until then.
    const legacyBlockIndex = legacyContent && this.hasTable(BLOCK_TABLES.tri)
      && this.metadata("block_index_version") === BLOCK_INDEX_VERSION;
    const fts = (tables: IndexTables) => ({
      insertTri: prepare(`INSERT INTO ${tables.tri}(rowid, text) VALUES (?, ?)`),
      insertUni: prepare(`INSERT INTO ${tables.uni}(rowid, text) VALUES (?, ?)`),
      insertBi: prepare(`INSERT INTO ${tables.bi}(rowid, text) VALUES (?, ?)`),
      deleteTri: prepare(`DELETE FROM ${tables.tri} WHERE rowid = ?`),
      deleteUni: prepare(`DELETE FROM ${tables.uni} WHERE rowid = ?`),
      deleteBi: prepare(`DELETE FROM ${tables.bi} WHERE rowid = ?`),
    });
    return {
      upsertDocument: prepare(`INSERT INTO documents
        (path, filename, extension, size_bytes, modified_at_ms, indexed_at_ms, status, error_code, error_message, parse_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET filename=excluded.filename, extension=excluded.extension,
        size_bytes=excluded.size_bytes, modified_at_ms=excluded.modified_at_ms,
        indexed_at_ms=excluded.indexed_at_ms, status=excluded.status,
        error_code=excluded.error_code, error_message=excluded.error_message,
        parse_version=excluded.parse_version`),
      bindRoot: prepare("INSERT INTO document_roots(document_id, root_path) VALUES (?, ?) ON CONFLICT(document_id) DO UPDATE SET root_path=excluded.root_path"),
      legacy: legacyContent ? {
        deleteBlocks: prepare("DELETE FROM blocks WHERE document_id = ?"),
        deletePayloads: prepare("DELETE FROM document_payloads WHERE document_id = ?"),
        deletePayloadBlocks: prepare("DELETE FROM document_payload_blocks WHERE document_id = ?"),
        insertBlock: prepare("INSERT INTO blocks (document_id, ordinal, heading, content, location_kind, location_value) VALUES (?, ?, ?, ?, ?, ?)"),
        lastId: prepare("SELECT last_insert_rowid() AS id"),
        insertPayload: prepare("INSERT INTO document_payloads (document_id, ordinal, payload) VALUES (?, ?, ?)"),
        insertPayloadBlock: prepare("INSERT INTO document_payload_blocks (document_id, payload_ordinal, block_id) VALUES (?, ?, ?)"),
        documentBlockIds: prepare("SELECT id FROM blocks WHERE document_id = ?"),
      } : null,
      insertChunk: prepare("INSERT INTO document_chunks(document_id, ordinal, text, layout) VALUES (?, ?, ?, ?) RETURNING id"),
      documentChunkIds: prepare("SELECT id FROM document_chunks WHERE document_id = ?"),
      deleteChunks: prepare("DELETE FROM document_chunks WHERE document_id = ?"),
      insertMeta: prepare("INSERT INTO block_meta(document_id, ordinal, heading, location_kind, location_value) VALUES (?, ?, ?, ?, ?)"),
      deleteMeta: prepare("DELETE FROM block_meta WHERE document_id = ?"),
      hasContent: prepare(`SELECT EXISTS(SELECT 1 FROM document_chunks WHERE document_id = ?1)
        OR EXISTS(SELECT 1 FROM block_meta WHERE document_id = ?1)${legacyContent ? " OR EXISTS(SELECT 1 FROM blocks WHERE document_id = ?1)" : ""} AS found`),
      deleteMigration: prepare("DELETE FROM index_migration_documents WHERE version = ? AND document_id = ?"),
      insertMigration: prepare("INSERT OR REPLACE INTO index_migration_documents(version, document_id) VALUES (?, ?)"),
      // Pre-0.38.0 structures: maintained only while they still exist (SPEC §50.3).
      legacyBloom: legacyBloom ? {
        deletePayloadBlooms: prepare("DELETE FROM document_payload_blooms WHERE document_id = ?"),
        deleteBloom: prepare("DELETE FROM document_blooms WHERE document_id = ?"),
        insertPayloadBloom: prepare("INSERT INTO document_payload_blooms (document_id, payload_ordinal, bloom) VALUES (?, ?, ?)"),
        upsertBloom: prepare("INSERT INTO document_blooms(document_id, bloom) VALUES (?, ?) ON CONFLICT(document_id) DO UPDATE SET bloom=excluded.bloom"),
      } : null,
      legacyNgram: legacyNgram ? {
        deleteUnigrams: prepare(`DELETE FROM ${UNIGRAM_TABLE} WHERE rowid = ?`),
        deleteTrigrams: prepare(`DELETE FROM ${TRIGRAM_TABLE} WHERE rowid = ?`),
        insertUnigrams: prepare(`INSERT INTO ${UNIGRAM_TABLE}(rowid, text) VALUES (?, ?)`),
        insertTrigrams: prepare(`INSERT INTO ${TRIGRAM_TABLE}(rowid, text) VALUES (?, ?)`),
      } : null,
      blockFts: legacyBlockIndex ? fts(BLOCK_TABLES) : null,
      chunkFts: fts(CHUNK_TABLES),
      filenameFts: fts(FILENAME_TABLES),
      headingFts: fts(HEADING_TABLES),
      documentHeadingIds: prepare("SELECT id FROM search_headings WHERE document_id = ?"),
      deleteHeadings: prepare("DELETE FROM search_headings WHERE document_id = ?"),
      insertHeading: prepare("INSERT INTO search_headings(document_id, min_ordinal, heading) VALUES (?, ?, ?) RETURNING id"),
    };
  }

  private replaceNgramDocument(
    documentId: number,
    text: string,
    writes = this.writes(),
  ): void {
    const ngram = writes.legacyNgram;
    if (!ngram) return;
    ngram.deleteUnigrams.run(documentId);
    ngram.deleteTrigrams.run(documentId);
    writes.deleteMigration.run(NGRAM_MIGRATION_VERSION, documentId);
    if (!this.ngramIndexReady()) return;
    const normalized = normalizeSearchText(text);
    ngram.insertUnigrams.run(documentId, unigramText(normalized));
    ngram.insertTrigrams.run(documentId, normalized);
    writes.insertMigration.run(NGRAM_MIGRATION_VERSION, documentId);
  }

  /** Remove every search row of one document (legacy postings and block index); call before its blocks are deleted. */
  private deleteSearchRows(documentId: number, writes = this.writes()): void {
    if (writes.legacyNgram) {
      writes.legacyNgram.deleteUnigrams.run(documentId);
      writes.legacyNgram.deleteTrigrams.run(documentId);
    }
    this.deleteBlockIndexRows(documentId, writes);
  }

  /** Delete one document's index rows (filename, headings, chunks, and pre-0.39 block index), and its chunk content. */
  private deleteBlockIndexRows(documentId: number, writes = this.writes(), keepLegacyBlockRows = false): void {
    const { blockFts, chunkFts, filenameFts, headingFts } = writes;
    if (blockFts && writes.legacy && !keepLegacyBlockRows) {
      for (const { id } of writes.legacy.documentBlockIds.all(documentId) as { id: number }[]) {
        blockFts.deleteTri.run(id); blockFts.deleteUni.run(id); blockFts.deleteBi.run(id);
      }
    }
    for (const { id } of writes.documentChunkIds.all(documentId) as { id: number }[]) {
      chunkFts.deleteTri.run(id); chunkFts.deleteUni.run(id); chunkFts.deleteBi.run(id);
    }
    writes.deleteChunks.run(documentId);
    writes.deleteMeta.run(documentId);
    for (const { id } of writes.documentHeadingIds.all(documentId) as { id: number }[]) {
      headingFts.deleteTri.run(id); headingFts.deleteUni.run(id); headingFts.deleteBi.run(id);
    }
    writes.deleteHeadings.run(documentId);
    filenameFts.deleteTri.run(documentId); filenameFts.deleteUni.run(documentId); filenameFts.deleteBi.run(documentId);
    writes.deleteMigration.run(CHUNK_MIGRATION_VERSION, documentId);
  }

  /**
   * Write filename, heading, chunk and chunk index rows for one document whose
   * previous rows were already removed (SPEC §52.1). `legacyBlocks` carries the
   * block ids of a 0.38.0 block index that is still being searched.
   */
  private writeBlockIndexRows(documentId: number, filename: string, blocks: readonly TextBlock[], writes = this.writes(),
    legacyBlocks: readonly { id: number; content: string }[] = []): void {
    const insertTokens = (tables: typeof writes.chunkFts, rowid: number, normalized: string) => {
      tables.insertTri.run(rowid, normalized);
      const tokens = shortTokens(normalized);
      tables.insertUni.run(rowid, tokens.unigrams);
      if (tokens.bigrams) tables.insertBi.run(rowid, tokens.bigrams);
    };
    insertTokens(writes.filenameFts, documentId, normalizeSearchText(filename));
    const headings = new Map<string, number>();
    for (const block of blocks) {
      if (block.heading && !headings.has(block.heading)) headings.set(block.heading, block.ordinal);
      else if (block.heading && block.ordinal < headings.get(block.heading)!) headings.set(block.heading, block.ordinal);
    }
    for (const [heading, ordinal] of headings) {
      const { id } = writes.insertHeading.get(documentId, ordinal, heading) as { id: number };
      insertTokens(writes.headingFts, id, normalizeSearchText(heading));
    }
    const { chunks, meta } = buildChunks(blocks);
    for (const chunk of chunks) this.insertChunk(documentId, chunk, writes, insertTokens);
    for (const row of meta) writes.insertMeta.run(documentId, row.ordinal, row.heading, row.locationKind, row.locationValue);
    if (writes.blockFts) {
      for (const block of legacyBlocks) if (block.content) insertTokens(writes.blockFts, block.id, normalizeSearchText(block.content));
    }
    // The marker records migration progress only (SPEC §51.2).
    if (!this.chunkStoreReady()) writes.insertMigration.run(CHUNK_MIGRATION_VERSION, documentId);
  }

  private insertChunk(documentId: number, chunk: BuiltChunk, writes: ReturnType<IndexStore["writes"]>,
    insertTokens: (tables: ReturnType<IndexStore["writes"]>["chunkFts"], rowid: number, normalized: string) => void): void {
    const { id } = writes.insertChunk.get(documentId, chunk.ordinal, chunk.text, chunk.layout) as { id: number };
    insertTokens(writes.chunkFts, id, chunk.normalized);
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
      if (!(writes.hasContent.get(row.id) as { found: number }).found) {
        this.deleteBlockIndexRows(row.id, writes);
        this.writeBlockIndexRows(row.id, document.filename, [], writes);
      } else {
        // Stored blocks are untouched here; only the filename rows follow the metadata.
        const { filenameFts } = writes;
        filenameFts.deleteTri.run(row.id); filenameFts.deleteUni.run(row.id); filenameFts.deleteBi.run(row.id);
        const normalized = normalizeSearchText(document.filename);
        const tokens = shortTokens(normalized);
        filenameFts.insertTri.run(row.id, normalized);
        filenameFts.insertUni.run(row.id, tokens.unigrams);
        if (tokens.bigrams) filenameFts.insertBi.run(row.id, tokens.bigrams);
      }
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
      // Index rows are keyed by the old chunk／block ids, so remove them before the content rows.
      this.deleteBlockIndexRows(row.id, writes);
      const { legacy } = writes;
      if (legacy) {
        legacy.deletePayloadBlocks.run(row.id);
        legacy.deletePayloads.run(row.id);
        writes.legacyBloom?.deletePayloadBlooms.run(row.id);
        writes.legacyBloom?.deleteBloom.run(row.id);
        legacy.deleteBlocks.run(row.id);
      }
      if (timings) timings.deleteMs += performance.now() - deleteStarted;
      const entries: { id: number; ordinal: number; heading: string | null; content: string }[] = [];
      if (legacy) {
        for (const block of document.blocks) {
          const insertStarted = performance.now();
          legacy.insertBlock.run(row.id, block.ordinal, block.heading, "", block.locationKind, block.locationValue);
          const blockId = (legacy.lastId.get() as { id: number }).id;
          if (timings) timings.writeMs += performance.now() - insertStarted;
          entries.push({ id: blockId, ordinal: block.ordinal, heading: block.heading, content: block.content });
        }
        this.writeDocumentPayloads(row.id, entries, timings);
        if (writes.legacyBloom) {
          const bloomStarted = performance.now();
          const bloom = buildBloom(document.blocks);
          if (timings) timings.bloomMs += performance.now() - bloomStarted;
          const bloomWrite = performance.now();
          writes.legacyBloom.upsertBloom.run(row.id, bloom);
          if (timings) timings.writeMs += performance.now() - bloomWrite;
        }
        this.replaceNgramDocument(row.id, searchableDocumentText(document.filename, document.blocks), writes);
      }
      const indexStarted = performance.now();
      this.writeBlockIndexRows(row.id, document.filename, document.blocks, writes, entries);
      if (timings) timings.writeMs += performance.now() - indexStarted;
      const commitStarted = performance.now();
      this.db.exec("COMMIT");
      if (timings) timings.commitMs += performance.now() - commitStarted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Indexed document paths of `root` inside `subtree` (SPEC §56.2). */
  documentPathsUnder(root: string, subtree: string): string[] {
    const rows = this.db.prepare("SELECT path FROM documents WHERE id IN (SELECT document_id FROM document_roots WHERE root_path = ?)").all(root) as { path: string }[];
    return rows.map(row => row.path).filter(item => coversPath(subtree, item) && !samePath(subtree, item));
  }

  /**
   * Delete indexed documents that the scan no longer found. Deletions commit in
   * batches; a cancelled run keeps committed batches and the next scan
   * recomputes the rest (SPEC §51.3).
   */
  async removeMissing(
    knownPaths: Set<string>,
    root?: string,
    subtree?: string,
    protectedScopes: readonly string[] = [],
    options: RemoveMissingOptions = {},
  ): Promise<RemovalResult> {
    let protectedCount = 0;
    const rows = (root ? this.db.prepare("SELECT id, path FROM documents WHERE id IN (SELECT document_id FROM document_roots WHERE root_path = ?)").all(root) : this.db.prepare("SELECT id, path FROM documents").all()) as { id: number; path: string }[];
    const targets: number[] = [];
    for (const row of rows) {
      if (subtree && !coversPath(subtree, row.path)) continue;
      if (knownPaths.has(row.path)) continue;
      if (protectedScopes.some(scope => coversPath(scope, row.path))) {
        protectedCount++;
        continue;
      }
      targets.push(row.id);
    }
    let removed = 0;
    const report = () => options.onProgress?.({ stage: "write", message: "刪除校正", current: removed, total: targets.length });
    if (targets.length) report();
    for (let start = 0; start < targets.length; start += REMOVE_BATCH_SIZE) {
      if (options.signal?.aborted) {
        const error = new OperationCancelledError();
        error.partial = { removed, protected: protectedCount } satisfies RemovalResult;
        throw error;
      }
      const batch = targets.slice(start, start + REMOVE_BATCH_SIZE);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.removeDocumentBatch(batch);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      removed += batch.length;
      report();
      if (start + REMOVE_BATCH_SIZE < targets.length) await yieldToEvents();
    }
    return { removed, protected: protectedCount };
  }

  /** Set-based delete of one batch inside the caller's transaction; FTS rows go before the rows that locate them. */
  private removeDocumentBatch(ids: readonly number[]): void {
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS remove_batch(id INTEGER PRIMARY KEY); DELETE FROM temp.remove_batch;");
    const insert = this.db.prepare("INSERT INTO temp.remove_batch(id) VALUES (?)");
    for (const id of ids) insert.run(id);
    const documents = "SELECT id FROM temp.remove_batch";
    const blocks = `SELECT id FROM blocks WHERE document_id IN (${documents})`;
    const chunks = `SELECT id FROM document_chunks WHERE document_id IN (${documents})`;
    const headings = `SELECT id FROM search_headings WHERE document_id IN (${documents})`;
    const deletes: string[] = [
      ...(this.hasTable(BLOCK_TABLES.tri) && this.hasTable("blocks")
        ? Object.values(BLOCK_TABLES).map(table => `DELETE FROM ${table} WHERE rowid IN (${blocks})`) : []),
      ...Object.values(CHUNK_TABLES).map(table => `DELETE FROM ${table} WHERE rowid IN (${chunks})`),
      ...Object.values(HEADING_TABLES).map(table => `DELETE FROM ${table} WHERE rowid IN (${headings})`),
      ...Object.values(FILENAME_TABLES).map(table => `DELETE FROM ${table} WHERE rowid IN (${documents})`),
      ...(this.hasNgramTables() ? [UNIGRAM_TABLE, TRIGRAM_TABLE].map(table => `DELETE FROM ${table} WHERE rowid IN (${documents})`) : []),
      `DELETE FROM search_headings WHERE document_id IN (${documents})`,
      `DELETE FROM documents WHERE id IN (${documents})`,
      "DELETE FROM temp.remove_batch",
    ];
    for (const sql of deletes) this.db.exec(sql);
  }

  removeDocument(filePath: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT id FROM documents WHERE path = ?").get(filePath) as { id: number } | undefined;
      if (row) this.deleteSearchRows(row.id);
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
      if (root) for (const document of documents) this.deleteSearchRows(document.id);
      else this.clearAllSearchRows();
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

  // ---------------------------------------------------------------------------
  // Block index queries (SPEC §50.2). Callers own ranking; these return
  // candidates (filename／heading, verified by the caller on plain text) or
  // exact content hits (verified here only for the U+0000 fallback).

  private indexQuery<T>(sql: string, parameters: (string | number)[], trace?: SearchTraceRecorder): T[] {
    const started = performance.now();
    try {
      const rows = this.db.prepare(sql).all(...parameters) as T[];
      trace?.increment("indexPostingRows", rows.length);
      return rows;
    } finally {
      trace?.addPhase("postingsLookup", performance.now() - started);
    }
  }

  /** Document ids whose normalized filename may contain the term (superset). */
  indexFilenameCandidates(term: string, trace?: SearchTraceRecorder): number[] {
    const { table, match } = indexMatch(term, false);
    const name = FILENAME_TABLES[table];
    return this.indexQuery<{ id: number }>(`SELECT rowid AS id FROM ${name} WHERE ${name} MATCH ?`, [match], trace).map(row => Number(row.id));
  }

  /** Distinct headings per document (with their first ordinal) that may contain the term (superset). */
  indexHeadingCandidates(term: string, trace?: SearchTraceRecorder): { documentId: number; ordinal: number; heading: string }[] {
    const { table, match } = indexMatch(term, false);
    const name = HEADING_TABLES[table];
    return this.indexQuery<{ documentId: number; ordinal: number; heading: string }>(`SELECT h.document_id AS documentId,
      h.min_ordinal AS ordinal, h.heading FROM ${name} JOIN search_headings AS h ON h.id = ${name}.rowid WHERE ${name} MATCH ?`,
    [match], trace).map(row => ({ documentId: Number(row.documentId), ordinal: Number(row.ordinal), heading: row.heading }));
  }

  /**
   * Exact content hits: blocks whose normalized content contains every term.
   * `first` returns the smallest matching ordinal per document; `blocks`
   * returns every matching block of the restricted documents.
   */
  indexContentFirstBlocks(terms: readonly string[], restrict?: readonly number[], trace?: SearchTraceRecorder): Map<number, number> {
    const { sql, parameters, exact, single } = this.contentHitSql(terms, restrict);
    const first = new Map<number, number>();
    if (exact) {
      const restriction = restrict ? " AND b.document_id IN (SELECT value FROM json_each(?))" : "";
      // One term joins the FTS cursor directly; a CTE would first materialize every rowid.
      const rows = this.indexQuery<{ documentId: number; ordinal: number; blocks: number }>(single
        ? `SELECT b.document_id AS documentId, min(b.ordinal) AS ordinal, count(*) AS blocks
          FROM ${single} JOIN blocks AS b ON b.id = ${single}.rowid WHERE ${single} MATCH ?${restriction} GROUP BY b.document_id`
        : `${sql} SELECT b.document_id AS documentId, min(b.ordinal) AS ordinal, count(*) AS blocks
          FROM hits JOIN blocks AS b ON b.id = hits.id${restrict ? " WHERE b.document_id IN (SELECT value FROM json_each(?))" : ""}
          GROUP BY b.document_id`, parameters, trace);
      for (const row of rows) {
        first.set(Number(row.documentId), Number(row.ordinal));
        trace?.increment("indexCandidateBlocks", Number(row.blocks));
      }
      return first;
    }
    for (const block of this.indexContentBlocks(terms, restrict, trace)) {
      if (!first.has(block.documentId)) first.set(block.documentId, block.ordinal);
    }
    return first;
  }

  indexContentBlocks(terms: readonly string[], restrict?: readonly number[], trace?: SearchTraceRecorder):
    { documentId: number; ordinal: number; heading: string | null }[] {
    const { sql, parameters, exact } = this.contentHitSql(terms, restrict);
    const rows = this.indexQuery<{ id: number; documentId: number; ordinal: number; heading: string | null }>(`${sql}
      SELECT b.id, b.document_id AS documentId, b.ordinal, b.heading
      FROM hits JOIN blocks AS b ON b.id = hits.id${restrict ? " WHERE b.document_id IN (SELECT value FROM json_each(?))" : ""}
      ORDER BY b.document_id, b.ordinal`, parameters, trace)
      .map(row => ({ id: Number(row.id), documentId: Number(row.documentId), ordinal: Number(row.ordinal), heading: row.heading }));
    trace?.increment("indexCandidateBlocks", rows.length);
    if (exact) return rows;
    const started = performance.now();
    const verified: typeof rows = [];
    const byDocument = new Map<number, typeof rows>();
    for (const row of rows) {
      let list = byDocument.get(row.documentId);
      if (!list) byDocument.set(row.documentId, list = []);
      list.push(row);
    }
    for (const [documentId, list] of byDocument) {
      const contents = this.blockContents(documentId, list.map(row => row.id));
      for (const row of list) {
        trace?.increment("indexVerifiedBlocks");
        const content = normalizeSearchText(contents.get(row.id) ?? "");
        if (terms.every(term => content.includes(term))) verified.push(row);
      }
    }
    trace?.addPhase("exactVerification", performance.now() - started);
    return verified;
  }

  private contentHitSql(terms: readonly string[], restrict?: readonly number[]):
    { sql: string; parameters: string[]; exact: boolean; single: string | undefined } {
    const matches = [...new Set(terms)].map(term => indexMatch(term, true));
    const hits = matches.map(({ table }) => `SELECT rowid AS id FROM ${BLOCK_TABLES[table]} WHERE ${BLOCK_TABLES[table]} MATCH ?`).join(" INTERSECT ");
    const parameters = matches.map(match => match.match);
    if (restrict) parameters.push(JSON.stringify(restrict));
    return { sql: `WITH hits(id) AS (${hits})`, parameters, exact: matches.every(match => match.exact),
      single: matches.length === 1 ? BLOCK_TABLES[matches[0]!.table] : undefined };
  }

  /** Complete content of specific blocks, reading only their owning payloads. */
  private blockContents(documentId: number, blockIds: readonly number[]): Map<number, string> {
    const wanted = new Set(blockIds);
    const payloads = this.db.prepare(`SELECT p.payload FROM document_payloads AS p WHERE p.document_id = ? AND p.ordinal IN (
        SELECT DISTINCT m.payload_ordinal FROM json_each(?) AS j
        CROSS JOIN document_payload_blocks AS m INDEXED BY document_payload_blocks_document_block
        WHERE m.document_id = ? AND m.block_id = j.value) ORDER BY p.ordinal`)
      .all(documentId, JSON.stringify(blockIds), documentId) as { payload: Uint8Array }[];
    const contents = new Map<number, string>();
    for (const payload of payloads) {
      for (const [id, fragment] of JSON.parse(brotliDecompressSync(payload.payload).toString("utf8")) as [number, string][]) {
        if (wanted.has(id)) contents.set(id, (contents.get(id) ?? "") + fragment);
      }
    }
    return contents;
  }

  /** Document rows for ids, restricted to the type／root／subtree scope. */
  indexDocuments(ids: Iterable<number>, types?: readonly string[], root?: string, subtree?: string,
    trace?: SearchTraceRecorder): StoredDocumentRow[] {
    const started = performance.now();
    const base = this.documentWhere(types, root, subtree);
    const rows = this.db.prepare(`SELECT id, path, filename, extension, size_bytes, modified_at_ms, status FROM documents${
      base.sql ? `${base.sql} AND` : " WHERE"} id IN (SELECT value FROM json_each(?))`)
      .all(...base.values, JSON.stringify([...ids])) as unknown as StoredDocumentRow[];
    trace?.addPhase("documentEnumeration", performance.now() - started);
    return rows;
  }

  /** Trace-only scope size; cached until another commit changes the index (PRAGMA data_version). */
  documentsInScope(types?: readonly string[], root?: string, subtree?: string): number {
    // data_version covers other connections' commits; total_changes() covers this connection's own writes.
    const changes = Number((this.db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes);
    const key = `${this.dataVersion()} ${changes} ${JSON.stringify([types ?? null, root ?? null, subtree ?? null])}`;
    const cached = this.scopeCounts.get(key);
    if (cached !== undefined) return cached;
    const base = this.documentWhere(types, root, subtree);
    const count = Number((this.db.prepare(`SELECT count(*) AS count FROM documents${base.sql}`).get(...base.values) as { count: number }).count);
    if (this.scopeCounts.size > 32) this.scopeCounts.clear();
    this.scopeCounts.set(key, count);
    return count;
  }

  /** Heading and location of representative blocks, keyed `${documentId}:${ordinal}`. */
  indexBlockDisplay(keys: readonly (readonly [number, number])[]): Map<string, { heading: string | null; location: string }> {
    const display = new Map<string, { heading: string | null; location: string }>();
    const statement = this.db.prepare(`SELECT b.document_id AS documentId, b.ordinal, b.heading, b.location_value AS location
      FROM json_each(?) AS j JOIN blocks AS b ON b.document_id = j.value ->> 0 AND b.ordinal = j.value ->> 1`);
    for (let start = 0; start < keys.length; start += 50_000) {
      for (const row of statement.all(JSON.stringify(keys.slice(start, start + 50_000))) as { documentId: number; ordinal: number; heading: string | null; location: string }[]) {
        display.set(`${row.documentId}:${row.ordinal}`, { heading: row.heading, location: row.location });
      }
    }
    return display;
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
    // SQLite ends an FTS5 query string at U+0000: such trigrams cannot be
    // expressed, so use the conservative Bloom path instead of failing (D081).
    if (terms.some(term => [...normalizeSearchText(term)].length >= 3 && term.includes("\u0000"))) return undefined;
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

  // ---------------------------------------------------------------------------
  // Chunk store reads (SPEC §52). Callers verify candidates; nothing here ranks.

  /** Candidate chunks per document whose index text may contain the normalized term (superset), in chunk order. */
  chunkCandidates(term: string, trace?: SearchTraceRecorder): Map<number, number[]> {
    const { table, match } = indexMatch(term, false);
    const name = CHUNK_TABLES[table];
    const rows = this.indexQuery<{ id: number; documentId: number }>(`SELECT c.id, c.document_id AS documentId
      FROM ${name} JOIN document_chunks AS c ON c.id = ${name}.rowid WHERE ${name} MATCH ? ORDER BY c.document_id, c.ordinal`, [match], trace);
    const byDocument = new Map<number, number[]>();
    for (const row of rows) {
      const documentId = Number(row.documentId);
      let list = byDocument.get(documentId);
      if (!list) byDocument.set(documentId, list = []);
      list.push(Number(row.id));
    }
    trace?.increment("indexCandidateChunks", rows.length);
    return byDocument;
  }

  /** Original blocks of one chunk. */
  chunkBlocks(chunkId: number, trace?: SearchTraceRecorder): ChunkBlock[] {
    const started = performance.now();
    const row = (this.chunkByIdSql ??= this.db.prepare("SELECT text, layout FROM document_chunks WHERE id = ?"))
      .get(chunkId) as { text: Uint8Array; layout: Uint8Array } | undefined;
    if (!row) return [];
    const blocks = decodeChunk(row.text, row.layout);
    trace?.increment("indexVerifiedChunks");
    trace?.increment("indexVerifiedBytes", row.text.length);
    trace?.addPhase("payloadLookup", performance.now() - started);
    return blocks;
  }

  /** Ordinals of the chunk's blocks whose normalized content contains each term (see blocksContaining). */
  chunkTermHits(chunkId: number, terms: readonly string[], firstOnly: boolean, trace?: SearchTraceRecorder): Map<string, number[]> {
    const started = performance.now();
    const row = (this.chunkByIdSql ??= this.db.prepare("SELECT text, layout FROM document_chunks WHERE id = ?"))
      .get(chunkId) as { text: Uint8Array; layout: Uint8Array } | undefined;
    if (!row) return new Map(terms.map(term => [term, []]));
    trace?.increment("indexVerifiedChunks");
    trace?.increment("indexVerifiedBytes", row.text.length);
    const hits = blocksContaining(row.text, row.layout, terms, firstOnly);
    trace?.increment("exactTextMs", performance.now() - started);
    return hits;
  }

  /** Every chunk id of one document in block order. */
  documentChunkIds(documentId: number): number[] {
    return (this.db.prepare("SELECT id FROM document_chunks WHERE document_id = ? ORDER BY ordinal").all(documentId) as { id: number }[])
      .map(row => Number(row.id));
  }

  /** Heading and location of one block: stored metadata, else the derived plain-line values (SPEC §52.1). */
  blockDisplay(documentId: number, ordinal: number): { heading: string | null; location_kind: TextBlock["locationKind"]; location: string } {
    const row = (this.blockMetaSql ??= this.db.prepare("SELECT heading, location_kind, location_value FROM block_meta WHERE document_id = ? AND ordinal = ?"))
      .get(documentId, ordinal) as { heading: string | null; location_kind: TextBlock["locationKind"]; location_value: string } | undefined;
    return row ? { heading: row.heading, location_kind: row.location_kind, location: row.location_value }
      : { heading: null, location_kind: "line", location: derivedLocation(ordinal) };
  }

  /** All blocks of one document rebuilt from chunks and stored metadata, in ordinal order. */
  documentBlocks(documentId: number, trace?: SearchTraceRecorder): StoredBlockRow[] {
    const contents = new Map<number, string>();
    for (const id of this.documentChunkIds(documentId)) for (const block of this.chunkBlocks(id, trace)) contents.set(block.ordinal, block.content);
    const meta = new Map((this.db.prepare("SELECT ordinal, heading, location_kind, location_value FROM block_meta WHERE document_id = ?")
      .all(documentId) as { ordinal: number; heading: string | null; location_kind: TextBlock["locationKind"]; location_value: string }[])
      .map(row => [Number(row.ordinal), row]));
    const ordinals = [...new Set([...contents.keys(), ...meta.keys()])].sort((a, b) => a - b);
    trace?.increment("blocksMetadataRows", ordinals.length);
    return ordinals.map(ordinal => {
      const row = meta.get(ordinal);
      return { ordinal, heading: row ? row.heading : null, content: contents.get(ordinal) ?? "",
        location_kind: row ? row.location_kind : "line", location_value: row ? row.location_value : derivedLocation(ordinal) };
    });
  }

  candidateByPath(filePath: string, trace?: SearchTraceRecorder): SearchCandidate | undefined {
    const started = performance.now();
    const document = this.db.prepare("SELECT id, path, filename, extension, size_bytes, modified_at_ms, status FROM documents WHERE path = ?")
      .get(filePath) as StoredDocumentRow | undefined;
    trace?.addPhase("documentEnumeration", performance.now() - started);
    if (!document) return undefined;
    trace?.increment("documentsConsidered");
    trace?.increment("documentsAfterPruning");
    const blocks = this.chunkStoreReady() ? this.documentBlocks(document.id, trace) : this.blocksFor(document.id, trace);
    return { document, blocks };
  }

  blockSource(documentId: number, ordinal: number, source: "heading" | "content", trace?: SearchTraceRecorder): string | null {
    if (this.chunkStoreReady()) {
      if (source === "heading") return this.blockDisplay(documentId, ordinal).heading;
      // The chunk holding a block is the last one starting at or before its ordinal.
      const chunk = this.db.prepare("SELECT id FROM document_chunks WHERE document_id = ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1")
        .get(documentId, ordinal) as { id: number } | undefined;
      if (!chunk) return null;
      return this.chunkBlocks(Number(chunk.id), trace).find(block => block.ordinal === ordinal)?.content ?? null;
    }
    const started = performance.now();
    const blockQuery = this.db.prepare("SELECT id, heading FROM blocks WHERE document_id = ? AND ordinal = ?");
    trace?.recordPayloadSql("blocksMetadata", "prepare", performance.now() - started);
    let executeStarted = performance.now();
    const block = blockQuery.get(documentId, ordinal) as { id: number; heading: string | null } | undefined;
    trace?.recordPayloadSql("blocksMetadata", "execute", performance.now() - executeStarted);
    if (block) trace?.increment("blocksMetadataRows");
    // Headings are stored in plain text; only content needs the payload docstore.
    if (!block || source === "heading") {
      trace?.addPhase("payloadLookup", performance.now() - started);
      return block ? block.heading : null;
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
      if (blockSource.ordinal === ordinal) return blockSource.content;
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
    const legacy = writes.legacy;
    if (!legacy) throw new Error("payload docstore 已由區段儲存取代。");
    let batch: [number, string][] = []; let bytes = 2; let ordinal = 0;
    const flush = () => {
      if (!batch.length) return;
      const compressStarted = performance.now();
      const payload = compressText(JSON.stringify(batch));
      if (timings) timings.compressMs += performance.now() - compressStarted;
      let bloom: Uint8Array | undefined;
      if (writes.legacyBloom) {
        const bloomStarted = performance.now();
        const byBlock = new Map<number, string>();
        for (const [id, content] of batch) byBlock.set(id, (byBlock.get(id) ?? "") + content);
        bloom = buildBloom([...byBlock.values()].map((content, index) => ({ ordinal: index, heading: null, content, locationKind: "line" as const, locationValue: "" })));
        if (timings) timings.bloomMs += performance.now() - bloomStarted;
      }
      const writeStarted = performance.now();
      legacy.insertPayload.run(documentId, ordinal, payload);
      for (const id of new Set(batch.map(item => item[0]))) legacy.insertPayloadBlock.run(documentId, ordinal, id);
      if (bloom) writes.legacyBloom!.insertPayloadBloom.run(documentId, ordinal, bloom);
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
    const legacy = this.writes().legacy;
    if (!legacy) throw new Error("舊索引缺少 payload docstore 資料表。");
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
        legacy.deletePayloadBlocks.run(document.id);
        legacy.deletePayloads.run(document.id);
        writes.legacyBloom?.deletePayloadBlooms.run(document.id);
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
      this.db.exec("DELETE FROM index_migration_documents WHERE version = 'content_storage_2'");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every block of one document with its stored id and complete content (full payload read). */
  private documentBlocksWithIds(documentId: number): (StoredBlockRow & { id: number; locationKind: TextBlock["locationKind"]; locationValue: string })[] {
    const blocks = (this.db.prepare(`SELECT id, ordinal, heading, content, location_kind, location_value
      FROM blocks WHERE document_id = ? ORDER BY ordinal`).all(documentId) as unknown as StoredBlockDatabaseRow[])
      .map(block => ({ ...block, locationKind: block.location_kind, locationValue: block.location_value }));
    const payloads = this.db.prepare("SELECT payload FROM document_payloads WHERE document_id = ? ORDER BY ordinal")
      .all(documentId) as { payload: Uint8Array }[];
    const contents = new Map<number, string>();
    for (const payload of payloads) {
      for (const [id, fragment] of JSON.parse(brotliDecompressSync(payload.payload).toString("utf8")) as [number, string][]) {
        contents.set(id, (contents.get(id) ?? "") + fragment);
      }
    }
    return blocks.map(block => ({ ...block, content: contents.get(block.id) ?? block.content ?? "" }));
  }

  /**
   * SPEC §50.3: build the block index document by document. Each batch commits
   * rows together with `block_index_1` markers, so cancellation keeps committed
   * documents and the next writer resumes. Payload bytes are never rewritten.
   */
  private async migrateChunkStore(options: UpgradeOptions): Promise<void> {
    const message = "建立區段儲存與搜尋索引";
    const documents = this.db.prepare(`SELECT d.id, d.path, d.filename FROM documents d
      WHERE NOT EXISTS (SELECT 1 FROM index_migration_documents m
        WHERE m.version = ? AND m.document_id = d.id)
      ORDER BY d.id`).all(CHUNK_MIGRATION_VERSION) as { id: number; path: string; filename: string }[];
    const total = Number((this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count);
    let completed = total - documents.length;
    options.onProgress?.({ stage: "upgrade", message, current: completed, total });
    const writes = this.writes();
    // Small documents share a transaction (most are filename-only); a batch
    // closes after 256 documents or about 16 M characters of block text.
    let index = 0;
    while (index < documents.length) {
      throwIfAborted(options.signal);
      const batch: { document: typeof documents[number]; blocks: ReturnType<IndexStore["documentBlocksWithIds"]> }[] = [];
      let characters = 0;
      while (index < documents.length && batch.length < 256 && characters < 16_000_000) {
        const document = documents[index++]!;
        const blocks = this.documentBlocksWithIds(document.id);
        characters += blocks.reduce((sum, block) => sum + block.content.length, 0);
        batch.push({ document, blocks });
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const { document, blocks } of batch) {
          // A 0.38.0 block index keeps serving read-only search until completion; its rows are already
          // current, so only chunk, filename and heading rows are (re)written here.
          this.deleteBlockIndexRows(document.id, writes, true);
          this.writeBlockIndexRows(document.id, document.filename, blocks.map(block => ({ ordinal: block.ordinal, heading: block.heading,
            content: block.content, locationKind: block.locationKind, locationValue: block.locationValue })), writes);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      completed += batch.length;
      options.onProgress?.({ stage: "upgrade", message, current: completed, total, path: batch.at(-1)!.document.path });
      await yieldToEvents();
    }
    throwIfAborted(options.signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of PRE_CHUNK_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      this.db.exec(`DELETE FROM index_migration_documents;
        DELETE FROM metadata WHERE key IN ('payload_bloom_version', 'ngram_index_version', 'block_index_version');`);
      this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('chunk_store_version', ?)").run(CHUNK_STORE_VERSION);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Statements prepared against the dropped tables must not be reused.
    this.cachedWrites = null;
    this.shortTermsReady = false;
    this.blockIndexReadyCache = false;
    options.onProgress?.({ stage: "upgrade", message: "區段儲存升級完成", current: total, total });
    if (this.freePageRatio() > 0.5) {
      options.onProgress?.({ stage: "upgrade", message: "壓縮資料庫" });
      this.db.exec("VACUUM");
    }
  }

  /** Share of the database file that is free pages (reclaimable by VACUUM). */
  freePageRatio(): number {
    const pages = Number((this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const free = Number((this.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    return pages ? free / pages : 0;
  }

  /** Rewrite the database without free pages (SPEC §52.4 `compact`); the caller holds the writer lock. */
  compact(): void {
    if (this.readOnly) throw new Error("唯讀索引不能壓縮。");
    this.db.exec("VACUUM");
  }

  /** Empty every search structure (full clear／rebuild). */
  private clearAllSearchRows(): void {
    const tables: string[] = [...Object.values(CHUNK_TABLES), ...Object.values(FILENAME_TABLES), ...Object.values(HEADING_TABLES)];
    if (this.hasTable(BLOCK_TABLES.tri)) tables.push(...Object.values(BLOCK_TABLES));
    if (this.hasNgramTables()) tables.push(UNIGRAM_TABLE, TRIGRAM_TABLE);
    for (const table of tables) this.db.exec(`INSERT INTO ${table}(${table}) VALUES ('delete-all')`);
    this.db.exec(`DELETE FROM search_headings; DELETE FROM document_chunks; DELETE FROM block_meta;
      DELETE FROM index_migration_documents WHERE version IN ('${BLOCK_MIGRATION_VERSION}', '${NGRAM_MIGRATION_VERSION}', '${CHUNK_MIGRATION_VERSION}');`);
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
