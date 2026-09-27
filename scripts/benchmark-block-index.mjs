// SPEC §50.5 real-store check: migrate a copy of a pre-0.38.0 index with the
// built product, then time the prototype benchmark queries and compare result
// hashes with the pre-0.38.0 product (prototype variant A).
//   npm run build && node scripts/benchmark-block-index.mjs --snapshot <read-only index.db> --work <dir> --out <new.json>
// The snapshot is only copied; the report holds counts, sizes, timings and hashes.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) =>
  value.startsWith("--") ? [...pairs, [value.slice(2), list[index + 1]]] : pairs, []));
if (!args.snapshot || !args.work || !args.out) throw new Error("usage: --snapshot <index.db> --work <dir> --out <report.json>");
if (existsSync(args.out)) throw new Error(`output already exists: ${args.out}`);
const repo = path.resolve(import.meta.dirname, "..");
const dist = path.join(repo, "dist", "src");
const { IndexStore } = await import(pathToFileURL(path.join(dist, "store.js")).href);
const { collectHits, createSearchResultSet } = await import(pathToFileURL(path.join(dist, "search.js")).href);
const prototype = JSON.parse(readFileSync(path.join(repo, "docs/research/search-architecture-2026-09-27/prototype/prototype-summary.json"), "utf8"));
const queries = Object.entries(prototype.bench.A.queries).map(([name, item]) => ({ name, raw: item.raw, hashA: item.hash, totalA: item.total,
  prototypeC2P50: prototype.bench.C2.queries[name].totalMs.p50 }));

function resultHash(ranked) {
  const hash = createHash("sha256");
  for (const item of ranked) {
    hash.update(`${item.documentId}\u0001${item.result.rank}\u0001${item.sourceKind}\u0001${item.ordinal}\u0001${item.result.heading}\u0001${item.result.location}\n`);
  }
  return hash.digest("hex");
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))];

function tableGroups(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const groups = {};
    for (const row of db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name").all()) {
      const name = String(row.name);
      const group = name.startsWith("search_block_") ? name.replace(/_(data|idx|config|docsize|content)$/u, "")
        : name.startsWith("search_filename_") || name.startsWith("search_heading") ? "filename+heading index"
          : /bloom|search_unigrams|search_trigrams/u.test(name) ? "legacy Bloom／document postings" : "documents, blocks, payloads, mapping, other";
      groups[group] = (groups[group] ?? 0) + Number(row.bytes);
    }
    const freeBytes = Number(db.prepare("PRAGMA freelist_count").get().freelist_count) * Number(db.prepare("PRAGMA page_size").get().page_size);
    return { groups, freeBytes };
  } finally { db.close(); }
}

mkdirSync(args.work, { recursive: true });
const database = path.join(args.work, "index.db");
if (existsSync(database)) throw new Error(`work database already exists: ${database}`);
copyFileSync(args.snapshot, database);
chmodSync(database, 0o666); // the snapshot may carry a read-only attribute
const before = { fileBytes: statSync(database).size, ...tableGroups(database) };

const writer = new IndexStore(database);
const migrationStarted = performance.now();
let lastProgress = 0;
await writer.upgrade({ onProgress: update => {
  if (update.current && performance.now() - lastProgress > 15_000) {
    lastProgress = performance.now();
    console.log(`${update.message} ${update.current}/${update.total} ${Math.round((lastProgress - migrationStarted) / 1000)}s`);
  }
} });
const migrationMs = performance.now() - migrationStarted;
const format = writer.formatStatus();
writer.close();
const after = { fileBytes: statSync(database).size, ...tableGroups(database) };
console.log(`migration ${Math.round(migrationMs / 1000)} s; file ${before.fileBytes} -> ${after.fileBytes}`);

const store = new IndexStore(database, { readOnly: true });
const results = {};
for (const query of queries) {
  const run = () => {
    const started = performance.now();
    const resultSet = createSearchResultSet(store, query.raw);
    const rankedMs = performance.now() - started;
    resultSet.page(1, 20);
    return { totalMs: performance.now() - started, rankedMs, trace: resultSet.trace };
  };
  const first = run();
  const measured = first.totalMs > 20_000 ? 3 : 10;
  for (let warm = 1; warm < (measured === 3 ? 2 : 3); warm++) run();
  const samples = Array.from({ length: measured }, run);
  const ranked = collectHits(store, query.raw);
  const hash = resultHash(ranked);
  const trace = samples.at(-1).trace;
  results[query.name] = {
    raw: query.raw, total: ranked.length, hashEqualsPre038: hash === query.hashA, totalEqualsPre038: ranked.length === query.totalA,
    firstRunMs: first.totalMs, p50Ms: percentile(samples.map(sample => sample.totalMs), 0.5), p95Ms: percentile(samples.map(sample => sample.totalMs), 0.95),
    rankingP50Ms: percentile(samples.map(sample => sample.rankedMs), 0.5), measured, prototypeC2P50Ms: query.prototypeC2P50,
    candidateStrategy: trace.candidateStrategy, rankingPayloadsRead: trace.diagnostics.payloadReads.ranking.payloadsRead,
    snippetPayloadsRead: trace.diagnostics.payloadReads.snippet.payloadsRead, indexPostingRows: trace.counts.indexPostingRows,
    indexCandidateBlocks: trace.counts.indexCandidateBlocks,
  };
  console.log(query.name, ranked.length, hash === query.hashA ? "hash=A" : "HASH DIFFERS", Math.round(results[query.name].p50Ms), "ms");
}
store.close();
const report = {
  generatedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(), node: process.version, sqlite: process.versions.sqlite,
  documents: format.totalDocuments, migration: { ms: migrationMs, blockIndexCompletedDocuments: format.blockIndexCompletedDocuments,
    needsUpgrade: format.needsUpgrade, legacySearchStructures: format.legacySearchStructures },
  size: { before, after },
  protocol: "read-only store opened after the writer closed (same process); first run + warm-up to 3 runs + 10 measured (3 when first run > 20 s); createSearchResultSet + page(1, 20)",
  queries: results,
  notes: ["Local win32 evidence on a copy of the real store; not the company Windows acceptance.",
    "hashEqualsPre038 compares (document, rank, source kind, ordinal, heading, location) in order with the pre-0.38.0 product on the same snapshot."],
};
writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
console.log(`saved ${args.out}`);
