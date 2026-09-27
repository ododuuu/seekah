// Validate the "candidate bytes x ~20 ms/MB" model of the current architecture (A).
//   node costmodel.mjs --queries   -> costmodel-queries.json  (A, sequential, ~40 differential queries across the byte range)
//   node costmodel.mjs --documents -> costmodel-documents.json (per-document full verification vs size and block count)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SnapshotReader, dataDir, mulberry32, normalize, openSnapshot, parseArgs, percentile, productModules, snapshotPath } from "./common.mjs";
import { createEngine } from "./engines.mjs";

const args = parseArgs(process.argv.slice(2));

/** Ordinary least squares y = a + b1 x1 + ... ; returns coefficients and R^2. */
function regress(rows, keys, target) {
  const X = rows.map(row => [1, ...keys.map(key => row[key])]);
  const y = rows.map(row => row[target]);
  const p = X[0].length;
  const XtX = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const Xty = Array.from({ length: p }, (_, i) => X.reduce((sum, row, index) => sum + row[i] * y[index], 0));
  // Gauss-Jordan elimination.
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < p; col++) {
    let pivot = col;
    for (let row = col + 1; row < p; row++) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let row = 0; row < p; row++) {
      if (row === col) continue;
      const factor = M[row][col] / M[col][col];
      for (let k = col; k <= p; k++) M[row][k] -= factor * M[col][k];
    }
  }
  const beta = M.map((row, i) => row[p] / row[i]);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const predicted = X.map(row => row.reduce((sum, value, i) => sum + value * beta[i], 0));
  const ssRes = y.reduce((sum, value, i) => sum + (value - predicted[i]) ** 2, 0);
  const ssTot = y.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return { intercept: beta[0], ...Object.fromEntries(keys.map((key, i) => [key, beta[i + 1]])), r2: 1 - ssRes / ssTot, n: rows.length };
}

