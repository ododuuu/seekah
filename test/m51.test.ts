import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord, TextBlock } from "../src/model.js";
import {
  collectHits, createSearchResultSet, materializeHits, matchingPassages,
  type SearchField, type SearchMode, type SearchSort,
} from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createBlockIndexStore } from "./legacy-index.js";

// SPEC §62／D094：SQL candidate cursor must reproduce the established legacy per-document path.

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

function document(root: string, relativePath: string, blocks: TextBlock[], modifiedAtMs: number): DocumentRecord {
  const filename = path.basename(relativePath);
  return {
    path: path.join(root, relativePath), filename, extension: path.extname(filename) || ".txt",
    sizeBytes: blocks.reduce((size, block) => size + Buffer.byteLength(block.content, "utf8"), 0), modifiedAtMs,
    status: "indexed", errorCode: null, errorMessage: null, blocks,
  };
}

function corpus(root: string): DocumentRecord[] {
  const documents = Array.from({ length: 620 }, (_, index) => document(root,
    `${index < 40 ? "sub" + path.sep : ""}${String(index).padStart(4, "0")}.txt`,
    [line(0, `common e filler-${index}`)], 1_000_000 - index));
  documents.push(
    document(root, "filenamehit.md", [line(0, "common e ordinary content")], 900_000),
    document(root, "rare-doc.md", [line(0, "common e rareneedle")], 899_999),
    document(root, "cross-terms.md", [
      { ordinal: 0, heading: "Alpha title", content: "e", locationKind: "section", locationValue: "第 1 行" },
      { ordinal: 1, heading: null, content: "beta second", locationKind: "line", locationValue: "第 2 行" },
    ], 899_998),
    document(root, "same-terms.md", [line(0, "alpha beta e")], 899_997),
    document(root, "filename-alpha.md", [line(0, "beta e")], 899_996),
    document(root, "heading-all.md", [
      { ordinal: 0, heading: "alpha beta heading", content: "e", locationKind: "section", locationValue: "第 1 行" },
    ], 899_995),
    document(root, "order-😀.md", [line(0, "common e")], 899_994),
    document(root, `order-${String.fromCharCode(0xe000)}.md`, [line(0, "common e")], 899_993),
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

test("m51 SQL candidate cursor preserves complete search results and total modes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m51-equivalence-"));
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
      { query: "e", options: {}, pages: true },
      { query: "e", options: { sort: "filename" }, pages: false },
      { query: "e", options: { sort: "modified" }, pages: false },
      { query: "rareneedle", options: {}, pages: false },
      { query: "alpha beta", options: { mode: "all-terms" }, pages: false },
      { query: "filenamehit", options: {}, pages: false },
      { query: "e", options: { subtree: path.join(root, "sub") }, pages: false },
    ];
    for (const item of cases) {
      assert.deepEqual(projection(current, item.query, item.options, item.pages),
        projection(legacy, item.query, item.options, item.pages),
        `${item.query} ${JSON.stringify(item.options)}`);
    }

    const expectedCommon = projection(legacy, "e", {}, true);
    const fast = createSearchResultSet(current, "e");
    assert.deepEqual([fast.total, fast.totalRelation], [500, "gte"]);
    assert.deepEqual(fast.page(1, 20).results, expectedCommon.page1);
    assert.deepEqual(fast.page(2, 20).results, expectedCommon.page2);

    const exact = createSearchResultSet(current, "e", undefined, undefined, "phrase", undefined, "all", undefined, "relevance", "exact");
    assert.deepEqual([exact.total, exact.totalRelation], [expectedCommon.ranked.length, "eq"]);
    assert.deepEqual(exact.page(1, 20).results, expectedCommon.page1);
    assert.deepEqual(exact.page(2, 20).results, expectedCommon.page2);

    const rare = createSearchResultSet(current, "rareneedle");
    assert.deepEqual([rare.total, rare.totalRelation], [1, "eq"]);
    assert.deepEqual(rare.page(1, 20).results, projection(legacy, "rareneedle", {}, true).page1);

    const exactAllTerms = createSearchResultSet(current, "alpha beta", undefined, undefined, "all-terms", undefined,
      "all", undefined, "relevance", "exact");
    const legacyAllTerms = projection(legacy, "alpha beta", { mode: "all-terms" }, true);
    assert.deepEqual([exactAllTerms.total, exactAllTerms.totalRelation], [legacyAllTerms.ranked.length, "eq"]);
    assert.deepEqual(exactAllTerms.page(1, 20).results, legacyAllTerms.page1);

    const passagePath = path.join(root, "cross-terms.md");
    assert.deepEqual(matchingPassages(current, "alpha beta", passagePath, 3, "all-terms"),
      matchingPassages(legacy, "alpha beta", passagePath, 3, "all-terms"));
  } finally {
    current.close();
    legacy.close();
    await rm(temp, { recursive: true, force: true });
  }
});
