// Document-level early termination (the product counts documents and opens the first 500):
// visit candidate chunks newest document first; once a document has a hit, skip its other chunks.
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
  const table = chars.length === 1 ? "uni" : "bi";
  const token = chars.length === 1 ? `u${hex(chars[0])}` : `b${hex(chars[0])}x${hex(chars[1])}`;
  return short.prepare(`SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ?`).all(quote(token)).map(r => r.id);
}

const result = {};
for (const query of ["spec.md", "測試", "console.log(", "function", "return", "{", "the", "ing", "e"]) {
  const t0 = performance.now();
  const ids = candidates(query).sort((a, b) => (modified.get(chunkDoc.get(b)) - modified.get(chunkDoc.get(a))) || a - b);
  const needle = Buffer.from(query, "utf8"), found = new Set();
  let at20 = null, at500 = null, verified = 0;
  for (const id of ids) {
    const doc = chunkDoc.get(id);
    if (found.has(doc)) continue;
    const row = byId.get(id), out = [];
    matchBytes(row.doc_id, decompress(row.text), row.layout, needle, out);
    verified++;
    if (out.length) {
      found.add(doc);
      if (found.size === 20) at20 = performance.now() - t0;
      if (found.size === 500) at500 = performance.now() - t0;
    }
  }
  const exact = performance.now() - t0;
  result[query] = { documents: found.size, candidateChunks: ids.length, verifiedChunks: verified,
    first20Ms: Math.round(at20 ?? exact), first500Ms: Math.round(at500 ?? exact), exactCountMs: Math.round(exact) };
}
console.log(JSON.stringify(result, null, 1));
