import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchDocuments } from "../src/mcp-tools.js";
import { makeSnippet, normalize, collectHits, createSearchResultSet, type RankedSearchResult, type SearchField, type SearchMode, type SearchResult } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import type { DocumentRecord, DocumentStatus, TextBlock } from "../src/model.js";
import { createBlockIndexStore, createLegacyStore } from "./legacy-index.js";
import { createWorkbench } from "../src/workbench.js";

function block(ordinal: number, content: string, heading: string | null = null): TextBlock {
  return { ordinal, heading, content, locationKind: "line", locationValue: `第 ${ordinal + 1} 行` };
}

function document(root: string, filename: string, blocks: TextBlock[], modifiedAtMs: number,
  status: DocumentStatus = "indexed"): DocumentRecord {
  return {
    path: path.join(root, filename), filename, extension: path.extname(filename) || ".txt",
    sizeBytes: blocks.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0), modifiedAtMs,
    status, errorCode: null, errorMessage: null, blocks,
  };
}

function corpus(root: string): DocumentRecord[] {
  return [
    document(root, "multi.txt", [block(0, "private FIRST"), block(1, "中間行"), block(2, "node LAST")], 100),
    document(root, "same.txt", [block(0, "private and node and private")], 99),
    document(root, "adjacent.txt", [block(0, "private adjacent"), block(1, "node adjacent")], 98),
    document(root, "repeat.txt", [block(0, "private first"), block(1, "沒有關鍵字"), block(2, "private second"), block(3, "node last")], 97),
    document(root, "unicode.txt", [block(0, "ＰＲＩＶＡＴＥ ｎｏｄｅ 全形")], 96),
    document(root, "five.txt", [block(0, "alpha"), block(1, "beta"), block(2, "gamma"), block(3, "delta"), block(4, "epsilon")], 95),
    document(root, "filename-only-private-node.dat", [], 94, "unsupported"),
    document(root, "filename-only-alpha-beta-gamma-delta-epsilon.dat", [], 93, "unsupported"),
    document(root, "content-only.txt", [block(0, "private content first"), block(1, "中間"), block(2, "node content last")], 93),
    document(root, "mixed-private.txt", [block(0, "node only")], 92),
    document(root, "heading.txt", [block(0, "node body", "Private heading")], 91),
  ];
}

type Shape = "current" | "block-index" | "legacy";

type M76Projection = {
  ranked: Array<{ documentId: number; ordinal: number | null; sourceKind: RankedSearchResult["sourceKind"]; result: Record<string, unknown> }>;
  page: Record<string, unknown>[];
  total: number;
  totalRelation: "eq" | "gte";
};

function createShape(shape: Shape, databasePath: string): IndexStore {
  if (shape === "current") return new IndexStore(databasePath);
  return shape === "block-index" ? createBlockIndexStore(databasePath) : createLegacyStore(databasePath);
}

async function createFixtures() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m76-"));
  const root = path.join(temp, "文件");
  await mkdir(root, { recursive: true });
  const records = corpus(root);
  const stores = new Map<Shape, IndexStore>();
  for (const shape of ["current", "block-index", "legacy"] as const) {
    const store = createShape(shape, path.join(temp, `${shape}.db`));
    store.registerRoot(root);
    for (const item of records) store.upsert(item, root);
    stores.set(shape, store);
  }
  return { temp, root, records, stores };
}

function page(store: IndexStore, query: string, mode: SearchMode = "all-terms", field: SearchField = "all") {
  const resultSet = createSearchResultSet(store, query, undefined, undefined, mode, undefined, field,
    undefined, "relevance", "exact");
  return { resultSet, page: resultSet.page(1, 20) };
}

function byName(results: readonly SearchResult[], filename: string): SearchResult {
  const result = results.find(item => path.basename(item.path) === filename);
  assert.ok(result, `missing ${filename}`);
  return result;
}

function stripAdded(result: SearchResult): Record<string, unknown> {
  const copy = { ...result } as Record<string, unknown>;
  delete copy.passages;
  delete copy.omittedTerms;
  return copy;
}

