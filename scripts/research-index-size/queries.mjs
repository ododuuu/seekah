// Build queries.json (named + random real substrings) and truth.json (all matching doc:ordinal blocks, brute force).
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dataPath, normalize, openDb } from "./common.mjs";

const NAMED = ["spec.md", "測試", "ing", "e", "的", "function", "return", "const", "import", "http", "error", "the",
  "資料", "報告", "下列何者", "localdocsearch", "index.db", "2026", "todo", "{", "=>", "console.log(", "zzqxv-none", "搜尋", "seekah"];

function random(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let v = state; v = Math.imul(v ^ (v >>> 15), v | 1); v ^= v + Math.imul(v ^ (v >>> 7), v | 61); return ((v ^ (v >>> 14)) >>> 0) / 4294967296; };
}

const corpus = openDb(dataPath("corpus.db"), { readOnly: true });
const texts = corpus.prepare("SELECT doc_id, ordinal, norm FROM blocks").all();
const next = random(20260928);
const queries = new Set(NAMED.map(normalize));
while (queries.size < NAMED.length + 200) {
  const block = texts[Math.floor(next() * texts.length)].norm;
  const chars = [...block];
  const length = 1 + Math.floor(next() * 12);
  if (chars.length < length) continue;
  const start = Math.floor(next() * (chars.length - length + 1));
  const value = chars.slice(start, start + length).join("");
  if (value.trim()) queries.add(value);
}
const list = [...queries];
const truth = {};
const started = performance.now();
for (const query of list) {
  const hits = [];
  for (const row of texts) if (row.norm.includes(query)) hits.push(`${row.doc_id}:${row.ordinal}`);
  truth[query] = { count: hits.length, hash: createHash("sha256").update(hits.sort().join(",")).digest("hex").slice(0, 16) };
}
writeFileSync(dataPath("queries.json"), JSON.stringify(list));
writeFileSync(dataPath("truth.json"), JSON.stringify(truth));
const counts = list.map(q => truth[q].count);
console.log(JSON.stringify({ queries: list.length, bruteForceMsPerQuery: +((performance.now() - started) / list.length).toFixed(1),
  zeroHit: counts.filter(c => c === 0).length, over10k: counts.filter(c => c > 10000).length,
  named: Object.fromEntries(NAMED.map(q => [q, truth[normalize(q)].count])) }));
