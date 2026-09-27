// Sequential latency benchmark (run with nothing else busy).
//   node bench.mjs --select                 -> bench-queries.json (statistically chosen from the built indexes)
//   node bench.mjs --engine A|B|C1|C2|D     -> bench-<engine>.json
// Protocol: one fresh process per engine; per query a first run (in-process cold),
// warm-ups up to 3 runs, then 10 measured runs (3 when the first run exceeds 20 s).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, parseArgs, percentile, variantPaths } from "./common.mjs";
import { createEngine } from "./engines.mjs";
import { resultHash } from "./hash.mjs";

const args = parseArgs(process.argv.slice(2));
const selectionPath = path.join(dataDir, "bench-queries.json");

if (args.select) {
  const c1 = new DatabaseSync(variantPaths.C1, { readOnly: true });
  c1.exec("CREATE VIRTUAL TABLE temp.uni USING fts5vocab(main, content_uni, row); CREATE VIRTUAL TABLE temp.tri USING fts5vocab(main, content_tri, row);");
  const fromToken = token => String.fromCodePoint(parseInt(token.slice(1), 16));
  const cjkUni = c1.prepare("SELECT term, doc FROM temp.uni WHERE term BETWEEN 'u4e00' AND 'u9fa5' AND length(term) = 5 ORDER BY doc DESC").all();
  const trigramsByFrequency = c1.prepare("SELECT term, doc FROM temp.tri ORDER BY doc DESC").all();
  const latin = trigramsByFrequency.filter(row => /^[a-z]{3}$/u.test(row.term));
  const cjkTri = trigramsByFrequency.filter(row => /^[一-龥]{3}$/u.test(row.term));
  const rareCjk = cjkUni.filter(row => row.doc >= 2 && row.doc <= 5);
  // Every [a-z]{3} trigram occurs in >= 19 blocks here, so "rare" is the rarest available.
  const rareLatinFallback = [...latin].reverse().slice(0, 1);
  const rareLatin = latin.filter(row => row.doc >= 3 && row.doc <= 5).length ? latin.filter(row => row.doc >= 3 && row.doc <= 5) : rareLatinFallback;
  const pickMiddle = list => list[Math.floor(list.length / 2)];
  const queries = [
    { name: "spec", raw: "SPEC.md", why: "research reference query" },
    { name: "cjk2-tests", raw: "測試", why: "research reference query (handoff: 誤試 read as 測試)" },
    { name: "cjk1-common", raw: fromToken(cjkUni[0].term), why: `most frequent CJK code point, ${cjkUni[0].doc} blocks` },
    { name: "cjk1-rare", raw: fromToken(pickMiddle(rareCjk).term), why: `CJK code point in ${pickMiddle(rareCjk).doc} blocks` },
    { name: "tri-common-latin", raw: latin[0].term, why: `most frequent [a-z]{3} trigram, ${latin[0].doc} blocks` },
    { name: "tri-common-cjk", raw: cjkTri[0].term, why: `most frequent CJK trigram, ${cjkTri[0].doc} blocks` },
    { name: "tri-rare-latin", raw: pickMiddle(rareLatin).term, why: `[a-z]{3} trigram in ${pickMiddle(rareLatin).doc} blocks` },
    { name: "snipaste", raw: "Snipaste-2.11.3-x64", why: "research reference: rare, one large candidate document" },
    { name: "absent", raw: "seekah_absent_20260927_f391a7", why: "research reference: no match" },
    { name: "ascii1-common", raw: "e", why: "stress: most common 1-char ASCII" },
  ];
  writeFileSync(selectionPath, JSON.stringify({ generatedAt: new Date().toISOString(), queries }, null, 1) + "\n");
  console.log(JSON.stringify(queries, null, 1));
} else {
  const { queries } = JSON.parse(readFileSync(selectionPath, "utf8"));
  const only = args.queries ? new Set(args.queries.split(",")) : undefined;
  const engine = await createEngine(args.engine);
  const report = { engine: args.engine, generatedAt: new Date().toISOString(), node: process.version, sqlite: process.versions.sqlite,
    protocol: "first run + warm-up to 3 runs + 10 measured (3 when first run > 20 s); fresh process per engine", queries: {} };
  for (const query of queries.filter(item => !only || only.has(item.name))) {
    const run = () => engine.search(query.raw, { pages: [1] });
    const first = run();
    const measuredCount = first.metrics.totalMs > 20_000 ? 3 : 10;
    for (let warm = 1; warm < (measuredCount === 3 ? 2 : 3); warm++) run();
    const samples = [];
    let last;
    for (let index = 0; index < measuredCount; index++) { last = run(); samples.push(last.metrics); }
    const pick = key => percentile(samples.map(sample => sample[key]), 0.5);
    report.queries[query.name] = {
      raw: query.raw, total: last.ranked.length, hash: resultHash(last.ranked), firstRunMs: first.metrics.totalMs, measuredCount,
      totalMs: { p50: pick("totalMs"), p95: percentile(samples.map(sample => sample.totalMs), 0.95),
        min: Math.min(...samples.map(sample => sample.totalMs)), max: Math.max(...samples.map(sample => sample.totalMs)) },
      p50: Object.fromEntries(["postingMs", "verificationMs", "decompressMs", "rankingMs", "snippetMs"].map(key => [key, pick(key)])),
      structure: Object.fromEntries(["postingRows", "candidateDocs", "candidateBlocks", "candidatePayloads", "payloadReads", "compressedBytes",
        "decompressedBytes", "verifiedDocs", "verifiedBlocks", "falsePositiveDocs", "falsePositiveBlocks", "snippetPayloadReads", "results"]
        .map(key => [key, last.metrics[key]])),
    };
    console.log(args.engine, query.name, report.queries[query.name].total, Math.round(report.queries[query.name].totalMs.p50), "ms");
  }
  report.maxRSSKiB = process.resourceUsage().maxRSS;
  engine.close();
  writeFileSync(path.join(dataDir, `bench-${args.engine}${args.queries ? "-partial" : ""}.json`), JSON.stringify(report, null, 1) + "\n");
}
