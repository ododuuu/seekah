import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DocumentRecord, DocumentStatus, TextBlock } from "../src/model.js";
import { collectHits, materializeHits, search, type SearchField, type SearchMode, type SearchSort } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import { createLegacyStore } from "./legacy-index.js";

// SPEC §52 (formerly §50): the chunk store must reproduce the per-document ranking exactly.

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Words chosen to collide often, mix scripts and exercise NFKC／case folding.
const words = ["測試", "報告", "測", "試驗", "spec", "SPEC.md", "Spec", "ＳＰＥＣ", "report", "log", "ing", "İstanbul", "Straße",
  "ﬁle", "file", "ΣΟΦΟΣ", "σοφος", "a\u0000b", "資料", "料號", "A-12", "a-12", "é", "é", "  ", "下列何", "何者"];

function corpus(root: string, seed: number): DocumentRecord[] {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const text = (count: number) => Array.from({ length: count }, () => pick(words)).join(next() < 0.5 ? " " : "");
  const documents: DocumentRecord[] = [];
  for (let index = 0; index < 48; index++) {
    const extension = pick([".txt", ".md", ".xlsx"]);
    const filename = `${index}-${text(1 + Math.floor(next() * 2))}${extension}`.replaceAll("\u0000", "0").replaceAll(" ", "_");
    const metadataOnly = index % 11 === 5;
    const blockCount = metadataOnly ? 0 : 1 + Math.floor(next() * 12);
    const headings = [null, "", text(1), text(2), "第一章 測試"];
    const blocks: TextBlock[] = Array.from({ length: blockCount }, (_, ordinal) => ({
      ordinal, heading: pick(headings), content: text(1 + Math.floor(next() * 8)),
      locationKind: "line" as const, locationValue: `第 ${ordinal + 1} 行`,
    }));
    documents.push({ path: path.join(root, index % 3 === 0 ? "sub" : "", filename), filename, extension,
      sizeBytes: 100 + index, modifiedAtMs: 1_000 + (index % 7) * 10, status: metadataOnly ? "unsupported" : "indexed",
      errorCode: null, errorMessage: null, blocks });
  }
  // One block spanning several 64 KiB payloads with a phrase across a boundary.
  documents.push({ path: path.join(root, "large.txt"), filename: "large.txt", extension: ".txt", sizeBytes: 1, modifiedAtMs: 2_000,
    status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: "大檔", content: `${"前".repeat(65_530)}跨界 spec 報告${"後".repeat(70_000)}`, locationKind: "line", locationValue: "1" },
      { ordinal: 1, heading: null, content: "尾端 report", locationKind: "line", locationValue: "2" }] });
  return documents;
}

function queries(documents: readonly DocumentRecord[], seed: number): string[] {
  const next = random(seed);
  const sources = documents.flatMap(document => [document.filename, ...document.blocks.flatMap(block => [block.heading ?? "", block.content])])
    .filter(value => value.trim());
  const result = new Set<string>(["spec", "SPEC.md", "測試", "測", "e", "ing", "ﬁle", "ΣΟΦΟΣ", "a\u0000b", "\u0000", "跨界 spec 報告",
    "前跨界", "不存在的詞", "第一章", "A-12", "é", "報告 spec", "log 測試 file", "大檔 尾端"]);
  while (result.size < 140) {
    const characters = [...sources[Math.floor(next() * sources.length)]!];
    const length = 1 + Math.floor(next() * 8);
    const start = Math.floor(next() * Math.max(1, characters.length - length));
    const value = characters.slice(start, start + length).join("");
    if (value.trim()) result.add(next() < 0.2 ? value.toUpperCase() : value);
  }
  return [...result];
}

type Projection = { id: number; rank: number; kind: string; ordinal: number | null; heading: string | null; location: string | null;
  reason: string; filenameOnly: boolean };

function project(store: IndexStore, query: string, options: { mode: SearchMode; field: SearchField; sort: SearchSort;
  types?: string[]; root?: string; subtree?: string; statuses?: DocumentStatus[]; restrict?: number[] }): { ranked: Projection[]; snippets: string[] } {
  const ranked = collectHits(store, query, options.types, options.root, options.mode, options.restrict, options.subtree,
    options.field, options.statuses, options.sort);
  const snippets = ranked.length ? materializeHits(store, ranked, query, options.mode, 1, 20).results.map(result => result.snippet) : [];
  return { ranked: ranked.map(item => ({ id: item.documentId, rank: item.result.rank, kind: item.sourceKind, ordinal: item.ordinal,
    heading: item.result.heading, location: item.result.location, reason: item.result.reason, filenameOnly: item.result.filenameOnly })), snippets };
}

