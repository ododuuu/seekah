import { DatabaseSync } from "node:sqlite";
import type { DocumentRecord, DocumentStatus } from "../src/model.js";
import { IndexStore } from "../src/store.js";

function reshape(databasePath: string, sql: string): IndexStore {
  new IndexStore(databasePath).close();
  const db = new DatabaseSync(databasePath);
  try { db.exec(sql); } finally { db.close(); }
  // Reopening a non-chunk index recreates blocks, payloads and the older search tables;
  // writes then keep both shapes current until upgrade() migrates it (SPEC §52.4).
  return new IndexStore(databasePath);
}

/**
 * Open a new writable store shaped like a pre-0.38.0 index: payload docstore,
 * Bloom summaries and document-level unigram／trigram postings. Search uses the
 * SPEC §48 path until upgrade() migrates it to the chunk store.
 */
export function createLegacyStore(databasePath: string): IndexStore {
  return reshape(databasePath, `DELETE FROM metadata WHERE key IN ('chunk_store_version', 'block_index_version');
    INSERT OR REPLACE INTO metadata(key, value) VALUES ('payload_bloom_version', '2'), ('ngram_index_version', '1');`);
}

/** Open a new writable store shaped like a 0.38 index: payload docstore plus the block index (SPEC §50 search). */
export function createBlockIndexStore(databasePath: string): IndexStore {
  return reshape(databasePath, `DELETE FROM metadata WHERE key = 'chunk_store_version';
    INSERT OR REPLACE INTO metadata(key, value) VALUES ('block_index_version', '1');`);
}

const BLOCK_INDEX_TABLES = ["search_block_trigrams", "search_block_unigrams", "search_block_bigrams",
  "search_filename_trigrams", "search_filename_unigrams", "search_filename_bigrams",
  "search_heading_trigrams", "search_heading_unigrams", "search_heading_bigrams"];

/** Remove every block index row and marker, as an index written before 0.38.0 would look. */
export function clearBlockIndex(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    for (const table of BLOCK_INDEX_TABLES) db.exec(`INSERT INTO ${table}(${table}) VALUES ('delete-all')`);
    db.exec(`DELETE FROM search_headings; DELETE FROM index_migration_documents WHERE version = 'block_index_1';
      DELETE FROM metadata WHERE key = 'block_index_version';`);
  } finally { db.close(); }
}

/**
 * Rewrite an existing chunk-store index into the pre-0.39.0 shape (payload docstore,
 * Bloom and document postings, no chunks) with the same documents, ids and roots.
 */
export function downgradeToPreChunk(databasePath: string): void {
  const reader = new IndexStore(databasePath, { readOnly: true });
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  let documents: { record: DocumentRecord; root: string | undefined }[];
  try {
    const rows = raw.prepare(`SELECT d.id, d.path, d.filename, d.extension, d.size_bytes, d.modified_at_ms, d.status,
      d.error_code, d.error_message, r.root_path FROM documents d LEFT JOIN document_roots r ON r.document_id = d.id ORDER BY d.id`).all() as {
      id: number; path: string; filename: string; extension: string; size_bytes: number; modified_at_ms: number;
      status: DocumentStatus; error_code: string | null; error_message: string | null; root_path: string | null }[];
    documents = rows.map(row => ({ root: row.root_path ?? undefined, record: { path: row.path, filename: row.filename, extension: row.extension,
      sizeBytes: row.size_bytes, modifiedAtMs: row.modified_at_ms, status: row.status, errorCode: row.error_code, errorMessage: row.error_message,
      blocks: reader.documentBlocks(Number(row.id)).map(block => ({ ordinal: block.ordinal, heading: block.heading, content: block.content,
        locationKind: block.location_kind, locationValue: block.location_value })) } }));
  } finally { raw.close(); reader.close(); }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`DELETE FROM metadata WHERE key IN ('chunk_store_version', 'block_index_version');
      INSERT OR REPLACE INTO metadata(key, value) VALUES ('payload_bloom_version', '2'), ('ngram_index_version', '1');`);
  } finally { db.close(); }
  const writer = new IndexStore(databasePath);
  try { for (const { record, root } of documents) writer.upsert(record, root); } finally { writer.close(); }
  clearChunkStore(databasePath);
}

/** Remove every chunk row, chunk index row and chunk marker, as an index written before 0.39.0 would look. */
export function clearChunkStore(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    for (const table of ["search_chunk_trigrams", "search_chunk_unigrams", "search_chunk_bigrams"]) {
      db.exec(`INSERT INTO ${table}(${table}) VALUES ('delete-all')`);
    }
    db.exec(`DELETE FROM document_chunks; DELETE FROM block_meta;
      DELETE FROM index_migration_documents WHERE version = 'chunk_store_1';`);
  } finally { db.close(); }
}
