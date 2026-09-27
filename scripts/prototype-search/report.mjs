// Collect every prototype artefact into a repo-safe summary (no document text, no
// sampled query text, no paths) plus a CSV of the latency benchmark.
//   node report.mjs --out <dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, parseArgs } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.out ?? path.join(dataDir, "report"));
mkdirSync(out, { recursive: true });
const load = name => existsSync(path.join(dataDir, name)) ? JSON.parse(readFileSync(path.join(dataDir, name), "utf8")) : undefined;
const engines = ["A", "B", "C1", "C2", "D"];
const queries = load("queries.json").queries;

// Correctness: counts per engine, mismatch buckets and structural classification only.
const correctness = load("correctness.json");
const correctnessSummary = Object.fromEntries(Object.entries(correctness?.engines ?? {}).map(([engine, summary]) => [engine, {
  answered: summary.answered, errors: summary.errors, resultEqualTruth: summary.resultEqual, resultMismatch: summary.resultMismatch,
  snippetEqualTruth: summary.snippetEqual, snippetMismatch: summary.snippetMismatch, mismatchByKind: summary.mismatchByKind,
  mismatches: summary.mismatches.map(item => ({ id: item.id, kind: item.kind, length: item.length, expectedTotal: item.expectedTotal,
    actualTotal: item.actualTotal, missingDocs: item.missing, extraDocs: item.extra, changedRankOrBlock: item.changed, orderOnly: item.orderOnly })),
  errorKinds: summary.errorsList.map(item => ({ id: item.id, kind: queries[item.id].kind, error: item.error.split("\n")[0] })),
}]));

// Differential structural metrics (contended timings excluded): per engine, per query length bucket.
const bucket = query => query.kind.startsWith("synthetic") ? "synthetic" : query.kind !== "substring" ? "normalization"
  : `len${query.length <= 2 ? query.length : query.length <= 6 ? "3-6" : "7-12"}`;
const structural = {};
for (const engine of engines) {
  const files = (await import("node:fs")).readdirSync(dataDir).filter(name => name.startsWith(`diff-${engine}-`) && name.endsWith(".jsonl"));
  const seen = new Set();
  const groups = {};
  for (const line of files.flatMap(name => readFileSync(path.join(dataDir, name), "utf8").trim().split("\n").filter(Boolean).map(text => JSON.parse(text)))) {
    if (line.error || seen.has(line.id)) continue;
    seen.add(line.id);
    const key = bucket(queries[line.id]);
    const group = groups[key] ??= { queries: 0, payloadReads: 0, decompressedBytes: 0, verifiedBlocks: 0, falsePositiveDocs: 0, falsePositiveBlocks: 0, results: 0 };
    group.queries++;
    for (const field of ["payloadReads", "decompressedBytes", "verifiedBlocks", "falsePositiveDocs", "falsePositiveBlocks", "results"]) group[field] += line.metrics[field] ?? 0;
  }
  structural[engine] = groups;
}

const bench = Object.fromEntries(engines.map(engine => [engine, load(`bench-${engine}.json`)]).filter(([, value]) => value));
const csv = ["engine,query,raw,total,first_run_ms,p50_ms,p95_ms,min_ms,max_ms,measured,posting_ms_p50,verification_ms_p50,snippet_ms_p50,posting_rows,candidate_docs,candidate_blocks,payload_reads,compressed_bytes,decompressed_bytes,verified_blocks,false_positive_docs,false_positive_blocks,snippet_payload_reads,result_hash"];
for (const [engine, report] of Object.entries(bench)) {
  for (const [name, item] of Object.entries(report.queries)) {
    const s = item.structure;
    csv.push([engine, name, JSON.stringify(item.raw), item.total, item.firstRunMs.toFixed(1), item.totalMs.p50.toFixed(1), item.totalMs.p95.toFixed(1),
      item.totalMs.min.toFixed(1), item.totalMs.max.toFixed(1), item.measuredCount, item.p50.postingMs.toFixed(1), item.p50.verificationMs.toFixed(1),
      item.p50.snippetMs.toFixed(1), s.postingRows, s.candidateDocs, s.candidateBlocks, s.payloadReads, s.compressedBytes, s.decompressedBytes,
      s.verifiedBlocks, s.falsePositiveDocs, s.falsePositiveBlocks, s.snippetPayloadReads, item.hash.slice(0, 16)].join(","));
  }
}
writeFileSync(path.join(out, "bench.csv"), csv.join("\n") + "\n");

const strip = rows => rows?.map(({ raw, ...rest }) => rest);
const costQueries = load("costmodel-queries.json");
const costDocuments = load("costmodel-documents.json");
const builds = Object.fromEntries(["fields", "B", "C1", "C2"].map(variant => [variant, load(`build-${variant}.json`)]).filter(([, value]) => value)
  .map(([variant, value]) => [variant, { buildMs: value.buildMs, totalBuildMs: value.totalBuildMs, timings: value.timings, counts: value.counts,
    fileBytes: value.fileBytes, maxRSSKiB: value.maxRSSKiB, batchDocs: value.batchDocs }]));
const summary = {
  generatedAt: new Date().toISOString(),
  environment: bench.A ? { node: bench.A.node, sqlite: bench.A.sqlite } : undefined,
  querySet: { seed: load("queries.json").seed, count: queries.length,
    composition: queries.reduce((acc, query) => { const key = `${query.kind}/${query.script}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}) },
  sizes: load("sizes.json"),
  builds,
  migration: load("migration.json"),
  correctness: correctnessSummary,
  differentialStructure: structural,
  bench: Object.fromEntries(Object.entries(bench).map(([engine, report]) => [engine, { protocol: report.protocol, maxRSSKiB: report.maxRSSKiB,
    queries: Object.fromEntries(Object.entries(report.queries).map(([name, item]) => [name, { ...item }])) }])),
  costModel: {
    queries: costQueries && { fits: costQueries.fits, rows: strip(costQueries.rows) },
    documents: costDocuments && { fits: costDocuments.fits, buckets: costDocuments.buckets },
  },
};
writeFileSync(path.join(out, "prototype-summary.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(`written ${out}`);
