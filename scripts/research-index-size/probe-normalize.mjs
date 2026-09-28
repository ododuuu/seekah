// Throughput of NFKC+toLowerCase in V8 on corpus text, and of a fast path that skips pure-ASCII chunks.
import { dataPath, openDb } from "./common.mjs";

const corpus = openDb(dataPath("corpus.db"), { readOnly: true });
const texts = []; let chars = 0;
for (const row of corpus.prepare("SELECT orig FROM blocks LIMIT 600000").iterate()) { texts.push(row.orig); chars += row.orig.length; }
const joined = [];
for (let i = 0; i < texts.length; i += 1000) joined.push(texts.slice(i, i + 1000).join("\n"));
let t = performance.now();
for (const s of joined) s.normalize("NFKC").toLowerCase();
const nfkcMs = performance.now() - t;
t = performance.now();
for (const s of joined) s.toLowerCase();
const lowerMs = performance.now() - t;
let ascii = 0;
t = performance.now();
for (const s of joined) if (/^[\x00-\x7f]*$/.test(s)) ascii++;
const asciiMs = performance.now() - t;
const mb = chars / 2 ** 20;
console.log(JSON.stringify({ MiBchars: +mb.toFixed(1), nfkcLowerMBps: +(mb / nfkcMs * 1000).toFixed(0), lowerOnlyMBps: +(mb / lowerMs * 1000).toFixed(0),
  asciiCheckMBps: +(mb / asciiMs * 1000).toFixed(0), asciiChunks: `${ascii}/${joined.length}` }));
