import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord, DocumentStatus, TextBlock } from "../src/model.js";
import { buildChunks, blocksContainingBuffer, decompressChunk, firstBlockContainingBuffer } from "../src/chunk-store.js";
import { createSearchResultSet, type SearchField, type SearchSort } from "../src/search.js";
import { DEFAULT_DECOMPRESSED_CHUNK_CACHE_BYTES, IndexStore } from "../src/store.js";

const LONG_QUERY = "4564654564651431321";
const OLD_QUERY = "oldmarker1234567890";
const NEW_QUERY = "newmarker1234567890";
const NFKC_QUERY = "12345678";
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
  const documents = [
    document(root, "hit.txt", [line(0, `prefix ${OLD_QUERY} ${LONG_QUERY} suffix`)], 2_000_000),
    document(root, "boundary.txt", [line(0, LONG_QUERY.slice(0, 9)), line(1, LONG_QUERY.slice(9))], 1_999_999),
    document(root, "case.txt", [line(0, "prefix AbC123 suffix")], 1_999_998),
    document(root, "unicode.txt", [line(0, "prefix 測試資料😀 suffix")], 1_999_997),
    document(root, "nfkc.txt", [line(0, "prefix ①②③④⑤⑥⑦⑧ suffix")], 1_999_996),
    document(root, `filename-${LONG_QUERY}.txt`, [line(0, "filename-only content")], 1_999_995),
  ];
  for (let index = 0; index < 12; index++) {
    documents.push(document(root, `long-${String(index).padStart(2, "0")}.txt`,
      [line(0, `prefix ${LONG_QUERY} filler-${index}`)], 1_999_900 - index));
  }
  return documents;
}

function populate(store: IndexStore, root: string, documents: readonly DocumentRecord[]): void {
  store.registerRoot(root);
  for (const item of documents) store.upsert(item, root);
}

function projection(store: IndexStore, query: string, field: SearchField = "all", sort: SearchSort = "relevance") {
  const resultSet = createSearchResultSet(store, query, undefined, undefined, "phrase", undefined,
    field, undefined, sort, "exact");
  const page = resultSet.page(1, 1000);
  return { total: resultSet.total, totalRelation: resultSet.totalRelation, results: page.results };
}

test("M80 解壓 chunk 快取保持結果欄位／範圍／排序與停用路徑完全相同", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m80-cache-equivalence-"));
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const documents = corpus(root);
  const cached = new IndexStore(path.join(temp, "cached.db"), { decompressedChunkCacheBytes: 96 * 1024 });
  const uncached = new IndexStore(path.join(temp, "uncached.db"), { decompressedChunkCacheBytes: 0 });
  const capped = new IndexStore(path.join(temp, "capped.db"), { decompressedChunkCacheBytes: DEFAULT_DECOMPRESSED_CHUNK_CACHE_BYTES * 2 });
  const defaulted = new IndexStore(path.join(temp, "default.db"));
  try {
    populate(cached, root, documents);
    populate(uncached, root, documents);
    const cases: { query: string; field?: SearchField; sort?: SearchSort }[] = [
      { query: LONG_QUERY },
      { query: LONG_QUERY, field: "content" },
      { query: LONG_QUERY, field: "filename", sort: "filename" },
      { query: "abc123" },
      { query: "測試資料😀" },
      { query: NFKC_QUERY },
      { query: OLD_QUERY, sort: "modified" },
    ];
    for (const item of cases) {
      assert.deepEqual(
        projection(cached, item.query, item.field, item.sort),
        projection(uncached, item.query, item.field, item.sort),
        `${item.query} ${item.field ?? "all"} ${item.sort ?? "relevance"}`,
      );
    }
    const stats = cached.decompressedChunkCacheStats();
    assert.equal(stats.enabled, true);
    assert.ok(stats.entries > 0, "命中驗證後應有可重用的解壓 chunk");
    assert.ok(stats.bytes > 0 && stats.bytes <= 96 * 1024);
    assert.deepEqual(uncached.decompressedChunkCacheStats(), {
      enabled: false, bytes: 0, entries: 0, limitBytes: 0,
    });
    assert.equal(capped.decompressedChunkCacheStats().limitBytes, DEFAULT_DECOMPRESSED_CHUNK_CACHE_BYTES);
    assert.deepEqual(defaulted.decompressedChunkCacheStats(), {
      enabled: false, bytes: 0, entries: 0, limitBytes: 0,
    });
  } finally {
    defaulted.close();
    capped.close();
    cached.close();
    uncached.close();
  }
});

