// Real-data validation for 0.39.0 (SPEC §52.6). Not product code.
//   node validate-039.mjs results <dist> <database> <out.json>   complete result lists (read-only)
//   node validate-039.mjs migrate <dist> <database> <out.json>   writer upgrade: time and file size
//   node validate-039.mjs latency <dist> <database> <out.json>   fast／exact latency (read-only)
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataPath, percentile } from "./common.mjs";

const [phase, dist, database, out] = process.argv.slice(2);
const load = file => import(pathToFileURL(path.join(dist, "src", file)).href);
const { IndexStore } = await load("store.js");
const search = await load("search.js");
const NAMED = ["spec.md", "測試", "ing", "e", "的", "function", "return", "{", "console.log(", "下列何者", "資料", "localdocsearch", "zzqxv-none"];
const queries = [...new Set([...NAMED, ...JSON.parse(readFileSync(dataPath("queries.json"), "utf8")).slice(25, 85)])];
const result = { phase, dist, database, queries: queries.length };

if (phase === "results") {
  const store = new IndexStore(database, { readOnly: true });
  result.chunkStoreReady = store.chunkStoreReady?.() ?? false;
  result.hashes = {};
  for (const [index, query] of queries.entries()) {
    const started = performance.now();
    const hits = search.collectHits(store, query);
    const ms = performance.now() - started;
    const projection = hits.map(item => [item.result.path, item.result.rank, item.ordinal, item.result.heading, item.result.location, item.sourceKind]);
    result.hashes[`#${index}`] = { count: hits.length, ms: Math.round(ms), hash: createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 16) };
  }
  store.close();
} else if (phase === "migrate") {
  const before = statSync(database).size;
  const store = new IndexStore(database);
  const started = performance.now();
  let last = 0;
  await store.upgrade({ onProgress: update => {
    if (performance.now() - last > 10_000 || update.message !== "建立區段儲存與搜尋索引") {
      last = performance.now();
      console.error(`${Math.round((performance.now() - started) / 1000)}s ${update.message} ${update.current ?? ""}/${update.total ?? ""}`);
    }
  } });
  result.migrateMs = Math.round(performance.now() - started);
  result.format = store.formatStatus();
  result.freePageRatio = store.freePageRatio();
  store.close();
  result.bytesBefore = before;
  result.bytesAfter = statSync(database).size;
} else if (phase === "latency") {
  // Like the Workbench: a new read-only connection per search (cold SQLite cache), OS file cache warm.
  // The whole list runs twice; the second pass is reported.
  const timed = (work) => {
    const store = new IndexStore(database, { readOnly: true });
    try { const started = performance.now(); const value = work(store); return { value, ms: performance.now() - started }; }
    finally { store.close(); }
  };
  let timings, named;
  for (let pass = 0; pass < 2; pass++) {
    timings = { fastFirstPage: [], exactTotal: [] };
    named = {};
    for (const query of queries) {
      const fast = timed(store => { const set = search.createSearchResultSet(store, query); set.page(1, 20); return set; });
      const exact = timed(store => search.createSearchResultSet(store, query, undefined, undefined, "phrase", undefined, "all", undefined, "relevance", "exact"));
      timings.fastFirstPage.push(fast.ms);
      timings.exactTotal.push(exact.ms);
      if (NAMED.includes(query)) named[query] = { fastFirstPageMs: Math.round(fast.ms), fastTotal: `${fast.value.total}${fast.value.totalRelation === "gte" ? "+" : ""}`,
        exactMs: Math.round(exact.ms), exactTotal: exact.value.total };
    }
  }
  result.named = named;
  for (const [key, values] of Object.entries(timings)) {
    result[key] = { p50: Math.round(percentile(values, 0.5)), p90: Math.round(percentile(values, 0.9)), max: Math.round(Math.max(...values)) };
  }
}
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "hashes")), null, 1));
