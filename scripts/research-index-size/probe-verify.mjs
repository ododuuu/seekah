// Break down per-chunk verification cost on real chunks: decompress, toString, ASCII test, normalize, indexOf.
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
const [database] = process.argv.slice(2);
const db = new DatabaseSync(database, { readOnly: true });
const rows = db.prepare("SELECT text FROM document_chunks ORDER BY id LIMIT 2000").all();
const t = { decompress: 0, toString: 0, ascii: 0, lower: 0, nfkc: 0, indexOf: 0 };
let asciiCount = 0, chars = 0;
for (const row of rows) {
  let s = performance.now(); const buf = zstdDecompressSync(row.text); t.decompress += performance.now() - s;
  s = performance.now(); const str = buf.toString("utf8"); t.toString += performance.now() - s; chars += str.length;
  s = performance.now(); const ascii = /^[\x00-\x7f]*$/u.test(str); t.ascii += performance.now() - s; if (ascii) asciiCount++;
  s = performance.now(); const lower = str.toLowerCase(); t.lower += performance.now() - s;
  s = performance.now(); const nfkc = str.normalize("NFKC").toLowerCase(); t.nfkc += performance.now() - s;
  s = performance.now(); nfkc.indexOf("console.log("); lower.indexOf("zzqxv"); t.indexOf += performance.now() - s;
}
console.log(JSON.stringify({ chunks: rows.length, asciiChunks: asciiCount, MiBchars: +(chars / 2 ** 20).toFixed(1),
  msPerChunk: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +(v / rows.length).toFixed(3)])) }));
