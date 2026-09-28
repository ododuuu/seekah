import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildChunks, CHUNK_TARGET_UNITS, decodeChunk } from "../src/chunk-store.js";
import { searchDocuments } from "../src/mcp-tools.js";
import type { DocumentRecord, TextBlock } from "../src/model.js";
import { OperationCancelledError } from "../src/progress.js";
import { collectHits, createSearchResultSet, FAST_TOTAL_LIMIT, openHits, search } from "../src/search.js";
import { SearchSession } from "../src/search-session.js";
import { IndexStore } from "../src/store.js";
import { clearChunkStore, createBlockIndexStore, createLegacyStore } from "./legacy-index.js";

// SPEC §52: chunk store, positionless chunk index, lazy results and total modes.

function count(databasePath: string, sql: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return Number(Object.values(db.prepare(sql).get()!)[0]); } finally { db.close(); }
}

function document(root: string, filename: string, blocks: TextBlock[], modifiedAtMs = 1): DocumentRecord {
  return { path: path.join(root, filename), filename, extension: path.extname(filename) || ".txt", sizeBytes: 1, modifiedAtMs,
    status: blocks.length ? "indexed" : "unsupported", errorCode: null, errorMessage: null, blocks };
}

const line = (ordinal: number, content: string): TextBlock => ({ ordinal, heading: null, content, locationKind: "line", locationValue: `第 ${ordinal + 1} 行` });

test("chunks keep every block, split near the target, and store only metadata that cannot be derived", () => {
  const huge = "巨".repeat(CHUNK_TARGET_UNITS + 10);
  const blocks: TextBlock[] = [
    line(0, "first"),
    { ordinal: 2, heading: null, content: "gap before", locationKind: "line", locationValue: "第 3 行" },
    { ordinal: 3, heading: "章節", content: "under heading", locationKind: "section", locationValue: "第 7 行" },
    { ordinal: 4, heading: "只有標題", content: "", locationKind: "section", locationValue: "第 9 行" },
    { ordinal: 5, heading: null, content: huge, locationKind: "line", locationValue: "第 6 行" },
    ...Array.from({ length: 3000 }, (_, index) => line(6 + index, `line ${index} ${"x".repeat(40)}`)),
    { ordinal: 3006, heading: null, content: "cell", locationKind: "sheet_cell", locationValue: "Sheet1!A1" },
    { ordinal: 3007, heading: null, content: "moved", locationKind: "line", locationValue: "第 1 行" },
  ];
  const { chunks, meta } = buildChunks(blocks);
  assert.deepEqual(meta.map(row => row.ordinal), [3, 4, 3006, 3007]);
  const decoded = chunks.flatMap(chunk => decodeChunk(chunk.text, chunk.layout));
  assert.deepEqual(decoded, blocks.filter(block => block.content).map(block => ({ ordinal: block.ordinal, content: block.content })));
  // The oversized block owns its chunk; every chunk records its first ordinal.
  const own = chunks.find(chunk => decodeChunk(chunk.text, chunk.layout).some(block => block.ordinal === 5))!;
  assert.deepEqual(decodeChunk(own.text, own.layout).map(block => block.ordinal), [5]);
  for (const chunk of chunks) assert.equal(chunk.ordinal, decodeChunk(chunk.text, chunk.layout)[0]!.ordinal);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    const blocksInChunk = decodeChunk(chunk.text, chunk.layout);
    if (blocksInChunk.length > 1) assert.ok(blocksInChunk.reduce((sum, block) => sum + block.content.length + 1, 0) <= CHUNK_TARGET_UNITS + 1);
  }
});

