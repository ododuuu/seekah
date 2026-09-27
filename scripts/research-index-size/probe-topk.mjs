// Early termination on the positionless trigram index: visit candidate chunks newest document first and
// stop after the first page (20 hits) or after an Elasticsearch-style count threshold (10,000 hits).
import { dataPath, openDb } from "./common.mjs";
import { decompress, matchBytes, storePath } from "./store.mjs";

const chunkChars = Number(process.argv[2] ?? 65536);
const store = openDb(storePath(chunkChars, 3), { readOnly: true });
const tri = openDb(dataPath(`index-tri-${chunkChars}.db`), { readOnly: true });
const short = openDb(dataPath(`index-short-${chunkChars}.db`), { readOnly: true });
const snapshot = openDb(dataPath("snapshot.db"), { readOnly: true });
const modified = new Map(snapshot.prepare("SELECT id, modified_at_ms FROM documents").all().map(r => [r.id, r.modified_at_ms]));
const chunkDoc = new Map(store.prepare("SELECT id, doc_id FROM chunks").all().map(r => [r.id, r.doc_id]));
const byId = store.prepare("SELECT doc_id, text, layout FROM chunks WHERE id = ?");
const quote = v => `"${v.replaceAll('"', '""')}"`;
const hex = c => c.codePointAt(0).toString(16);

function candidates(query) {
  const chars = [...query];
  if (chars.length >= 3) {
    const grams = new Set(); for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(""));
    return tri.prepare("SELECT rowid AS id FROM tri WHERE tri MATCH ?").all([...grams].map(quote).join(" AND ")).map(r => r.id);
  }
  const token = chars.length === 1 ? `u${hex(chars[0])}` : `b${hex(chars[0])}x${hex(chars[1])}`;
  return short.prepare(`SELECT rowid AS id FROM ${chars.length === 1 ? "uni" : "bi"} WHERE ${chars.length === 1 ? "uni" : "bi"} MATCH ?`).all(quote(token)).map(r => r.id);
}

const result = {};
for (const query of ["spec.md", "測試", "function", "console.log(", "{", "ing", "e", "the", "return"]) {
  const t0 = performance.now();
  const ids = candidates(query).sort((a, b) => (modified.get(chunkDoc.get(b)) - modified.get(chunkDoc.get(a))) || a - b);
  const lookupMs = performance.now() - t0;
  const needle = Buffer.from(query, "utf8"), out = [];
  let firstPageMs = null, thresholdMs = null, visited = 0;
  for (const id of ids) {
    const row = byId.get(id);
    matchBytes(row.doc_id, decompress(row.text), row.layout, needle, out);
    visited++;
    if (firstPageMs === null && out.length >= 20) firstPageMs = performance.now() - t0;
    if (out.length >= 10000) { thresholdMs = performance.now() - t0; break; }
  }
  const endMs = performance.now() - t0;
  result[query] = { candidates: ids.length, lookupMs: Math.round(lookupMs), firstPageMs: Math.round(firstPageMs ?? endMs),
    countTo10kMs: Math.round(thresholdMs ?? endMs), exactBelow10k: thresholdMs === null ? out.length : ">=10000", chunksVisited: visited };
}
console.log(JSON.stringify(result, null, 1));