function queryTerms(query: string, mode: SearchMode): string[] {
  const normalized = normalize(query.trim());
  return mode === "all-terms"
    ? [...new Set(query.trim().split(/\s+/u).map(normalize).filter(Boolean))]
    : [normalized];
}

function legacyMaterialized(store: IndexStore, ranked: readonly RankedSearchResult[], query: string, mode: SearchMode,
  pageNumber: number, pageSize: number): Record<string, unknown>[] {
  const terms = queryTerms(query, mode);
  const offset = (pageNumber - 1) * pageSize;
  return ranked.slice(offset, offset + pageSize).map(item => {
    const source = item.sourceKind === "filename" ? path.basename(item.result.path)
      : item.ordinal === null ? path.basename(item.result.path)
        : store.blockSource(item.documentId, item.ordinal, item.sourceKind) ?? path.basename(item.result.path);
    const term = terms.map((value, index) => ({ value, index, position: normalize(source).indexOf(value) }))
      .filter(hit => hit.position >= 0)
      .sort((left, right) => left.position - right.position || left.index - right.index)[0]!.value;
    const snippet = makeSnippet(source, term);
    return { ...item.result, snippet: snippet.text, snippetTruncated: snippet.truncated };
  });
}

function resultProjection(store: IndexStore, query: string, mode: SearchMode, field: SearchField = "all"): M76Projection {
  const ranked = collectHits(store, query, undefined, undefined, mode, undefined, undefined, field);
  const resultSet = createSearchResultSet(store, query, undefined, undefined, mode, undefined, field,
    undefined, "relevance", "exact");
  const resultPage = resultSet.page(1, 20);
  return {
    ranked: ranked.map(item => ({ documentId: item.documentId, ordinal: item.ordinal, sourceKind: item.sourceKind,
      result: stripAdded(item.result as SearchResult) })),
    page: resultPage.results.map(stripAdded),
    total: resultSet.total,
    totalRelation: resultSet.totalRelation,
  };
}

test("M76 all-terms passages work across current, block-index and legacy stores", async t => {
  const fixture = await createFixtures();
  t.after(() => {
    for (const store of fixture.stores.values()) store.close();
    return rm(fixture.temp, { recursive: true, force: true });
  });

  const projections = new Map<Shape, M76Projection>();
  for (const [shape, store] of fixture.stores) {
    assert.equal(shape === "current", store.chunkStoreReady());
    if (shape !== "current") assert.equal(store.chunkStoreReady(), false);
    const found = page(store, "private node");
    projections.set(shape, resultProjection(store, "private node", "all-terms"));

    const multi = byName(found.page.results, "multi.txt");
    assert.deepEqual(multi.passages?.map(passage => passage.terms), [["private"], ["node"]]);
    assert.deepEqual(multi.passages?.map(passage => passage.location), ["第 1 行", "第 3 行"]);
    assert.match(multi.passages?.[0]?.snippet ?? "", /private/u);
    assert.match(multi.passages?.[1]?.snippet ?? "", /node/u);

    const same = byName(found.page.results, "same.txt");
    assert.equal(same.passages?.length, 1);
    assert.deepEqual(same.passages?.[0]?.terms, ["private", "node"]);
    assert.match(same.passages?.[0]?.snippet ?? "", /private/u);
    assert.match(same.passages?.[0]?.snippet ?? "", /node/u);

    const adjacent = byName(found.page.results, "adjacent.txt");
    assert.equal(adjacent.passages?.length, 1);
    assert.deepEqual(adjacent.passages?.[0]?.terms, ["private", "node"]);
    assert.match(adjacent.passages?.[0]?.snippet ?? "", /private/u);
    assert.match(adjacent.passages?.[0]?.snippet ?? "", /node/u);
    assert.equal(adjacent.passages?.[0]?.location, "第 1 行");

    const repeated = byName(found.page.results, "repeat.txt");
    assert.deepEqual(repeated.passages?.map(passage => passage.location), ["第 3 行"]);
    assert.deepEqual(repeated.passages?.map(passage => passage.terms), [["private", "node"]]);

    const mixed = byName(found.page.results, "mixed-private.txt");
    assert.deepEqual(mixed.passages?.flatMap(passage => passage.terms), ["node"]);

    const heading = byName(found.page.results, "heading.txt");
    assert.deepEqual(heading.passages?.map(passage => passage.terms), [["private", "node"]]);
    assert.equal(heading.passages?.[0]?.heading, "Private heading");
    assert.equal(heading.passages?.[0]?.location, "第 1 行");

    const filenameOnly = byName(found.page.results, "filename-only-private-node.dat");
    assert.equal(filenameOnly.filenameOnly, true);
    assert.deepEqual(filenameOnly.passages, []);
    assert.equal(filenameOnly.omittedTerms, 0);
  }

  assert.deepEqual(projections.get("block-index"), projections.get("current"));
  assert.deepEqual(projections.get("legacy"), projections.get("current"));
});