test("stored documents rebuild identical blocks, locations and snippets from chunks", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m42-blocks-"));
  const databasePath = path.join(temp, "index.db");
  const store = new IndexStore(databasePath);
  try {
    const blocks: TextBlock[] = [
      { ordinal: 0, heading: "標題一", content: "", locationKind: "section", locationValue: "第 1 行" },
      { ordinal: 1, heading: "標題一", content: "alpha-token 內容", locationKind: "section", locationValue: "第 2 行" },
      line(2, "plain beta-token line"),
      { ordinal: 3, heading: null, content: `${"長".repeat(CHUNK_TARGET_UNITS)}gamma-token`, locationKind: "page", locationValue: "第 2 頁" },
      line(4, "delta-token after the large block"),
    ];
    store.registerRoot(temp);
    store.upsert(document(temp, "doc.md", blocks), temp);
    const id = store.getDocument(path.join(temp, "doc.md"))!.id;
    assert.deepEqual(store.documentBlocks(id).map(block => ({ ordinal: block.ordinal, heading: block.heading, content: block.content,
      locationKind: block.location_kind, locationValue: block.location_value })), blocks);
    for (const block of blocks.filter(item => item.content)) assert.equal(store.blockSource(id, block.ordinal, "content"), block.content);
    assert.equal(store.blockSource(id, 0, "heading"), "標題一");
    const [gamma] = search(store, "gamma-token");
    assert.equal(gamma?.location, "第 2 頁");
    assert.match(gamma?.snippet ?? "", /gamma-token/u);
    assert.equal(search(store, "delta-token")[0]?.location, "第 5 行");
    assert.equal(count(databasePath, "SELECT count(*) FROM block_meta"), 3);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("fast mode stops at 500 matches with a lower bound; exact mode and pages agree with the complete list", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m42-total-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    store.registerRoot(temp);
    for (let index = 0; index < 620; index++) {
      store.upsert(document(temp, `${String(index).padStart(4, "0")}.txt`,
        [line(0, index % 5 === 0 ? `common-token rare-${index}` : `common-token filler`)], 10_000 - index), temp);
    }
    const complete = collectHits(store, "common-token");
    assert.equal(complete.length, 620);
    const fast = createSearchResultSet(store, "common-token");
    assert.equal(fast.totalRelation, "gte");
    assert.equal(fast.total, FAST_TOTAL_LIMIT);
    assert.equal(store.lastSearchTrace()?.totalRelation, "gte");
    assert.equal(store.lastSearchTrace()?.candidateStrategy, "chunk-index");
    const exact = createSearchResultSet(store, "common-token", undefined, undefined, "phrase", undefined, "all", undefined, "relevance", "exact");
    assert.deepEqual([exact.total, exact.totalRelation], [620, "eq"]);
    // Pages past the fast limit are verified on demand and match the complete order.
    const page = fast.page(31, 20);
    assert.deepEqual(page.results.map(result => result.path), complete.slice(600, 620).map(item => item.result.path));
    assert.deepEqual(fast.page(1, 20).results.map(result => result.path), complete.slice(0, 20).map(item => item.result.path));
    // Few matches: fast mode is exact.
    const rare = createSearchResultSet(store, "rare-615");
    assert.deepEqual([rare.total, rare.totalRelation], [1, "eq"]);

    const mcp = searchDocuments(store, { query: "common-token" });
    assert.deepEqual([mcp.total, mcp.totalRelation, mcp.accessibleTotal, mcp.truncatedToFirst500], [500, "gte", 500, true]);
    const mcpExact = searchDocuments(store, { query: "common-token", exactTotal: true });
    assert.deepEqual([mcpExact.total, mcpExact.totalRelation], [620, "eq"]);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("search within results filters the previous layer lazily and matches the restricted complete list", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m42-narrow-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    store.registerRoot(temp);
    for (let index = 0; index < 700; index++) {
      const blocks = [line(0, `outer-token ${index % 3 === 0 ? "inner-token" : "other"}`)];
      if (index % 7 === 0) blocks.push({ ordinal: 1, heading: "inner-token 章", content: "heading body", locationKind: "section", locationValue: "x" });
      store.upsert(document(temp, `${String(index).padStart(4, "0")}.md`, blocks, index), temp);
    }
    const outer = collectHits(store, "outer-token");
    const expected = collectHits(store, "inner-token", undefined, undefined, "phrase", outer.map(item => item.documentId));
    const session = new SearchSession(store, "outer-token");
    assert.equal(session.originalTotalRelation, "gte");
    session.append("inner-token");
    const narrowed = openHits(store, "inner-token", { within: openHits(store, "outer-token") });
    narrowed.fill(Number.POSITIVE_INFINITY);
    assert.deepEqual(narrowed.results.map(item => [item.documentId, item.result.rank, item.ordinal]),
      expected.map(item => [item.documentId, item.result.rank, item.ordinal]));
    const first = session.page(1, 20);
    assert.deepEqual(first.results.map(result => result.path), expected.slice(0, 20).map(item => item.result.path));
    const exactSession = new SearchSession(store, "outer-token", undefined, undefined, "phrase", undefined, "all", undefined, "relevance", "exact");
    exactSession.append("inner-token");
    assert.deepEqual([exactSession.currentTotal, exactSession.currentTotalRelation], [expected.length, "eq"]);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

async function migrationCase(label: string, create: (databasePath: string) => IndexStore) {
  const temp = await mkdtemp(path.join(os.tmpdir(), `lds-m42-${label}-`));
  const databasePath = path.join(temp, "index.db");
  try {
    const old = create(databasePath);
    const docs = Array.from({ length: 300 }, (_, index) => document(temp, `${index}.md`, [
      { ordinal: 0, heading: index % 4 === 0 ? "舊標題" : null, content: `保留的正文 token-${index}`, locationKind: index % 4 === 0 ? "section" : "line",
        locationValue: index % 4 === 0 ? "第 3 行" : "第 1 行" },
      line(1, index % 2 ? "second line even" : "second line odd"),
    ]));
    try {
      old.registerRoot(temp);
      for (const item of docs) old.upsert(item, temp);
    } finally { old.close(); }
    clearChunkStore(databasePath);
    // Read-only before migration: the pre-0.39 path, no writes.
    const readOnly = new IndexStore(databasePath, { readOnly: true });
    let before: unknown;
    try {
      assert.equal(readOnly.chunkStoreReady(), false);
      assert.equal(readOnly.formatStatus().needsUpgrade, true);
      before = ["保留的正文", "舊標題", "second line odd", "token-7"].map(query => collectHits(readOnly, query)
        .map(item => [item.documentId, item.result.rank, item.ordinal, item.result.heading, item.result.location]));
    } finally { readOnly.close(); }
    assert.equal(count(databasePath, "SELECT count(*) FROM document_chunks"), 0);

    // Cancel after the first batch, then resume.
    const store = new IndexStore(databasePath);
    try {
      const controller = new AbortController();
      await assert.rejects(store.upgrade({ signal: controller.signal, onProgress: update => {
        if (update.stage === "upgrade" && (update.current ?? 0) >= 256) controller.abort();
      } }), OperationCancelledError);
      assert.ok(count(databasePath, "SELECT count(*) FROM index_migration_documents WHERE version = 'chunk_store_1'") >= 256);
      assert.equal(store.chunkStoreReady(), false);
      await store.upgrade();
      assert.equal(store.chunkStoreReady(), true);
      assert.equal(store.formatStatus().needsUpgrade, false);
      assert.equal(store.formatStatus().legacySearchStructures, false);
      const after = ["保留的正文", "舊標題", "second line odd", "token-7"].map(query => collectHits(store, query)
        .map(item => [item.documentId, item.result.rank, item.ordinal, item.result.heading, item.result.location]));
      assert.deepEqual(after, before);
      assert.ok(store.freePageRatio() < 0.5);
    } finally { store.close(); }
    assert.equal(count(databasePath, `SELECT count(*) FROM sqlite_master WHERE name IN ('blocks', 'block_payloads', 'document_payloads',
      'document_payload_blocks', 'search_block_trigrams', 'document_blooms', 'search_trigrams')`), 0);
    assert.equal(count(databasePath, "SELECT count(*) FROM index_migration_documents"), 0);
    assert.equal(count(databasePath, "SELECT count(*) FROM metadata WHERE key IN ('block_index_version', 'payload_bloom_version', 'ngram_index_version')"), 0);
    // Reopening a migrated index does not recreate the old tables.
    new IndexStore(databasePath).close();
    assert.equal(count(databasePath, "SELECT count(*) FROM sqlite_master WHERE name = 'blocks'"), 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("a 0.38 block index migrates to the chunk store, resumes after cancellation and drops old tables", async () => {
  await migrationCase("block", createBlockIndexStore);
});

test("a pre-0.38 index migrates straight to the chunk store", async () => {
  await migrationCase("legacy", createLegacyStore);
});

test("the workbench total mode setting defaults to fast and persists exact", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m42-setting-"));
  const databasePath = path.join(temp, "index.db");
  try {
    const store = new IndexStore(databasePath);
    try {
      assert.equal(store.searchTotalMode(), "fast");
      store.setSearchTotalMode("exact");
    } finally { store.close(); }
    const readOnly = new IndexStore(databasePath, { readOnly: true });
    try { assert.equal(readOnly.searchTotalMode(), "exact"); } finally { readOnly.close(); }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
