// Compare every engine's differential output with the brute-force truth.
//   node compare.mjs [--engines A,B,C1,C2,D]  -> correctness.json
// Result lists: equal hash = identical set, order, rank, source block, heading and location.
// Snippets: page 1 and last page are recomputed from the truth list with the product makeSnippet().
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SnapshotReader, dataDir, normalize, openSnapshot, parseArgs, productModules } from "./common.mjs";
import { PAGE_SIZE } from "./engines.mjs";

const args = parseArgs(process.argv.slice(2));
const engines = (args.engines ?? "A,B,C1,C2,D").split(",");
const queries = JSON.parse(readFileSync(path.join(dataDir, "queries.json"), "utf8")).queries;
const truth = new Map(readFileSync(path.join(dataDir, "truth.jsonl"), "utf8").trim().split("\n").map(line => {
  const item = JSON.parse(line); return [item.id, item];
}));
const KIND = ["filename", "heading", "content"];
const { makeSnippet } = await productModules();
const db = openSnapshot();
const reader = new SnapshotReader(db);
const documentPath = db.prepare("SELECT path FROM documents WHERE id = ?");
const blockRow = db.prepare("SELECT id, heading FROM blocks WHERE document_id = ? AND ordinal = ?");

function truthSnippets(query, compact) {
  const q = normalize(query.raw.trim());
  const last = Math.max(1, Math.ceil(compact.length / PAGE_SIZE));
  const pages = {};
  if (!compact.length) return pages;
  for (const page of [...new Set([1, last])]) {
    pages[page] = compact.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(([documentId, , kind, ordinal]) => {
      let source;
      if (KIND[kind] === "filename") source = path.basename(documentPath.get(documentId).path);
      else {
        const block = blockRow.get(documentId, ordinal);
        source = KIND[kind] === "heading" ? block.heading : reader.blockContents(documentId, [Number(block.id)]).get(Number(block.id));
      }
      try { return makeSnippet(source, q).text; } catch (error) { return `SNIPPET_ERROR:${error.message}`; }
    });
  }
  return pages;
}

function classify(expected, actual) {
  const expectedById = new Map(expected.map(item => [item[0], item]));
  const actualById = new Map(actual.map(item => [item[0], item]));
  const missing = expected.filter(item => !actualById.has(item[0]));
  const extra = actual.filter(item => !expectedById.has(item[0]));
  const changed = actual.filter(item => {
    const other = expectedById.get(item[0]);
    return other && (other[1] !== item[1] || other[2] !== item[2] || other[3] !== item[3]);
  });
  const orderOnly = !missing.length && !extra.length && !changed.length;
  return { missing: missing.length, extra: extra.length, changed: changed.length, orderOnly,
    examples: { missing: missing.slice(0, 5), extra: extra.slice(0, 5),
      changed: changed.slice(0, 5).map(item => ({ actual: item, expected: expectedById.get(item[0]) })) } };
}

const snippetCache = new Map();
const report = { generatedAt: new Date().toISOString(), queries: queries.length, engines: {} };
for (const engine of engines) {
  const lines = readdirSync(dataDir).filter(name => name.startsWith(`diff-${engine}-`) && name.endsWith(".jsonl"))
    .flatMap(name => readFileSync(path.join(dataDir, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  const summary = { answered: lines.length, errors: 0, resultEqual: 0, resultMismatch: 0, snippetEqual: 0, snippetMismatch: 0,
    mismatchByKind: {}, mismatches: [], snippetMismatches: [], errorsList: [] };
  const seenIds = new Set();
  for (const line of lines.sort((a, b) => a.id - b.id || Number(Boolean(a.error)) - Number(Boolean(b.error)))) {
    if (seenIds.has(line.id)) continue; // helper processes may overlap after a restart
    seenIds.add(line.id);
    const query = queries[line.id];
    if (line.error) { summary.errors++; summary.errorsList.push({ id: line.id, raw: query.raw, error: line.error.slice(0, 400) }); continue; }
    const expected = truth.get(line.id);
    if (line.matchesTruth) summary.resultEqual++;
    else {
      summary.resultMismatch++;
      const bucket = `${query.kind}/len${Math.min(query.length, 7)}${query.length >= 7 ? "+" : ""}`;
      summary.mismatchByKind[bucket] = (summary.mismatchByKind[bucket] ?? 0) + 1;
      summary.mismatches.push({ id: line.id, raw: query.raw, kind: query.kind, length: query.length, expectedTotal: expected.total,
        actualTotal: line.total, ...classify(expected.compact, line.compact) });
    }
    if (!snippetCache.has(line.id)) snippetCache.set(line.id, truthSnippets(query, expected.compact));
    const want = snippetCache.get(line.id);
    // Snippets are only comparable page-for-page when the result list itself is right.
    if (!line.matchesTruth) continue;
    if (JSON.stringify(want) === JSON.stringify(line.snippets)) summary.snippetEqual++;
    else {
      summary.snippetMismatch++;
      if (summary.snippetMismatches.length < 20) {
        const page = Object.keys(want).find(key => JSON.stringify(want[key]) !== JSON.stringify(line.snippets[key]));
        const index = (want[page] ?? []).findIndex((text, position) => text !== line.snippets[page]?.[position]);
        summary.snippetMismatches.push({ id: line.id, raw: query.raw, page, index, expected: want[page]?.[index], actual: line.snippets[page]?.[index] });
      }
    }
  }
  summary.answered = seenIds.size;
  report.engines[engine] = summary;
  console.log(engine, JSON.stringify({ answered: summary.answered, errors: summary.errors, resultEqual: summary.resultEqual,
    resultMismatch: summary.resultMismatch, snippetEqual: summary.snippetEqual, snippetMismatch: summary.snippetMismatch }));
}
writeFileSync(path.join(dataDir, "correctness.json"), JSON.stringify(report, null, 1) + "\n");
