// Corpus baseline: UTF-8 size, per-extension share, block length distribution, compressibility.
import { zstdCompressSync, brotliCompressSync, constants } from "node:zlib";
import { dataPath, openDb, percentile } from "./common.mjs";

const corpus = openDb(dataPath("corpus.db"), { readOnly: true });
let origBytes = 0, normBytes = 0;
const lengths = [];
const byExt = new Map();
const docExt = new Map(corpus.prepare("SELECT doc_id, extension FROM documents").all().map(r => [r.doc_id, r.extension]));
let sampleOrig = [], sampleNorm = [], sampled = 0;
for (const row of corpus.prepare("SELECT doc_id, orig, norm FROM blocks").iterate()) {
  const o = Buffer.byteLength(row.orig), n = Buffer.byteLength(row.norm);
  origBytes += o; normBytes += n; lengths.push(row.norm.length);
  const ext = docExt.get(row.doc_id);
  const e = byExt.get(ext) ?? { blocks: 0, bytes: 0, docs: new Set() };
  e.blocks++; e.bytes += o; e.docs.add(row.doc_id); byExt.set(ext, e);
  // Sample every 10th block for compression ratios.
  if (sampled++ % 10 === 0) { sampleOrig.push(row.orig); sampleNorm.push(row.norm); }
}
const ratio = (texts, fn) => { const raw = Buffer.from(texts.join("\n")); return +(fn(raw).length / raw.length).toFixed(3); };
const origSample = sampleOrig, normSample = sampleNorm;
console.log(JSON.stringify({
  blocks: lengths.length, origMiB: +(origBytes / 2 ** 20).toFixed(1), normMiB: +(normBytes / 2 ** 20).toFixed(1),
  blockChars: { p50: percentile(lengths, 0.5), p90: percentile(lengths, 0.9), p99: percentile(lengths, 0.99), max: lengths.reduce((a, b) => Math.max(a, b), 0),
    mean: +(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1) },
  compressionRatio10pctSample: {
    zstd3: ratio(origSample, b => zstdCompressSync(b)),
    zstd19: ratio(origSample, b => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 19 } })),
    brotli11: ratio(origSample, b => brotliCompressSync(b)),
    normZstd3: ratio(normSample, b => zstdCompressSync(b)),
  },
}, null, 1));
console.log([...byExt].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15)
  .map(([ext, e]) => `${ext}\tdocs=${e.docs.size}\tblocks=${e.blocks}\tMiB=${(e.bytes / 2 ** 20).toFixed(1)}`).join("\n"));
