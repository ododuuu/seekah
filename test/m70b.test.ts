import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord, DocumentStatus, TextBlock } from "../src/model.js";
import {
  collectHits, createSearchResultSet, materializeHits,
  type SearchField, type SearchMode, type SearchResult, type SearchSort,
} from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createBlockIndexStore, createLegacyStore } from "./legacy-index.js";

// SPEC §76／D108 驗收後補強：批次上限回退、延遲建立、phrase 門檻與舊路徑等價。

type Entry = { record: DocumentRecord; root: string };
type Options = {
  mode?: SearchMode;
  field?: SearchField;
  sort?: SearchSort;
  types?: readonly string[];
  root?: string;
  subtree?: string;
  statuses?: readonly DocumentStatus[];
  restrict?: readonly number[];
};
type Projection = { ranked: unknown[]; all: unknown[]; page1: unknown[]; page2: unknown[] };

type FastProjection = {
  total: number;
  totalRelation: "eq" | "gte";
  results: SearchResult[];
};

function line(ordinal: number, content: string, heading: string | null = null): TextBlock {
  return {
    ordinal,
    heading,
    content,
    locationKind: heading ? "section" : "line",
    locationValue: heading ? `第 ${ordinal + 1} 節` : `第 ${ordinal + 1} 行`,
  };
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

function buildCorpus(rootA: string, rootB: string): Entry[] {
  const entries: Entry[] = [];
  let modified = 10_000_000;
  const add = (root: string, relativePath: string, blocks: TextBlock[], status: DocumentStatus = "indexed") => {
    entries.push({ record: document(root, relativePath, blocks, modified--, status), root });
  };
  const content = (value: string, heading: string | null = null) => [line(0, value, heading)];

  add(rootA, "scope-a.txt", content("scope-token in root a", "scope-token"));
  add(rootA, path.join("sub", "scope-sub.md"), content("scope-token in subtree", "scope-token"));
  add(rootA, path.join("sub", "deep", "scope-deep.md"), content("scope-token in deep subtree", "scope-token"));
  add(rootB, "scope-b.txt", content("scope-token in root b", "scope-token"));
  add(rootA, "scope-unsupported.bin", [], "unsupported");
  add(rootA, "scope-error.txt", content("scope-token in error status"), "error");

  add(rootA, "one-code-point.txt", content("one λ token"));
  add(rootA, "two-code-points.txt", content("two λμ token"));
  add(rootA, "internal-space.txt", content("two  spaces phrase"));
  add(rootA, "internal-space-single.txt", content("two spaces phrase"));
  add(rootA, "nfkc-fullwidth.txt", content("fullwidth 123 token"));
  add(rootA, "nfkc-ligature.txt", content("ligature ffi token"));
  add(rootA, "cjk.txt", content("中文資料庫內容"));
  add(rootA, "emoji.txt", content("emoji 😀 token"));
  add(rootA, "shibuya.txt", content("supplementary 𠮷 token"));
  add(rootA, "nul.txt", content("nul a\u0000b token"));
  add(rootA, "threshold-seven.txt", content("threshold q7abcd"));
  add(rootA, "threshold-eight.txt", content("threshold q8abcde"));
  add(rootA, "threshold-nine.txt", content("threshold q9abcdef"));

  const crossPhrase = "cross-64k-boundary";
  add(rootA, "cross-chunk.txt", content("x".repeat(65_530) + crossPhrase + "y".repeat(32)));
  add(rootA, "cross-block-false-positive.txt", [
    line(0, crossPhrase.slice(0, 8)),
    line(1, crossPhrase.slice(8)),
  ]);

  for (let index = 0; index < 499; index++) {
    add(rootA, path.join("fast", "499", `${String(index).padStart(4, "0")}.txt`), content("fast-499"));
  }
  for (let index = 0; index < 500; index++) {
    add(rootA, path.join("fast", "500", `${String(index).padStart(4, "0")}.txt`), content("fast-500"));
  }
  for (let index = 0; index < 501; index++) {
    add(rootA, path.join("fast", "501", `${String(index).padStart(4, "0")}.txt`), content("fast-501"));
  }
  for (let index = 0; index < 501; index++) {
    add(rootA, path.join("same-name", String(index).padStart(4, "0"), "same-name.txt"), content("ordinary body"));
  }
  return entries;
}

function populate(store: IndexStore, entries: readonly Entry[], roots: readonly string[]): void {
  for (const root of roots) store.registerRoot(root);
  for (const entry of entries) store.upsert(entry.record, entry.root);
}

function projection(store: IndexStore, query: string, options: Options, includePages = true): Projection {
  const mode = options.mode ?? "phrase";
  const field = options.field ?? "all";
  const sort = options.sort ?? "relevance";
  const ranked = collectHits(store, query, options.types, options.root, mode, options.restrict, options.subtree,
    field, options.statuses, sort);
  const all = ranked.length ? materializeHits(store, ranked, query, mode, 1, ranked.length).results : [];
  const page1 = includePages ? materializeHits(store, ranked, query, mode, 1, 20).results : [];
  const page2 = includePages && ranked.length > 20 ? materializeHits(store, ranked, query, mode, 2, 20).results : [];
  return {
    ranked: ranked.map(item => ({ documentId: item.documentId, ordinal: item.ordinal, sourceKind: item.sourceKind, result: item.result })),
    all, page1, page2,
  };
}

function fastProjection(store: IndexStore, query: string): FastProjection {
  const resultSet = createSearchResultSet(store, query, undefined, undefined, "phrase", undefined, "all", undefined, "relevance", "fast");
  const page = resultSet.page(1, 500);
  return { total: resultSet.total, totalRelation: resultSet.totalRelation, results: page.results };
}

function assertEquivalent(query: string, options: Options, current: IndexStore, block: IndexStore, legacy: IndexStore): void {
  const expected = projection(block, query, options);
  assert.deepEqual(projection(current, query, options), expected, `current vs block: ${query} ${JSON.stringify(options)}`);
  assert.deepEqual(projection(legacy, query, options), expected, `legacy vs block: ${query} ${JSON.stringify(options)}`);
}

test("m70b bounded phrase batches fall back safely and preserve legacy semantics", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m70b-search-perf-"));
  const rootA = path.join(temp, "root-a");
  const rootB = path.join(temp, "root-b");
  await mkdir(path.join(rootA, "sub", "deep"), { recursive: true });
  await mkdir(rootB, { recursive: true });
  const entries = buildCorpus(rootA, rootB);
  const current = new IndexStore(path.join(temp, "current.db"));
  const bounded = new IndexStore(path.join(temp, "bounded.db"), { phraseCandidatePostingLimit: 1 });
  const block = createBlockIndexStore(path.join(temp, "block.db"));
  const legacy = createLegacyStore(path.join(temp, "legacy.db"));
  const roots = [rootA, rootB];
  try {
    for (const store of [current, bounded, block, legacy]) populate(store, entries, roots);

    const scopeCases: { query: string; options: Options }[] = [
      { query: "scope-token", options: { field: "content", types: [".md"] } },
      { query: "scope-token", options: { field: "content", root: rootA } },
      { query: "scope-token", options: { field: "content", subtree: path.join(rootA, "sub") } },
      { query: "scope-token", options: { field: "content", statuses: ["indexed"] } },
      { query: "scope-token", options: { field: "content", types: [".md"], root: rootA,
        subtree: path.join(rootA, "sub"), statuses: ["indexed"] } },
      { query: "scope-unsupported.bin", options: { field: "filename", statuses: ["unsupported"] } },
    ];
    for (const item of scopeCases) assertEquivalent(item.query, item.options, current, block, legacy);

    const restrictPaths = [
      path.join(rootA, "scope-a.txt"),
      path.join(rootA, "sub", "scope-sub.md"),
      path.join(rootB, "scope-b.txt"),
    ];
    const restrictedIds = restrictPaths.map(filePath => current.getDocument(filePath)?.id).filter((id): id is number => id !== undefined);
    assert.equal(restrictedIds.length, restrictPaths.length);
    assertEquivalent("scope-token", { field: "all", restrict: restrictedIds }, current, block, legacy);

    const unicodeCases: { query: string; options?: Options }[] = [
      { query: "λ", options: { field: "content" } },
      { query: "λμ", options: { field: "content" } },
      { query: "two  spaces", options: { field: "content" } },
      { query: "１２３", options: { field: "content" } },
      { query: "ﬃ", options: { field: "content" } },
      { query: "資料", options: { field: "content" } },
      { query: "資料庫", options: { field: "content" } },
      { query: "😀", options: { field: "content" } },
      { query: "𠮷", options: { field: "content" } },
      { query: "a\u0000b", options: { field: "content" } },
      { query: "q7abcd", options: { field: "content" } },
      { query: "q8abcde", options: { field: "content" } },
      { query: "q9abcdef", options: { field: "content" } },
      { query: "cross-64k-boundary", options: { field: "content" } },
      { query: "cross-block-boundary", options: { field: "content" } },
    ];
    for (const item of unicodeCases) assertEquivalent(item.query, item.options ?? {}, current, block, legacy);

    const longCurrent = projection(current, "cross-64k-boundary", { field: "content" });
    assert.equal(longCurrent.ranked.length, 1);
    const splitFalsePositive = projection(current, "cross-block-boundary", { field: "content" });
    assert.equal(splitFalsePositive.ranked.length, 0);

    const boundedLong = projection(bounded, "cross-64k-boundary", { field: "content" });
    assert.deepEqual(boundedLong, longCurrent);
    const currentChunkCandidates = current.chunkCandidateChunks("scope-token");
    const currentHeadingCandidates = current.chunkHeadingCandidates("scope-token");
    assert.ok(currentChunkCandidates instanceof Map && currentChunkCandidates.size > 0);
    assert.ok(currentHeadingCandidates instanceof Map && currentHeadingCandidates.size > 0);
    assert.deepEqual(projection(bounded, "scope-token", { field: "content" }),
      projection(current, "scope-token", { field: "content" }));
    assert.equal(bounded.chunkCandidateChunks("scope-token"), undefined);
    assert.equal(bounded.chunkHeadingCandidates("scope-token"), undefined);

    // One/two code point and U+0000 phrases must keep the conservative per-document path;
    // these comparisons also prove that the batch threshold does not change results.
    assert.deepEqual(projection(bounded, "λ", { field: "content" }), projection(current, "λ", { field: "content" }));
    assert.deepEqual(projection(bounded, "λμ", { field: "content" }), projection(current, "λμ", { field: "content" }));
    assert.deepEqual(projection(bounded, "a\u0000b", { field: "content" }), projection(current, "a\u0000b", { field: "content" }));

    for (const [query, expectedTotal, expectedRelation] of [["fast-499", 499, "eq"], ["fast-500", 500, "gte"], ["fast-501", 500, "gte"]] as const) {
      const expected = fastProjection(current, query);
      const actual = fastProjection(bounded, query);
      assert.deepEqual(actual, expected, `bounded fast total: ${query}`);
      assert.deepEqual([expected.total, expected.totalRelation], [expectedTotal, expectedRelation]);
      const complete = collectHits(current, query);
      assert.deepEqual(expected.results.map(item => item.path), complete.slice(0, 500).map(item => item.result.path));
      assertEquivalent(query, { field: "content" }, current, block, legacy);
    }

    // 501 filename-rank-4 documents fill fast page one before heading/content is needed.
    const delayed = createSearchResultSet(current, "same-name.txt", undefined, undefined, "phrase", undefined,
      "all", undefined, "relevance", "fast");
    delayed.page(1, 20);
    assert.deepEqual([delayed.total, delayed.totalRelation], [500, "gte"]);
    assert.equal(delayed.trace.counts.indexCandidateChunks, 0);
    assert.equal(delayed.trace.counts.indexVerifiedChunks, 0);
    assertEquivalent("same-name.txt", { field: "all" }, current, block, legacy);
  } finally {
    current.close();
    bounded.close();
    block.close();
    legacy.close();
    await rm(temp, { recursive: true, force: true });
  }
});