test("M80 writer commit 會清除舊 chunk，跨資料庫 chunk id 不會誤用", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m80-cache-invalidation-"));
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const store = new IndexStore(path.join(temp, "mutable.db"), { decompressedChunkCacheBytes: 64 * 1024 });
  try {
    store.registerRoot(root);
    const target = document(root, "target.txt", [line(0, `prefix ${OLD_QUERY} suffix`)], 2_000_000);
    store.upsert(target, root);
    assert.equal(projection(store, OLD_QUERY).total, 1);
    assert.ok(store.decompressedChunkCacheStats().entries > 0);

    store.upsert(document(root, "target.txt", [line(0, `prefix ${NEW_QUERY} suffix`)], 2_000_001), root);
    assert.equal(projection(store, OLD_QUERY).total, 0);
    assert.equal(projection(store, NEW_QUERY).total, 1);
  } finally {
    store.close();
  }

  const first = new IndexStore(path.join(temp, "first.db"));
  try {
    populate(first, root, [document(root, "first.txt", [line(0, "cachealpha1234567890")], 2_000_000)]);
    assert.equal(projection(first, "cachealpha1234567890").total, 1);
  } finally {
    first.close();
  }
  const second = new IndexStore(path.join(temp, "second.db"));
  try {
    populate(second, root, [document(root, "second.txt", [line(0, "cachebeta1234567890")], 2_000_000)]);
    assert.equal(projection(second, "cachealpha1234567890").total, 0);
    assert.equal(projection(second, "cachebeta1234567890").total, 1);
  } finally {
    second.close();
  }
});

test("M80 解壓 chunk LRU 遵守 bytes 上限，並保留 ASCII／Unicode／區塊邊界驗證", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m80-cache-boundary-"));
  const root = path.join(temp, "docs");
  await mkdir(root, { recursive: true });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const store = new IndexStore(path.join(temp, "limited.db"), { decompressedChunkCacheBytes: 1024 });
  try {
    const documents = Array.from({ length: 12 }, (_, index) => document(root, `limited-${index}.txt`,
      [line(0, `prefix ${LONG_QUERY} ${"x".repeat(72)}-${index}`)], 2_000_000 - index));
    populate(store, root, documents);
    assert.equal(projection(store, LONG_QUERY).total, 12);
    const stats = store.decompressedChunkCacheStats();
    assert.ok(stats.entries > 0);
    assert.ok(stats.bytes <= 1024);
    assert.ok(stats.entries < documents.length, "超過 bytes 上限時應淘汰最舊 chunk");
  } finally {
    store.close();
  }

  const built = buildChunks([
    line(0, "prefix 456465"),
    line(1, "456465 suffix"),
    line(2, "unicode 測試資料"),
  ]);
  const chunk = built.chunks[0]!;
  const buffer = decompressChunk(chunk.text);
  assert.equal(firstBlockContainingBuffer(buffer, chunk.layout, "456465"), 0);
  assert.deepEqual(blocksContainingBuffer(buffer, chunk.layout, ["456465"], true).get("456465"), [0]);
  const crossBlock = "456465\n456465";
  assert.equal(firstBlockContainingBuffer(buffer, chunk.layout, crossBlock), undefined);
  assert.equal(firstBlockContainingBuffer(buffer, chunk.layout, "測試資料"), 2);
});