if (args.queries) {
  const queries = JSON.parse(readFileSync(path.join(dataDir, "queries.json"), "utf8")).queries;
  const diff = readdirSync(dataDir).filter(name => /^diff-A-\d+\.jsonl$/u.test(name))
    .flatMap(name => readFileSync(path.join(dataDir, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)))
    .filter(line => !line.error && line.metrics.decompressedBytes > 0);
  // Log-spaced bins over decompressed MB; up to 4 queries per bin, deterministic.
  const random = mulberry32(7);
  const bins = new Map();
  for (const line of diff) {
    const bin = Math.floor(Math.log2(line.metrics.decompressedBytes / 1e5));
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin).push(line);
  }
  const chosen = [...bins.entries()].sort((a, b) => a[0] - b[0])
    .flatMap(([, lines]) => lines.map(line => [random(), line]).sort((a, b) => a[0] - b[0]).slice(0, 4).map(([, line]) => line));
  const engine = await createEngine("A");
  const rows = [];
  for (const line of chosen) {
    const raw = queries[line.id].raw;
    engine.search(raw);
    const samples = [0, 1, 2].map(() => engine.search(raw).metrics);
    const median = key => percentile(samples.map(sample => sample[key]), 0.5);
    rows.push({ id: line.id, raw, results: samples[0].results, candidateDocs: samples[0].candidateDocs, verifiedDocs: samples[0].verifiedDocs,
      payloadReads: samples[0].payloadReads, decompressedMB: samples[0].decompressedBytes / 1e6, compressedMB: samples[0].compressedBytes / 1e6,
      totalMs: median("totalMs"), verificationMs: median("verificationMs"), decompressMs: median("decompressMs"),
      payloadLookupMs: median("payloadLookupMs"), postingMs: median("postingMs") });
    console.log(rows.length, JSON.stringify(raw), rows.at(-1).decompressedMB.toFixed(1), "MB", Math.round(rows.at(-1).totalMs), "ms");
  }
  engine.close();
  const model = rows.map(row => ({ ...row, predictedMs: row.decompressedMB * 20, ratio: row.totalMs / Math.max(1, row.decompressedMB * 20) }));
  writeFileSync(path.join(dataDir, "costmodel-queries.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    fits: {
      totalMs_vs_MB: regress(rows, ["decompressedMB"], "totalMs"),
      verificationMs_vs_MB: regress(rows, ["decompressedMB"], "verificationMs"),
      totalMs_vs_MB_docs: regress(rows, ["decompressedMB", "candidateDocs"], "totalMs"),
      largeOnly_totalMs_vs_MB: regress(rows.filter(row => row.decompressedMB >= 10), ["decompressedMB"], "totalMs"),
    },
    rows: model,
  }, null, 1) + "\n");
} else if (args.documents) {
  const { IndexStore } = await productModules();
  const store = new IndexStore(snapshotPath, { readOnly: true });
  const db = openSnapshot();
  const reader = new SnapshotReader(db);
  const documents = db.prepare(`SELECT d.id, d.path, count(p.ordinal) AS payloads,
      (SELECT count(*) FROM blocks b WHERE b.document_id = d.id) AS blocks
    FROM documents d JOIN document_payloads p ON p.document_id = d.id GROUP BY d.id`).all();
  const bucket = count => count === 1 ? "1" : count <= 3 ? "2-3" : count <= 10 ? "4-10" : count <= 50 ? "11-50" : count <= 200 ? "51-200" : "201+";
  const random = mulberry32(11);
  const byBucket = new Map();
  for (const document of documents) {
    const key = bucket(Number(document.payloads));
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(document);
  }
  const chosen = [...byBucket.values()].flatMap(list => list.map(item => [random(), item]).sort((a, b) => a[0] - b[0]).slice(0, 40).map(([, item]) => item));
  const absent = normalize("seekah_absent_20260927_f391a7");
  const rows = [];
  for (const document of chosen) {
    const metrics = { payloadReads: 0, compressedBytes: 0, decompressedBytes: 0, decompressMs: 0, snippetPayloadReads: 0 };
    reader.documentBlocks(Number(document.id), metrics);
    // Product full-document path (candidateByPath -> blocksFor) plus rankDocument's per-block normalize + includes.
    const run = () => {
      const started = performance.now();
      const candidate = store.candidateByPath(document.path);
      const decoded = performance.now();
      let hits = 0;
      for (const block of candidate.blocks) {
        if (normalize(block.heading ?? "").includes(absent)) hits++;
        if (normalize(block.content).includes(absent)) hits++;
      }
      return { totalMs: performance.now() - started, decodeMs: decoded - started, verifyMs: performance.now() - decoded, hits };
    };
    run();
    const samples = [run(), run(), run()];
    const median = key => percentile(samples.map(sample => sample[key]), 0.5);
    rows.push({ id: Number(document.id), payloads: Number(document.payloads), blocks: Number(document.blocks),
      decompressedMB: metrics.decompressedBytes / 1e6, totalMs: median("totalMs"), decodeMs: median("decodeMs"), verifyMs: median("verifyMs") });
  }
  store.close();
  const perBucket = {};
  for (const row of rows) {
    const key = bucket(row.payloads);
    (perBucket[key] ??= []).push(row);
  }
  writeFileSync(path.join(dataDir, "costmodel-documents.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    fits: {
      totalMs_vs_MB: regress(rows, ["decompressedMB"], "totalMs"),
      totalMs_vs_MB_blocks: regress(rows, ["decompressedMB", "blocks"], "totalMs"),
      decodeMs_vs_MB: regress(rows, ["decompressedMB"], "decodeMs"),
      verifyMs_vs_MB_blocks: regress(rows, ["decompressedMB", "blocks"], "verifyMs"),
    },
    buckets: Object.fromEntries(Object.entries(perBucket).map(([key, list]) => [key, {
      documents: list.length, medianMB: percentile(list.map(row => row.decompressedMB), 0.5),
      medianBlocks: percentile(list.map(row => row.blocks), 0.5), medianMs: percentile(list.map(row => row.totalMs), 0.5),
      msPerMB: percentile(list.map(row => row.totalMs / Math.max(row.decompressedMB, 1e-6)), 0.5),
    }])),
    rows,
  }, null, 1) + "\n");
  console.log("documents", rows.length);
}
