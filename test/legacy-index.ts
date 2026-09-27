import { DatabaseSync } from "node:sqlite";
import { IndexStore } from "../src/store.js";

/**
 * Open a new writable store shaped like a pre-0.38.0 index: Bloom summaries and
 * document-level unigram／trigram postings present and complete, block index not
 * finished. Search uses the SPEC §48 path until upgrade() migrates it (§50.3).
 */
export function createLegacyStore(databasePath: string): IndexStore {
  new IndexStore(databasePath).close();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`DELETE FROM metadata WHERE key = 'block_index_version';
      INSERT OR REPLACE INTO metadata(key, value) VALUES ('payload_bloom_version', '2'), ('ngram_index_version', '1');`);
  } finally { db.close(); }
  return new IndexStore(databasePath);
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
