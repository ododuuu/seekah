import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { SearchSession } from "../src/search-session.js";
import { createSearchResultSet, matchingPassages } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createLegacyStore } from "./legacy-index.js";
import { createWorkbench } from "../src/workbench.js";
import { createTraceLog, readTraceLog, traceLogPath } from "../src/trace-log.js";

function document(root: string, filename: string, content: string): DocumentRecord {
  return {
    path: path.join(root, filename), filename, extension: path.extname(filename), sizeBytes: content.length,
    modifiedAtMs: 1, status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: "診斷測試", content, locationKind: "line", locationValue: "第 1 行" }],
  };
}

const phaseNames = [
  "queryNormalization", "postingsLookup", "documentEnumeration", "documentBloom", "payloadBloom",
  "payloadLookup", "payloadDecompression", "exactVerification", "resultRanking", "snippet", "other",
] as const;
const exec = promisify(execFile);
const cli = path.resolve("dist/src/cli.js");

test("chunk index trace reports candidate and verified chunks without reading payloads", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-block-trace-"));
  const root = path.join(temp, "docs");
  const store = new IndexStore(path.join(temp, "index.db"));
  await mkdir(root);
  try {
    store.upsert(document(root, "match.txt", "稀有詞 命中內容"));
    store.upsert(document(root, "other.txt", "完全不同的內容"));
    store.upsert(document(root, "third.txt", "另一份文件"));
    const resultSet = createSearchResultSet(store, "稀有詞");
    const rankingTrace = resultSet.trace;
    assert.equal(rankingTrace.schemaVersion, 5);
    assert.equal(rankingTrace.candidateStrategy, "chunk-index");
    assert.deepEqual(rankingTrace.candidateSources, ["chunk-index"]);
    assert.equal(rankingTrace.totalRelation, "eq");
    assert.equal(rankingTrace.counts.payloadsRead, 0);
    assert.equal(rankingTrace.counts.decompressedBytes, 0);
    // SPEC §52.5: one candidate chunk, decompressed once to verify the hit.
    assert.equal(rankingTrace.counts.indexCandidateChunks, 1);
    assert.equal(rankingTrace.counts.indexVerifiedChunks, 1);
    assert.ok(rankingTrace.counts.indexVerifiedBytes > 0);
    assert.ok(rankingTrace.counts.indexPostingRows >= 1);
    assert.equal(rankingTrace.counts.documentsInScope, 3);
    assert.equal(rankingTrace.counts.documentsMatched, 1);
    const page = resultSet.page(1, 20);
    assert.equal(page.results.length, 1);
    const trace = resultSet.trace;
    // Only the representative block's chunk is read again, for its snippet; no payload docstore exists.
    assert.equal(trace.counts.indexVerifiedChunks, 2);
    assert.equal(trace.diagnostics.payloadReads.snippet.payloadsRead, 0);
    assert.equal(trace.diagnostics.payloadReads.ranking.payloadsRead, 0);
    assert.ok(trace.phasesMs.postingsLookup > 0);
    for (const phase of phaseNames) assert.ok(Number.isFinite(trace.phasesMs[phase]), phase);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

// Pre-0.38.0 pipeline, still used until the chunk store migration finishes.
test("search result set exposes postings trace phases and pipeline counts", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-postings-trace-"));
  const root = path.join(temp, "docs");
  const store = createLegacyStore(path.join(temp, "index.db"));
  await mkdir(root);
  try {
    store.upsert(document(root, "match.txt", "稀有詞 命中內容"));
    store.upsert(document(root, "other.txt", "完全不同的內容"));
    store.upsert(document(root, "third.txt", "另一份文件"));
    const resultSet = createSearchResultSet(store, "稀有詞");
    const page = resultSet.page(1, 20);
    const trace = resultSet.trace;
    const storedTrace = store.lastSearchTrace();
    assert.equal(storedTrace?.query, trace.query);
    assert.equal(storedTrace?.candidateStrategy, trace.candidateStrategy);
    assert.deepEqual(storedTrace?.counts, trace.counts);
    assert.equal(page.results.length, 1);
    assert.equal(trace.type, "search");
    assert.equal(trace.query, "稀有詞");
    assert.equal(trace.normalizedQuery, "稀有詞");
    assert.equal(trace.candidateStrategy, "postings");
    assert.ok(phaseNames.includes(trace.bottleneck), trace.bottleneck);
    assert.ok(trace.candidateSources.includes("postings"));
    assert.ok(trace.candidateSources.includes("document-bloom"));
    assert.ok(trace.candidateSources.includes("payload-bloom"));
    assert.equal(trace.counts.documentsInScope, 3);
    assert.equal(trace.counts.documentsConsidered, 1);
    assert.equal(trace.counts.documentsAfterPruning, 1);
    assert.equal(trace.counts.documentsPruned, 0);
    assert.equal(trace.counts.documentsExactVerified, 1);
    assert.equal(trace.counts.documentsMatched, 1);
    assert.equal(trace.counts.results, 1);
    assert.equal(trace.counts.returnedResults, 1);
    assert.equal(trace.counts.payloadsRead, 2);
    assert.equal(trace.counts.payloadsRead, trace.counts.payloadsDecompressed);
    assert.equal(trace.counts.payloadReadPasses, 2);
    assert.equal(trace.counts.payloadsConsidered, 1);
    assert.equal(trace.counts.uniquePayloadsRead, 1);
    assert.equal(trace.counts.duplicatePayloadsRead, 1);
    assert.equal(trace.counts.postingPayloadHits, 0);
    assert.equal(trace.counts.expandedPayloads, 0);
    assert.equal(trace.counts.fullDocumentFallbacks, 0);
    assert.equal(trace.counts.filenameOnlyFallbacks, 0);
    assert.equal(trace.counts.blockExpansionRatio, 1);
    assert.equal(trace.diagnostics.payloadReads.ranking.payloadsRead, 1);
    assert.equal(trace.diagnostics.payloadReads.snippet.payloadsRead, 1);
    assert.equal(trace.diagnostics.payloadSql.payloadBlob.executeCount, 2);
    assert.equal(trace.counts.selectedPayloadsRead + trace.counts.expandedPayloads
      + trace.counts.fullFallbackPayloads, trace.counts.payloadsRead);
    assert.equal(trace.counts.candidatePayloadOrdinals, 2);
    assert.equal(trace.counts.blockExpansionInputPayloads, 2);
    assert.equal(trace.counts.owningBlocksFound, 2);
    assert.equal(trace.counts.blocksMetadataRows, 3);
    assert.equal(trace.counts.owningBlockMappingRows, 1);
    assert.equal(trace.counts.uniquePayloadsRead + trace.counts.duplicatePayloadsRead, trace.counts.payloadsRead);
    assert.ok(trace.phasesMs.exactVerification >= trace.phaseSelfMs.exactVerification);
    assert.equal(trace.bottleneck in trace.phasesMs, true);
    assert.equal(trace.inclusiveBottleneck in trace.phasesMs, true);
    assert.ok(trace.phasesMs.payloadDecompression >= 0);
    assert.ok(trace.phaseSelfMs.payloadDecompression >= 0);
    assert.ok(trace.phasesMs.snippet > 0);
    for (const phase of phaseNames) {
      assert.ok(Number.isFinite(trace.phasesMs[phase]), phase);
      assert.ok(Number.isFinite(trace.phaseSelfMs[phase]), `${phase} self`);
    }
    assert.ok(trace.durationMs >= trace.phasesMs.queryNormalization);
    const passages = matchingPassages(store, "稀有詞", path.join(root, "match.txt"));
    assert.equal(passages.length, 1);
    const passageTrace = store.lastSearchTrace();
    assert.equal(passageTrace?.candidateStrategy, "restricted-ids");
    assert.equal(passageTrace?.counts.documentsInScope, 1);
    assert.equal(passageTrace?.counts.documentsExactVerified, 1);
    assert.equal(passageTrace?.counts.results, 1);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("search trace preserves zero-result and duration boundaries", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-empty-trace-"));
  const root = path.join(temp, "docs");
  const store = new IndexStore(path.join(temp, "index.db"));
  await mkdir(root);
  try {
    store.upsert(document(root, "one.txt", "已索引文件"));
    store.upsert(document(root, "two.txt", "另一份內容"));
    const resultSet = createSearchResultSet(store, "不存在的查詢");
    const page = resultSet.page(1, 20);
    const trace = resultSet.trace;
    assert.equal(page.results.length, 0);
    assert.equal(trace.counts.documentsInScope, 2);
    assert.equal(trace.counts.documentsConsidered, 0);
    assert.equal(trace.counts.documentsExactVerified, 0);
    assert.equal(trace.counts.documentsMatched, 0);
    assert.equal(trace.counts.results, 0);
    assert.equal(trace.counts.returnedResults, 0);
    assert.ok(Number.isFinite(trace.durationMs) && trace.durationMs >= 0);
    assert.ok(trace.phasesMs.other >= 0);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("search trace identifies Bloom fallback pruning when postings are unavailable", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-fallback-trace-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "index.db");
  const writer = createLegacyStore(databasePath);
  await mkdir(root);
  try {
    writer.upsert(document(root, "match.txt", "稀有詞 命中內容"));
    writer.upsert(document(root, "other.txt", "完全不同的內容"));
    writer.upsert(document(root, "third.txt", "另一份文件"));
    writer.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE metadata SET value = '0' WHERE key = 'ngram_index_version'").run();
    raw.exec("DELETE FROM search_unigrams; DELETE FROM search_trigrams; DELETE FROM index_migration_documents WHERE version = 'ngram_1'");
    raw.close();

    const store = new IndexStore(databasePath, { readOnly: true });
    try {
      const resultSet = createSearchResultSet(store, "稀有詞");
      const page = resultSet.page(1, 20);
      const trace = resultSet.trace;
      assert.equal(page.results.length, 1);
      assert.equal(trace.candidateStrategy, "bloom-fallback");
      assert.ok(trace.candidateSources.includes("bloom-fallback"));
      assert.equal(trace.counts.documentsInScope, 3);
      assert.equal(trace.counts.documentsConsidered, 3);
      assert.equal(trace.counts.documentsAfterPruning, 1);
      assert.equal(trace.counts.documentsPruned, 2);
      assert.equal(trace.counts.documentsExactVerified, 1);
      assert.equal(trace.counts.results, 1);
    } finally {
      store.close();
    }
  } finally {
    if (writer) {
      try { writer.close(); } catch { /* 已關閉 */ }
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("SearchSession keeps the current refinement trace and exposes restricted postings", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-session-trace-"));
  const root = path.join(temp, "docs");
  const store = new IndexStore(path.join(temp, "index.db"));
  await mkdir(root);
  try {
    store.upsert(document(root, "one.txt", "第一詞 第二詞"));
    store.upsert(document(root, "two.txt", "第一詞 其他內容"));
    const session = new SearchSession(store, "第一詞");
    session.page(1, 20);
    session.append("第二詞");
    const page = session.page(1, 20);
    assert.equal(page.results.length, 1);
    assert.equal(session.trace.candidateStrategy, "chunk-index+restricted-ids");
    assert.ok(session.trace.candidateSources.includes("restricted-ids"));
    assert.ok(session.trace.candidateSources.includes("chunk-index"));
    assert.equal(session.trace.counts.documentsInScope, 2);
    assert.equal(session.trace.counts.results, 1);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
test("CLI --verbose emits the structured search trace without writing index state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-cli-trace-"));
  const root = path.join(temp, "docs");
  const dataDir = path.join(temp, "data");
  const databasePath = path.join(dataDir, "LocalDocSearch", "index.db");
  await mkdir(root);
  const store = new IndexStore(databasePath);
  try {
    store.registerRoot(root);
    store.upsert(document(root, "match.txt", "稀有詞 命中內容"), root);
  } finally {
    store.close();
  }
  try {
    const result = await exec(process.execPath, [cli, "search", "稀有詞", "--limit", "1", "--verbose"], {
      env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir },
    });
    const line = result.stderr.split(/\r?\n/u).find(value => value.startsWith("SEARCH_TRACE "));
    assert.ok(line);
    const trace = JSON.parse(line.slice("SEARCH_TRACE ".length)) as { type: string; candidateStrategy: string; counts: { results: number } };
    assert.equal(trace.type, "search");
    assert.equal(trace.candidateStrategy, "chunk-index");
    assert.equal(trace.counts.results, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("independent Trace UI serves persisted search records through the protected API", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-trace-ui-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "data", "LocalDocSearch", "index.db");
  await mkdir(root, { recursive: true });
  const store = new IndexStore(databasePath);
  store.registerRoot(root);
  store.upsert(document(root, "match.txt", "稀有詞 命中內容"), root);
  store.close();
  const handle = await createWorkbench({ databasePath, port: 0 });
  const origin = new URL(handle.url).origin;
  const headers = {
    "content-type": "application/json",
    "origin": origin,
    "X-LocalDocSearch-Token": handle.token,
  };
  try {
    const page = await fetch(origin + "/traces");
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Trace 診斷/u);
    assert.match(pageText, /\/api\/traces/u);

    const searchResponse = await fetch(origin + "/api/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "稀有詞", mode: "phrase", page: 1, pageSize: 20, field: "all", sort: "relevance" }),
    });
    assert.equal(searchResponse.status, 200);
    assert.equal((await searchResponse.json() as { results: unknown[] }).results.length, 1);

    const traceResponse = await fetch(origin + "/api/traces?type=search&limit=10", {
      headers: { "X-LocalDocSearch-Token": handle.token },
    });
    assert.equal(traceResponse.status, 200);
    const traceData = await traceResponse.json() as {
      path: string;
      files: { path: string; bytes: number; current: boolean }[];
      traces: { type: string; traceId: string; candidateStrategy: string; counts: { results: number } }[];
      retention: { maxFiles: number; maxFileBytes: number };
    };
    assert.equal(traceData.path, traceLogPath(path.dirname(databasePath)));
    assert.ok(traceData.files.some(file => file.current && file.bytes > 0));
    assert.equal(traceData.retention.maxFiles, 5);
    assert.equal(traceData.traces[0]?.type, "search");
    assert.equal(traceData.traces[0]?.candidateStrategy, "chunk-index");
    assert.equal(traceData.traces[0]?.counts.results, 1);
    assert.ok(traceData.traces[0]?.traceId);
    assert.match(await readFile(traceData.path, "utf8"), /"type":"search"/u);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("trace JSONL log rotates within the bounded retention window", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m39-trace-log-"));
  try {
    const log = createTraceLog(temp);
    const store = new IndexStore(path.join(temp, "index.db"));
    const base = new SearchSession(store, "rotation").trace;
    store.close();
    for (let index = 0; index < 180; index++) {
      log.write({ ...base, traceId: `${base.traceId}-${index}`, query: `${index}-${"x".repeat(64 * 1024)}` });
    }
    assert.equal(log.failed, false);
    assert.ok((await readFile(traceLogPath(temp, 4), "utf8")).length > 0);
    const snapshot = readTraceLog(temp, { limit: 500 });
    assert.equal(snapshot.files.length, 5);
    assert.ok(snapshot.traces.length > 0 && snapshot.traces.length <= 500);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