test("chunk store reproduces legacy per-document ranking across modes, fields, filters and snippets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m40-equivalence-"));
  const rootA = path.join(temp, "a");
  const rootB = path.join(temp, "b");
  await mkdir(path.join(rootA, "sub"), { recursive: true });
  await mkdir(rootB, { recursive: true });
  const indexed = new IndexStore(path.join(temp, "block.db"));
  const legacy = createLegacyStore(path.join(temp, "legacy.db"));
  try {
    const documents = [...corpus(rootA, 7), ...corpus(rootB, 8)];
    for (const store of [indexed, legacy]) {
      store.registerRoot(rootA);
      store.registerRoot(rootB);
      for (const document of documents) store.upsert(document, document.path.startsWith(rootA) ? rootA : rootB);
    }
    assert.equal(indexed.chunkStoreReady(), true);
    assert.equal(legacy.chunkStoreReady(), false);
    assert.equal(legacy.blockIndexReady(), false);
    const ids = documents.map(document => indexed.getDocument(document.path)!.id);
    assert.deepEqual(documents.map(document => legacy.getDocument(document.path)!.id), ids);
    const next = random(99);
    let compared = 0;
    let nonEmpty = 0;
    for (const query of queries(documents, 5)) {
      const variants = [
        { mode: "phrase" as const, field: "all" as const, sort: "relevance" as const },
        { mode: "all-terms" as const, field: "all" as const, sort: "relevance" as const },
        { mode: (next() < 0.5 ? "phrase" : "all-terms") as SearchMode, field: (next() < 0.5 ? "filename" : "content") as SearchField,
          sort: (next() < 0.5 ? "filename" : "modified") as SearchSort },
        { mode: "all-terms" as const, field: "all" as const, sort: "relevance" as const, types: [".md", ".xlsx"], root: rootA,
          statuses: ["indexed" as const] },
        { mode: "phrase" as const, field: "all" as const, sort: "relevance" as const, root: rootA, subtree: path.join(rootA, "sub") },
        { mode: "phrase" as const, field: "all" as const, sort: "relevance" as const,
          restrict: ids.filter(() => next() < 0.4).sort(() => next() - 0.5) },
        { mode: "all-terms" as const, field: "all" as const, sort: "relevance" as const, types: [".md"], root: rootB,
          restrict: ids.filter(() => next() < 0.5) },
      ];
      for (const options of variants) {
        const expected = project(legacy, query, options);
        const actual = project(indexed, query, options);
        assert.deepEqual(actual, expected, `${JSON.stringify(query)} ${JSON.stringify({ ...options, restrict: undefined })}`);
        compared++;
        if (expected.ranked.length) nonEmpty++;
      }
    }
    assert.ok(compared >= 800 && nonEmpty > 300, `${compared} comparisons, ${nonEmpty} non-empty`);
    // The chunk path never reads the payload docstore.
    collectHits(indexed, "spec");
    assert.equal(indexed.lastSearchTrace()?.counts.payloadsRead, 0);
    assert.equal(indexed.lastSearchTrace()?.candidateStrategy, "chunk-index");
  } finally {
    indexed.close();
    legacy.close();
    await rm(temp, { recursive: true, force: true });
  }
});

function count(databasePath: string, sql: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return Number(Object.values(db.prepare(sql).get()!)[0]); } finally { db.close(); }
}

const ftsTables = ["search_chunk_trigrams", "search_chunk_unigrams", "search_chunk_bigrams", "search_filename_trigrams",
  "search_filename_unigrams", "search_filename_bigrams", "search_heading_trigrams", "search_heading_unigrams", "search_heading_bigrams"];

function record(root: string, filename: string, blocks: [string | null, string][]): DocumentRecord {
  return { path: path.join(root, filename), filename, extension: ".txt", sizeBytes: 1, modifiedAtMs: 1, status: "indexed",
    errorCode: null, errorMessage: null,
    blocks: blocks.map(([heading, content], ordinal) => ({ ordinal, heading, content, locationKind: "line", locationValue: `${ordinal}` })) };
}

