// Disposable search-architecture prototype (see README.md). Never writes the
// production index: the snapshot is opened read-only and every variant lives
// in its own database file under PROTOTYPE_DATA_DIR.
import { brotliDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const dataDir = process.env.PROTOTYPE_DATA_DIR ?? "C:/Users/mains/seekah-prototype-data";
export const snapshotPath = path.join(dataDir, "snapshot.db");
export const variantPaths = {
  fields: path.join(dataDir, "fields.db"),
  B: path.join(dataDir, "b.db"),
  C1: path.join(dataDir, "c1.db"),
  C2: path.join(dataDir, "c2.db"),
};
export const repoDir = path.resolve(import.meta.dirname, "../..");
export const distDir = path.join(repoDir, "dist", "src");

// Product modules (compiled current build) are only used as the A oracle and
// for the unchanged makeSnippet(); src/ is never imported or modified.
export async function productModules() {
  const store = await import(pathToFileURL(path.join(distDir, "store.js")).href);
  const search = await import(pathToFileURL(path.join(distDir, "search.js")).href);
  return { IndexStore: store.IndexStore, collectHits: search.collectHits, materializeHits: search.materializeHits,
    makeSnippet: search.makeSnippet };
}

export function normalize(value) {
  return value.normalize("NFKC").toLowerCase();
}

const hex = character => character.codePointAt(0).toString(16);
export const uniToken = character => `u${hex(character)}`;
export const biToken = (left, right) => `b${hex(left)}x${hex(right)}`;

export function uniTokens(normalized, dedupe) {
  const tokens = [...normalized].map(uniToken);
  return (dedupe ? [...new Set(tokens)] : tokens).join(" ");
}

export function biTokens(normalized, dedupe) {
  const characters = [...normalized];
  const tokens = [];
  for (let index = 0; index + 1 < characters.length; index++) tokens.push(biToken(characters[index], characters[index + 1]));
  return (dedupe ? [...new Set(tokens)] : tokens).join(" ");
}

export function trigrams(normalized) {
  const characters = [...normalized];
  const grams = [];
  for (let index = 0; index + 3 <= characters.length; index++) grams.push(characters.slice(index, index + 3).join(""));
  return grams;
}

export const ftsString = value => `"${value.replaceAll('"', '""')}"`;

export function openSnapshot() {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

export function openVariant(file, { readOnly = true } = {}) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (readOnly) db.exec("PRAGMA query_only = ON");
  return db;
}

export function newMetrics() {
  return {
    postingMs: 0, postingRows: 0, candidateDocs: 0, candidateBlocks: 0, candidatePayloads: 0,
    payloadReads: 0, compressedBytes: 0, decompressedBytes: 0, decompressMs: 0,
    verifiedBlocks: 0, verifiedDocs: 0, falsePositiveBlocks: 0, falsePositiveDocs: 0,
    verificationMs: 0, rankingMs: 0, snippetMs: 0, snippetPayloadReads: 0, totalMs: 0, results: 0,
  };
}

/** Decode payload rows into complete block contents for the wanted block ids (all when undefined). */
export function decodePayloads(payloads, wanted, metrics, snippet = false) {
  const contents = new Map();
  for (const payload of payloads) {
    const started = performance.now();
    const decompressed = brotliDecompressSync(payload.payload);
    const values = JSON.parse(decompressed.toString("utf8"));
    if (metrics) {
      metrics.decompressMs += performance.now() - started;
      if (snippet) metrics.snippetPayloadReads++;
      else { metrics.payloadReads++; metrics.compressedBytes += payload.payload.byteLength; metrics.decompressedBytes += decompressed.byteLength; }
    }
    for (const [id, text] of values) {
      if (wanted && !wanted.has(id)) continue;
      contents.set(id, (contents.get(id) ?? "") + text);
    }
  }
  return contents;
}

/** Prepared helpers over the read-only snapshot shared by every non-A engine. */
export class SnapshotReader {
  constructor(db) {
    this.db = db;
    this.blockMeta = db.prepare("SELECT id, ordinal, heading, content, location_value FROM blocks WHERE document_id = ? ORDER BY ordinal");
    this.blockByOrdinal = db.prepare("SELECT id, heading, location_value FROM blocks WHERE document_id = ? AND ordinal = ?");
    this.allPayloads = db.prepare("SELECT ordinal, payload FROM document_payloads WHERE document_id = ? ORDER BY ordinal");
    this.owningPayloads = db.prepare(`SELECT p.ordinal, p.payload FROM document_payloads p
      WHERE p.document_id = ? AND p.ordinal IN (
        SELECT DISTINCT m.payload_ordinal FROM json_each(?) AS j
        CROSS JOIN document_payload_blocks AS m INDEXED BY document_payload_blocks_document_block
        WHERE m.document_id = ? AND m.block_id = j.value)
      ORDER BY p.ordinal`);
    this.documentsByIds = db.prepare(`SELECT id, path, filename, extension, modified_at_ms, status FROM documents
      WHERE id IN (SELECT value FROM json_each(?))`);
  }

  /** Complete block contents for specific block ids of one document (reads only their owning payloads). */
  blockContents(documentId, blockIds, metrics, snippet = false) {
    const payloads = this.owningPayloads.all(documentId, JSON.stringify(blockIds), documentId);
    const contents = decodePayloads(payloads, new Set(blockIds), metrics, snippet);
    for (const id of blockIds) if (!contents.has(id)) contents.set(id, "");
    return contents;
  }

  /** All blocks of one document with reconstructed content (ground truth / build input). */
  documentBlocks(documentId, metrics) {
    const blocks = this.blockMeta.all(documentId);
    const payloads = this.allPayloads.all(documentId);
    if (!payloads.length) return blocks.map(block => ({ ...block }));
    const contents = decodePayloads(payloads, undefined, metrics);
    return blocks.map(block => ({ ...block, content: contents.get(block.id) ?? block.content ?? "" }));
  }

  documents(ids) {
    const rows = [];
    // json_each keeps one statement for any list size.
    for (let start = 0; start < ids.length; start += 200_000) {
      rows.push(...this.documentsByIds.all(JSON.stringify(ids.slice(start, start + 200_000))));
    }
    return rows;
  }
}

export const comparePath = (left, right) => left === right ? 0 : left < right ? -1 : 1;
export const relevanceOrder = (a, b) => b.rank - a.rank || b.modifiedAtMs - a.modifiedAtMs || comparePath(a.path, b.path);

/** Ground truth for one document, phrase mode, field=all: identical rules to search.ts rankDocument(). */
export function truthRank(reader, document, query) {
  const filename = normalize(document.filename);
  if (filename === query) return { rank: 4, sourceKind: "filename", ordinal: null };
  if (filename.includes(query)) return { rank: 3, sourceKind: "filename", ordinal: null };
  let heading; let content;
  for (const block of reader.documentBlocks(document.id)) {
    if (!heading && block.heading && normalize(block.heading).includes(query)) heading = block;
    if (!content && normalize(block.content).includes(query)) content = block;
    if (heading) break;
  }
  const block = heading ?? content;
  if (!block) return undefined;
  return { rank: heading ? 2 : 1, sourceKind: heading ? "heading" : "content", ordinal: block.ordinal,
    heading: block.heading ?? null, location: block.location_value ?? null };
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] : null;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) values[key.slice(2)] = true;
    else { values[key.slice(2)] = next; index++; }
  }
  return values;
}
