// Shared helpers for the index-size research (not product code; never imports src/).
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATA_DIR = process.env.RESEARCH_DATA_DIR ?? "C:/Users/mains/seekah-prototype-data/size-2026-09-28";
export const dataPath = name => path.join(DATA_DIR, name);

export function openDb(file, options = {}) {
  const db = new DatabaseSync(file, { timeout: 0, ...options });
  if (!options.readOnly) db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -262144;");
  return db;
}

/** Same normalization as the product (store.ts normalizeSearchText). */
export const normalize = value => value.normalize("NFKC").toLowerCase();

export function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Iterate corpus documents: { docId, blocks: [{ ordinal, text }] } with normalized text, ordered by doc id. */
export function* corpusDocuments(corpus) {
  let current = null;
  for (const row of corpus.prepare("SELECT doc_id, ordinal, norm FROM blocks ORDER BY doc_id, ordinal").iterate()) {
    if (!current || current.docId !== row.doc_id) {
      if (current) yield current;
      current = { docId: row.doc_id, blocks: [] };
    }
    current.blocks.push({ ordinal: row.ordinal, text: row.norm });
  }
  if (current) yield current;
}

/**
 * Group a document's blocks into chunks of about `target` UTF-16 units. A chunk
 * is the blocks joined by "\n" plus each block's start offset, so a match can be
 * checked to lie inside a single block (the product matches within a block).
 */
export function chunkDocument(document, target) {
  const chunks = [];
  let parts = [], starts = [], ordinals = [], length = 0;
  const flush = () => {
    if (!parts.length) return;
    chunks.push({ docId: document.docId, text: parts.join("\n"), starts, ordinals });
    parts = []; starts = []; ordinals = []; length = 0;
  };
  for (const block of document.blocks) {
    if (!block.text) continue;
    if (length && length + block.text.length > target) flush();
    starts.push(length);
    ordinals.push(block.ordinal);
    parts.push(block.text);
    length += block.text.length + 1;
  }
  flush();
  return chunks;
}

/** All block ordinals of a chunk containing `query`, never counting a match that crosses a block boundary. */
export function matchChunk(chunk, query, out) {
  const { text, starts, ordinals } = chunk;
  let block = 0;
  let from = 0;
  while (true) {
    const at = text.indexOf(query, from);
    if (at < 0) return;
    while (block + 1 < starts.length && starts[block + 1] <= at) block++;
    const end = block + 1 < starts.length ? starts[block + 1] - 1 : text.length;
    if (at + query.length <= end) {
      out.push(`${chunk.docId}:${ordinals[block]}`);
      // One hit per block is enough; continue after this block.
      if (block + 1 >= starts.length) return;
      from = starts[block + 1];
      block++;
    } else {
      from = at + 1;
    }
  }
}

/** Varint-encode block start deltas (the chunk's offset table). */
export function encodeStarts(starts, ordinals) {
  const bytes = [];
  const put = value => { while (value > 127) { bytes.push((value & 127) | 128); value >>>= 7; } bytes.push(value); };
  put(starts.length);
  for (let i = 0; i < starts.length; i++) { put(starts[i] - (i ? starts[i - 1] : 0)); put(ordinals[i] - (i ? ordinals[i - 1] : 0) + 1); }
  return Buffer.from(bytes);
}

export function decodeStarts(buffer) {
  let offset = 0;
  const get = () => { let value = 0, shift = 0, byte; do { byte = buffer[offset++]; value |= (byte & 127) << shift; shift += 7; } while (byte & 128); return value >>> 0; };
  const count = get();
  const starts = new Array(count), ordinals = new Array(count);
  for (let i = 0; i < count; i++) { starts[i] = get() + (i ? starts[i - 1] : 0); ordinals[i] = get() - 1 + (i ? ordinals[i - 1] : 0); }
  return { starts, ordinals };
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}
