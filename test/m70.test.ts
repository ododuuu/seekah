import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord, DocumentStatus, TextBlock } from "../src/model.js";
import {
  collectHits, createSearchResultSet, materializeHits,
  type SearchField, type SearchMode, type SearchSort,
} from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createBlockIndexStore } from "./legacy-index.js";

// SPEC §76／D108：phrase chunk／heading posting 批次化仍須與既有逐文件路徑等價。

const LONG_QUERY = "4564654564651431321";
const LONG_GRAMS = [...new Set(Array.from({ length: LONG_QUERY.length - 2 }, (_, index) =>
  LONG_QUERY.slice(index, index + 3)))];

type Options = {
  mode?: SearchMode;
  field?: SearchField;
  sort?: SearchSort;
  subtree?: string;
};

type Projection = {
  ranked: unknown[];
  all: unknown[];
  page1: unknown[];
  page2: unknown[];
};

function line(ordinal: number, content: string): TextBlock {
  return { ordinal, heading: null, content, locationKind: "line", locationValue: `第 ${ordinal + 1} 行` };
}

function document(root: string, relativePath: string, blocks: TextBlock[], modifiedAtMs: number,
  status: DocumentStatus = "indexed"): DocumentRecord {
  const filename = path.basename(relativePath);
  return {
    path: path.join(root, relativePath), filename, extension: path.extname(filename) || ".txt",
    sizeBytes: blocks.reduce((size, block) => size + Buffer.byteLength(block.content, "utf8"), 0),
    modifiedAtMs, status, errorCode: null, errorMessage: null, blocks,
  };
}

function corpus(root: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (let index = 0; index < 24; index++) {
    documents.push(document(root, `false-positive-${String(index).padStart(2, "0")}.txt`, [line(0,
      `false ${LONG_GRAMS.join(" ")} seekah notes-${index}`)], 2_000_000 - index));
  }
  for (let index = 0; index < 3; index++) {
    documents.push(document(root, `exact-${String(index).padStart(2, "0")}.txt`, [line(0,
      `prefix ${LONG_QUERY} suffix seekah`)], 1_900_000 - index));
  }
  documents.push(
    document(root, "heading-long.txt", [{ ordinal: 0, heading: LONG_QUERY, content: "heading result",
      locationKind: "section", locationValue: "第 1 行" }], 1_899_990),
    document(root, "boundary-long.txt", [line(0, LONG_QUERY.slice(0, 9)), line(1, LONG_QUERY.slice(9))], 1_899_989),
    document(root, "content-a.txt", [line(0, "notes content seekah")], 1_899_980),
    document(root, "content-b.txt", [line(0, "notes second content")], 1_899_979),
    document(root, "seekah-sub.txt", [line(0, "seekah in subtree")], 1_899_978),
    document(root, "unicode-long.txt", [line(0, "prefix 測試資料內容abc suffix")], 1_899_977),
  );
  for (let index = 0; index < 40; index++) {
    documents.push(document(root, `notes-only-${String(index).padStart(2, "0")}.bin`, [], 1_800_000 - index, "unsupported"));
  }
  documents.push(
    document(root, "alpha-beta.txt", [line(0, "alpha only"), line(1, "beta second")], 1_700_000),
    document(root, "alpha-beta-same.txt", [line(0, "alpha beta same block")], 1_699_999),
    document(root, "filename-alpha.txt", [line(0, "beta in content")], 1_699_998),
  );
  return documents;
}

function projection(store: IndexStore, query: string, options: Options, includePages: boolean): Projection {
  const mode = options.mode ?? "phrase";
  const field = options.field ?? "all";
  const sort = options.sort ?? "relevance";
  const ranked = collectHits(store, query, undefined, undefined, mode, undefined, options.subtree, field, undefined, sort);
  const all = ranked.length ? materializeHits(store, ranked, query, mode, 1, ranked.length).results : [];
  const page1 = includePages ? materializeHits(store, ranked, query, mode, 1, 20).results : [];
  const page2 = includePages && ranked.length > 20 ? materializeHits(store, ranked, query, mode, 2, 20).results : [];
  return {
    ranked: ranked.map(item => ({ documentId: item.documentId, ordinal: item.ordinal, sourceKind: item.sourceKind, result: item.result })),
    all, page1, page2,
  };
}

test("m70 phrase posting batch preserves results and avoids repeated candidate verification", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m70-search-perf-"));
  const root = path.join(temp, "docs");
  await mkdir(path.join(root, "sub"), { recursive: true });
  const current = new IndexStore(path.join(temp, "current.db"));
  const legacy = createBlockIndexStore(path.join(temp, "legacy.db"));
  const documents = corpus(root);
  try {
    for (const store of [current, legacy]) {
      store.registerRoot(root);
      for (const item of documents) store.upsert(item, root);
    }
    assert.equal(current.chunkStoreReady(), true);
    assert.equal(legacy.chunkStoreReady(), false);

    const cases: { query: string; options: Options; pages: boolean }[] = [
      { query: LONG_QUERY, options: {}, pages: true },
      { query: LONG_QUERY, options: { field: "content" }, pages: false },
      { query: LONG_QUERY, options: { field: "filename" }, pages: false },
      { query: LONG_QUERY, options: { sort: "filename" }, pages: false },
      { query: LONG_QUERY, options: { sort: "modified" }, pages: false },
      { query: "測試資料內容abc", options: {}, pages: false },
      { query: "notes", options: { field: "all" }, pages: false },
      { query: "notes", options: { field: "filename" }, pages: false },
      { query: "notes", options: { field: "content" }, pages: false },
      { query: "seekah", options: {}, pages: false },
      { query: "seekah", options: { subtree: path.join(root, "sub") }, pages: false },
      { query: "alpha beta", options: { mode: "all-terms" }, pages: false },
    ];
    for (const item of cases) {
      assert.deepEqual(projection(current, item.query, item.options, item.pages),
        projection(legacy, item.query, item.options, item.pages),
        `${item.query} ${JSON.stringify(item.options)}`);
    }

    const long = createSearchResultSet(current, LONG_QUERY, undefined, undefined, "phrase", undefined,
      "all", undefined, "relevance", "exact");
    assert.deepEqual([long.total, long.totalRelation], [4, "eq"]);
    const longBeforePage = long.trace;
    assert.equal(longBeforePage.counts.documentsConsidered, 30);
    assert.equal(longBeforePage.counts.documentsExactVerified, 30);
    assert.equal(longBeforePage.counts.indexCandidateChunks, 28);
    assert.equal(longBeforePage.counts.indexVerifiedChunks, 28);
    assert.equal(long.page(1, 20).results.length, 4);
    assert.ok(long.trace.counts.indexVerifiedChunks >= longBeforePage.counts.indexVerifiedChunks);
    assert.equal(long.trace.counts.results, 4);

    const notes = createSearchResultSet(current, "notes", undefined, undefined, "phrase", undefined,
      "all", undefined, "relevance", "exact");
    notes.page(1, 100);
    assert.deepEqual([notes.total, notes.totalRelation], [66, "eq"]);
    assert.equal(notes.trace.counts.documentsConsidered, 106);
    assert.equal(notes.trace.counts.filenameOnlyFallbacks, 40);
  } finally {
    current.close();
    legacy.close();
    await rm(temp, { recursive: true, force: true });
  }
});
