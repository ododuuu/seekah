// Tantivy (Rust, via napi) on the same 64K chunks as the SQLite FTS5 engines.
// node bench.mjs <variant: T1|T1b|T2|T3>
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import t from "@oxdev03/node-tantivy-binding";

const DATA = "C:/Users/mains/seekah-prototype-data/size-2026-09-28";
const variant = process.argv[2];
const config = {
  T1: { min: 3, max: 3, option: "basic", stored: false },
  T1b: { min: 1, max: 3, option: "basic", stored: false },
  T2: { min: 3, max: 3, option: "position", stored: false },
  T3: { min: 3, max: 3, option: "basic", stored: true },
}[variant];
const dir = path.join(DATA, `tantivy-${variant}`);
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

const builder = new t.SchemaBuilder();
builder.addIntegerField("id", { stored: true, indexed: false, fast: true });
builder.addTextField("text", { stored: config.stored, tokenizerName: "grams", indexOption: config.option });
const schema = builder.build();
const index = new t.Index(schema, dir);
index.registerTokenizer("grams", new t.TextAnalyzerBuilder(t.TokenizerStatic.ngram(config.min, config.max, false)).build());

const store = new DatabaseSync(path.join(DATA, "store-65536-z3.db"), { readOnly: true });
let started = performance.now();
const writer = index.writer(1_000_000_000, 8);
for (const row of store.prepare("SELECT id, text FROM chunks ORDER BY id").iterate()) {
  const doc = new t.Document();
  doc.addInteger("id", row.id);
  doc.addText("text", zstdDecompressSync(row.text).toString("utf8"));
  writer.addDocument(doc);
}
writer.commit();
writer.waitMergingThreads?.();
const buildMs = performance.now() - started;
index.reload();
const bytes = readdirSync(dir).reduce((sum, file) => sum + statSync(path.join(dir, file)).size, 0);

const searcher = index.searcher();
const fts = new DatabaseSync(path.join(DATA, "index-tri-65536.db"), { readOnly: true });
const quote = v => `"${v.replaceAll('"', '""')}"`;
const result = { variant, config, buildMs: Math.round(buildMs), indexMiB: +(bytes / 2 ** 20).toFixed(1), segments: searcher.numSegments ?? null, queries: {} };
for (const query of ["spec.md", "測試資料", "function", "console.log(", "ing", "the", "return", "下列何者", "zzqxv-none"]) {
  const chars = [...query], grams = new Set();
  for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(""));
  const q = variant === "T2" && chars.length > 3
    ? t.Query.phraseQuery(schema, "text", [...Array(chars.length - 2).keys()].map(i => chars.slice(i, i + 3).join("")))
    : t.Query.booleanQuery([...grams].map(g => ({ occur: t.Occur.Must, query: t.Query.termQuery(schema, "text", g) })));
  started = performance.now();
  let count;
  try { count = searcher.search(q, 1, true).count; } catch (error) { count = `error: ${error.message}`; }
  const ms = performance.now() - started;
  const ftsCount = fts.prepare("SELECT count(*) AS n FROM tri WHERE tri MATCH ?").get([...grams].map(quote).join(" AND ")).n;
  result.queries[query] = { tantivyChunks: count, fts5Chunks: ftsCount, ms: +ms.toFixed(1) };
}
console.log(JSON.stringify(result, null, 1));