test("M76 passage term cap, Unicode normalization, fields and phrase compatibility", async t => {
  const fixture = await createFixtures();
  t.after(() => {
    for (const store of fixture.stores.values()) store.close();
    return rm(fixture.temp, { recursive: true, force: true });
  });
  const store = fixture.stores.get("current")!;

  const unicode = byName(page(store, "ｐｒｉｖａｔｅ ＮＯＤＥ").page.results, "unicode.txt");
  assert.equal(unicode.omittedTerms, 0);
  assert.deepEqual(unicode.passages?.map(passage => passage.terms), [["private", "node"]]);
  assert.match(unicode.passages?.[0]?.snippet ?? "", /ＰＲＩＶＡＴＥ/u);

  const five = byName(page(store, "alpha beta gamma delta epsilon").page.results, "five.txt");
  assert.equal(five.omittedTerms, 1);
  assert.deepEqual(five.passages?.flatMap(passage => passage.terms), ["alpha", "beta", "gamma", "delta"]);
  assert.equal(five.passages?.some(passage => passage.terms.includes("epsilon")), false);

  const filenameCap = byName(page(store, "alpha beta gamma delta epsilon").page.results,
    "filename-only-alpha-beta-gamma-delta-epsilon.dat");
  assert.equal(filenameCap.omittedTerms, 1);
  assert.deepEqual(filenameCap.passages, []);

  const filenameField = page(store, "private node", "all-terms", "filename").page.results;
  assert.equal(filenameField.length, 1);
  assert.equal(filenameField[0]!.filenameOnly, true);
  assert.deepEqual(filenameField[0]!.passages, []);

  const contentField = page(store, "private node", "all-terms", "content").page.results;
  assert.equal(contentField.some(item => path.basename(item.path) === "filename-only-private-node.dat"), false);
  assert.ok(contentField.every(item => (item.passages ?? []).length > 0));

  const missing = page(store, "passage-does-not-exist").page;
  assert.equal(missing.total, 0);
  assert.deepEqual(missing.results, []);

  const phrase = byName(page(store, "private FIRST", "phrase").page.results, "multi.txt");
  assert.ok((phrase.passages ?? []).length <= 1);
  assert.equal(phrase.passages?.[0]?.snippet, phrase.snippet);
  assert.deepEqual(phrase.passages?.[0]?.terms, ["private first"]);

  const phraseFilename = byName(page(store, "private-node", "phrase").page.results, "filename-only-private-node.dat");
  assert.deepEqual(phraseFilename.passages, []);
});

