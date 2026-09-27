// Differential run of one engine over the query set (sharded).
//   node run-diff.mjs --engine A|B|C1|C2|D --shard i/n
// Writes diff-<engine>-<i>.jsonl: per query total, result hash, whether it equals
// the brute-force truth (compact list kept only on mismatch), page 1 + last page
// snippets and structural metrics. Timings here are contended; see bench.mjs.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { dataDir, parseArgs } from "./common.mjs";
import { createEngine } from "./engines.mjs";
import { resultHash } from "./hash.mjs";

const args = parseArgs(process.argv.slice(2));
const [index, count] = args.shard.split("/").map(Number);
const queries = JSON.parse(readFileSync(path.join(dataDir, "queries.json"), "utf8")).queries;
const truth = new Map(readFileSync(path.join(dataDir, "truth.jsonl"), "utf8").trim().split("\n")
  .map(line => JSON.parse(line)).map(item => [item.id, item.hash]));
const engine = await createEngine(args.engine);
// --sub k/m splits the shard's remaining queries across helper processes (load balancing).
const [subIndex, subCount] = args.sub ? args.sub.split("/").map(Number) : [0, 1];
const outPath = path.join(dataDir, `diff-${args.engine}-${index}${args.sub ? `s${subIndex}` : ""}.jsonl`);
// Resumable: queries already written by any process for this engine are skipped.
const done = new Set(readdirSync(dataDir).filter(name => name.startsWith(`diff-${args.engine}-`) && name.endsWith(".jsonl"))
  .flatMap(name => readFileSync(path.join(dataDir, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)))
  .filter(line => !line.error).map(line => line.id));
const KIND = ["filename", "heading", "content"];
const pending = queries.filter((_, position) => position % count === index && !done.has(queries[position].id));
for (const query of pending.filter((_, position) => position % subCount === subIndex)) {
  let line;
  try {
    const { ranked, snippets, metrics } = engine.search(query.raw, { pages: [1, "last"] });
    const hash = resultHash(ranked);
    const matchesTruth = hash === truth.get(query.id);
    line = { id: query.id, total: ranked.length, hash, matchesTruth, snippets, metrics,
      compact: matchesTruth ? undefined : ranked.map(item => [item.documentId, item.rank, KIND.indexOf(item.sourceKind), item.ordinal]) };
  } catch (error) {
    line = { id: query.id, error: String(error?.stack ?? error) };
  }
  appendFileSync(outPath, JSON.stringify(line) + "\n");
}
engine.close();
console.log(`diff ${args.engine} ${index}/${count} done`);