test("fresh chunk store has no legacy structures and every removal path clears its rows", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m40-cleanup-"));
  const root = path.join(temp, "docs");
  const other = path.join(temp, "other");
  const databasePath = path.join(temp, "index.db");
  const store = new IndexStore(databasePath);
  try {
    assert.equal(count(databasePath, `SELECT count(*) FROM sqlite_master WHERE name IN ('document_blooms', 'document_payload_blooms',
      'search_unigrams', 'search_trigrams', 'blocks', 'block_payloads', 'document_payloads', 'document_payload_blocks',
      'search_block_trigrams', 'search_block_unigrams', 'search_block_bigrams')`), 0);
    assert.equal(store.formatStatus().needsUpgrade, false);
    assert.equal(store.formatStatus().legacySearchStructures, false);
    store.registerRoot(root);
    store.registerRoot(other);
    store.upsert(record(root, "keep.txt", [["章節", "保留 keep-token"]]), root);
    store.upsert(record(root, "replace.txt", [["舊標題", "old-token one"], [null, "old-token two"]]), root);
    store.upsert(record(root, "gone.txt", [[null, "gone-token"]]), root);
    store.upsert(record(other, "trash.txt", [["垃圾", "trash-token"]]), other);

    // Replace keeps the document id and drops rows of the old blocks.
    const replaceId = store.getDocument(path.join(root, "replace.txt"))!.id;
    store.upsert(record(root, "replace.txt", [["新標題", "new-token"]]), root);
    assert.equal(store.getDocument(path.join(root, "replace.txt"))!.id, replaceId);
    assert.equal(search(store, "old-token").length, 0);
    assert.equal(search(store, "舊標題").length, 0);
    assert.equal(search(store, "new-token")[0]?.path, path.join(root, "replace.txt"));
    assert.equal(search(store, "新標題")[0]?.reason, "標題");

    assert.equal(store.removeDocument(path.join(root, "gone.txt")), true);
    assert.equal(search(store, "gone-token").length, 0);
    // A reused block id must not inherit rows of the deleted block.
    store.upsert(record(root, "reuse.txt", [[null, "fresh-token"]]), root);
    assert.equal(search(store, "gone-token").length, 0);

    store.moveRootsToTrash([other]);
    assert.equal(search(store, "trash-token").length, 0);
    assert.equal(search(store, "垃圾").length, 0);
    assert.deepEqual(await store.removeMissing(new Set([path.join(root, "keep.txt")]), root), { removed: 2, protected: 0 });
    assert.equal(search(store, "new-token").length, 0);
    assert.equal(search(store, "keep-token").length, 1);
    assert.equal(count(databasePath, "SELECT count(*) FROM document_chunks"), 1);
    // keep.txt's only block has a heading, so its metadata is stored.
    assert.equal(count(databasePath, "SELECT count(*) FROM block_meta"), 1);
    assert.equal(count(databasePath, "SELECT count(*) FROM search_headings"), 1);
    // A finished chunk store keeps no per-document migration markers (SPEC §51.2).
    assert.equal(count(databasePath, "SELECT count(*) FROM index_migration_documents"), 0);

    store.clearDocuments();
    assert.equal(search(store, "keep-token").length, 0);
    for (const table of ftsTables) {
      const db = new DatabaseSync(databasePath);
      try {
        db.exec(`CREATE VIRTUAL TABLE temp.v USING fts5vocab(main, ${table}, row)`);
        assert.equal(Number(Object.values(db.prepare("SELECT count(*) FROM temp.v").get()!)[0]), 0, table);
        db.exec(`INSERT INTO ${table}(${table}) VALUES ('integrity-check')`);
      } finally { db.close(); }
    }
    assert.equal(count(databasePath, "SELECT count(*) FROM search_headings"), 0);
    assert.equal(count(databasePath, "SELECT count(*) FROM document_chunks"), 0);
    assert.equal(count(databasePath, "SELECT count(*) FROM block_meta"), 0);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("queries containing U+0000 search on both the block index and the legacy path", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m40-nul-"));
  const indexed = new IndexStore(path.join(temp, "block.db"));
  const legacy = createLegacyStore(path.join(temp, "legacy.db"));
  try {
    for (const store of [indexed, legacy]) {
      store.upsert(record(temp, "nul.txt", [[null, "before a\u0000b after"], [null, "a b"]]));
      store.upsert(record(temp, "plain.txt", [[null, "a0b ab"]]));
    }
    for (const store of [indexed, legacy]) {
      assert.deepEqual(search(store, "a\u0000b").map(result => result.location), ["0"]);
      assert.deepEqual(search(store, "e a\u0000b a").map(result => result.path), [path.join(temp, "nul.txt")]);
      assert.equal(search(store, "x\u0000y z").length, 0);
      assert.equal(search(store, "\u0000").length, 1);
    }
  } finally {
    indexed.close();
    legacy.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("a long-lived writer keeps indexing after another store finishes the migration and drops legacy tables", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m40-concurrent-"));
  const databasePath = path.join(temp, "index.db");
  const daemon = createLegacyStore(databasePath);
  try {
    daemon.upsert(record(temp, "before.txt", [[null, "before-token"]]));
    assert.equal(daemon.chunkStoreReady(), false);
    const migrator = new IndexStore(databasePath);
    try { await migrator.upgrade(); } finally { migrator.close(); }
    assert.equal(count(databasePath, "SELECT count(*) FROM sqlite_master WHERE name = 'document_blooms'"), 0);
    // Statements prepared against the dropped legacy tables must be re-prepared, not reused.
    daemon.upsert(record(temp, "after.txt", [[null, "after-token"]]));
    assert.equal(daemon.removeDocument(path.join(temp, "before.txt")), true);
    assert.equal(daemon.chunkStoreReady(), true);
    assert.deepEqual(search(daemon, "after-token").map(result => result.path), [path.join(temp, "after.txt")]);
    assert.equal(search(daemon, "before-token").length, 0);
    assert.equal(daemon.lastSearchTrace()?.candidateStrategy, "chunk-index");
  } finally {
    daemon.close();
    await rm(temp, { recursive: true, force: true });
  }
});
