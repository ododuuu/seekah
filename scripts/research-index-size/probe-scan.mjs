// Time the pieces of one full scan: read blobs, zstd decompress, Buffer.indexOf.
import { openDb } from "./common.mjs";
import { decompress, matchBytes, storePath } from "./store.mjs";

const store = openDb(storePath(65536, 3), { readOnly: true });
let t = performance.now();
const rows = store.prepare("SELECT doc_id, text, layout FROM chunks").all();
const readMs = performance.now() - t;
t = performance.now();
const raws = rows.map(r => decompress(r.text));
const decompressMs = performance.now() - t;
const bytes = raws.reduce((s, r) => s + r.length, 0);
const result = { chunks: rows.length, rawMiB: +(bytes / 2 ** 20).toFixed(1), readMs: Math.round(readMs), decompressMs: Math.round(decompressMs) };
for (const q of ["zzqxv-none", "spec.md", "ing", "e"]) {
  const needle = Buffer.from(q), out = [];
  t = performance.now();
  for (let i = 0; i < rows.length; i++) matchBytes(rows[i].doc_id, raws[i], rows[i].layout, needle, out);
  result[`match:${q}`] = { ms: Math.round(performance.now() - t), hits: out.length };
}
console.log(JSON.stringify(result));