test("M76 materialization is page-only and preserves old result projections and totals", async t => {
  const fixture = await createFixtures();
  t.after(() => {
    for (const store of fixture.stores.values()) store.close();
    return rm(fixture.temp, { recursive: true, force: true });
  });
  const store = fixture.stores.get("current")!;
  const query = "private node";
  const ranked = collectHits(store, query, undefined, undefined, "all-terms");
  const resultSet = createSearchResultSet(store, query, undefined, undefined, "all-terms", undefined,
    "all", undefined, "relevance", "exact");
  const before = [resultSet.total, resultSet.totalRelation];
  const page = resultSet.page(1, 20);
  assert.deepEqual([resultSet.total, resultSet.totalRelation], before);
  assert.deepEqual(page.results.map(stripAdded), legacyMaterialized(store, ranked, query, "all-terms", 1, 20));

  const counted: { value: number } = { value: 0 };
  const instrumented = store as unknown as { candidateByPath: typeof store.candidateByPath };
  const original = store.candidateByPath.bind(store);
  instrumented.candidateByPath = (filePath, trace) => {
    counted.value++;
    return original(filePath, trace);
  };
  try {
    const bulkRoot = path.join(fixture.temp, "bulk");
    await mkdir(bulkRoot, { recursive: true });
    store.registerRoot(bulkRoot);
    for (let index = 0; index < 520; index++) {
      store.upsert(document(bulkRoot, `bulk-${String(index).padStart(4, "0")}.txt`,
        [block(0, `common token ${index}`)], 1_000 - index), bulkRoot);
    }
    const fast = createSearchResultSet(store, "common token", undefined, undefined, "all-terms");
    assert.deepEqual([fast.total, fast.totalRelation], [500, "gte"]);
    assert.equal(counted.value, 0);
    const firstPage = fast.page(1, 20);
    assert.equal(firstPage.results.length, 20);
    assert.equal(counted.value, 20);
    assert.deepEqual([fast.total, fast.totalRelation], [500, "gte"]);
  } finally {
    instrumented.candidateByPath = original;
  }
});

test("M76 Workbench API, MCP search_documents and CLI expose appended passages", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m76-api-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "workbench.db");
  await mkdir(root, { recursive: true });
  const store = new IndexStore(databasePath);
  try {
    store.registerRoot(root);
    for (const item of corpus(root)) store.upsert(item, root);
    const mcp = searchDocuments(store, { query: "private node", mode: "all-terms", page: 1, pageSize: 20, exactTotal: true });
    const mcpHit = mcp.results.find(item => path.basename(item.path) === "multi.txt");
    assert.ok(mcpHit);
    assert.deepEqual(mcpHit.passages.map(passage => passage.terms), [["private"], ["node"]]);
    assert.equal(mcpHit.omittedTerms, 0);
  } finally {
    store.close();
  }

  const handle = await createWorkbench({ databasePath, port: 0 });
  try {
    const origin = new URL(handle.url).origin;
    const response = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "X-LocalDocSearch-Token": handle.token },
      body: JSON.stringify({ query: "private node", mode: "all-terms", page: 1, pageSize: 20, field: "all", sort: "relevance" }),
    });
    assert.equal(response.status, 200);
    const data = await response.json() as { results: Array<{ path: string; passages: Array<{ terms: string[] }>; omittedTerms: number }> };
    const workbenchHit = data.results.find(item => path.basename(item.path) === "multi.txt");
    assert.ok(workbenchHit);
    assert.deepEqual(workbenchHit.passages.map(passage => passage.terms), [["private"], ["node"]]);
    assert.equal(workbenchHit.omittedTerms, 0);
  } finally {
    await handle.close();
  }

  const cliData = path.join(temp, "cli-data");
  const cliDatabase = path.join(cliData, "LocalDocSearch", "index.db");
  await mkdir(path.dirname(cliDatabase), { recursive: true });
  const cliStore = new IndexStore(cliDatabase);
  try {
    cliStore.registerRoot(root);
    for (const item of corpus(root)) cliStore.upsert(item, root);
  } finally {
    cliStore.close();
  }
  const cli = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "search", "private node", "--all-terms", "--limit", "20"], {
    cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: cliData },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /詞段落（/u);
  assert.match(cli.stdout, /private/u);
  assert.match(cli.stdout, /node/u);
  await rm(temp, { recursive: true, force: true });
});
