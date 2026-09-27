// Brute-force ground truth: every query against every document (one decode per document).
//   node truth.mjs --shard i/n          -> truth-shard-i.json
//   node truth.mjs --merge n            -> truth.jsonl (ranked, hashed, heading/location resolved)
// Rules are search.ts rankDocument() for phrase mode, field=all.
import { readFileSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { SnapshotReader, dataDir, normalize, openSnapshot, parseArgs } from "./common.mjs";
import { resultHash } from "./hash.mjs";

const args = parseArgs(process.argv.slice(2));
const queries = JSON.parse(readFileSync(path.join(dataDir, "queries.json"), "utf8")).queries;
const normalized = queries.map(query => normalize(query.raw.trim()));
// Any character absent from every query separates blocks safely (real text contains NULs).
const SEPARATOR = ["﷐", "﷑", "﷒", "￿"].find(character => !normalized.some(query => query.includes(character)));
if (!SEPARATOR) throw new Error("no free separator");
const KIND = ["filename", "heading", "content"];

if (args.shard) {
  const [index, count] = args.shard.split("/").map(Number);
  const db = openSnapshot();
  const reader = new SnapshotReader(db);
  const documents = db.prepare("SELECT id, filename FROM documents WHERE id % ? = ? ORDER BY id").all(count, index);
  const hits = normalized.map(() => []);
  const started = performance.now();
  let decodedBytes = 0;
  for (const document of documents) {
    const documentId = Number(document.id);
    const filename = normalize(document.filename);
    const blocks = reader.documentBlocks(documentId);
    // Blocks are normalized one by one (as rankDocument does) and joined with a
    // separator no query contains, so the first indexOf hit is the first block.
    const headingOrdinals = []; const headingStarts = []; const headingParts = [];
    const contentOrdinals = []; const contentStarts = []; const contentParts = [];
    let headingLength = 0; let contentLength = 0;
    for (const block of blocks) {
      if (block.heading) {
        const text = normalize(block.heading);
        headingOrdinals.push(block.ordinal); headingStarts.push(headingLength); headingParts.push(text); headingLength += text.length + 1;
      }
      const text = normalize(block.content ?? "");
      contentOrdinals.push(block.ordinal); contentStarts.push(contentLength); contentParts.push(text); contentLength += text.length + 1;
    }
    const headings = headingParts.join(SEPARATOR);
    const contents = contentParts.join(SEPARATOR);
    decodedBytes += contents.length;
    const locate = (starts, position) => {
      let low = 0; let high = starts.length - 1;
      while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= position) low = middle; else high = middle - 1; }
      return low;
    };
    for (let q = 0; q < normalized.length; q++) {
      const query = normalized[q];
      if (filename === query) { hits[q].push([documentId, 4, 0, null]); continue; }
      if (filename.includes(query)) { hits[q].push([documentId, 3, 0, null]); continue; }
      let position = headings.indexOf(query);
      if (position >= 0) { hits[q].push([documentId, 2, 1, headingOrdinals[locate(headingStarts, position)]]); continue; }
      position = contents.indexOf(query);
      if (position >= 0) hits[q].push([documentId, 1, 2, contentOrdinals[locate(contentStarts, position)]]);
    }
  }
  writeFileSync(path.join(dataDir, `truth-shard-${index}.json`), JSON.stringify({ index, count, documents: documents.length,
    ms: performance.now() - started, decodedChars: decodedBytes, hits }));
  console.log(`truth shard ${index}/${count}: ${documents.length} docs ${Math.round(performance.now() - started)} ms`);
} else if (args.merge) {
  const count = Number(args.merge);
  const shards = Array.from({ length: count }, (_, index) => JSON.parse(readFileSync(path.join(dataDir, `truth-shard-${index}.json`), "utf8")));
  const db = openSnapshot();
  const documents = new Map(db.prepare("SELECT id, path, modified_at_ms FROM documents").all().map(row => [Number(row.id), row]));
  const blockInfo = db.prepare("SELECT heading, location_value FROM blocks WHERE document_id = ? AND ordinal = ?");
  const out = createWriteStream(path.join(dataDir, "truth.jsonl"));
  for (let q = 0; q < normalized.length; q++) {
    const results = shards.flatMap(shard => shard.hits[q]).map(([documentId, rank, kind, ordinal]) => {
      const document = documents.get(documentId);
      const block = ordinal === null ? undefined : blockInfo.get(documentId, ordinal);
      return { documentId, rank, sourceKind: KIND[kind], ordinal, heading: block?.heading ?? null,
        location: block?.location_value ?? null, modifiedAtMs: document.modified_at_ms, path: document.path };
    });
    results.sort((a, b) => b.rank - a.rank || b.modifiedAtMs - a.modifiedAtMs || (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
    out.write(JSON.stringify({ id: queries[q].id, total: results.length, hash: resultHash(results),
      compact: results.map(result => [result.documentId, result.rank, KIND.indexOf(result.sourceKind), result.ordinal]) }) + "\n");
  }
  await new Promise(resolve => out.end(resolve));
  console.log(JSON.stringify({ merged: normalized.length, shardMs: shards.map(shard => Math.round(shard.ms)) }));
}
