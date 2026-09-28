// node run.mjs --engine scan|trigram|sparse [--chunk 65536] [--level 3] [--rebuild]
// Builds the engine, checks every query against truth.json, and reports size and latency.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { arg, dataPath, percentile } from "./common.mjs";
import { buildStore, storePath } from "./store.mjs";
import { engines } from "./engines.mjs";

const engineName = arg("engine", "scan");
const chunkChars = Number(arg("chunk", "65536"));
const level = Number(arg("level", "3"));
const runs = Number(arg("runs", "2"));
const engine = engines[engineName];
if (!engine) throw new Error(`unknown engine ${engineName}`);

const queries = JSON.parse(readFileSync(dataPath("queries.json"), "utf8"));
const truth = JSON.parse(readFileSync(dataPath("truth.json"), "utf8"));

let build = null;
const started = performance.now();
if (process.argv.includes("--rebuild") || !existsSync(storePath(chunkChars, level)) || !engine.built(chunkChars, level)) {
  const index = engine.beginBuild?.(chunkChars, level);
  const store = buildStore(chunkChars, level, index?.add);
  const indexStats = index?.finish() ?? {};
  build = { store, index: indexStats, ms: Math.round(performance.now() - started) };
}
const storeBytes = statSync(storePath(chunkChars, level)).size;
const indexBytes = engine.indexBytes?.(chunkChars, level) ?? 0;

const search = engine.open(chunkChars, level);
const timings = new Map(), wrong = [];
for (let run = 0; run < runs; run++) {
  for (const query of queries) {
    const t = performance.now();
    const { keys, stats } = search(query);
    const ms = performance.now() - t;
    if (run === runs - 1) {
      const hash = createHash("sha256").update([...new Set(keys)].sort().join(",")).digest("hex").slice(0, 16);
      if (hash !== truth[query].hash) wrong.push({ query: query.length > 20 ? `${query.slice(0, 20)}…` : query, expected: truth[query].count, got: new Set(keys).size });
      timings.set(query, { ms, ...stats });
    }
  }
}
const all = [...timings.values()].map(t => t.ms);
const named = ["spec.md", "測試", "ing", "e", "的", "function", "{", "console.log(", "下列何者", "zzqxv-none"];
const report = {
  engine: engineName, chunkChars, level, build,
  sizeMiB: { store: +(storeBytes / 2 ** 20).toFixed(1), index: +(indexBytes / 2 ** 20).toFixed(1), total: +((storeBytes + indexBytes) / 2 ** 20).toFixed(1) },
  correctness: { queries: queries.length, wrong: wrong.length, examples: wrong.slice(0, 5) },
  latencyMs: { p50: +percentile(all, 0.5).toFixed(1), p90: +percentile(all, 0.9).toFixed(1), p99: +percentile(all, 0.99).toFixed(1), max: +Math.max(...all).toFixed(1) },
  named: Object.fromEntries(named.map(q => [q, { ms: +timings.get(q).ms.toFixed(1), ...Object.fromEntries(Object.entries(timings.get(q)).filter(([k]) => k !== "ms")) }])),
};
const out = dataPath(`result-${engineName}-${chunkChars}-z${level}.json`);
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
