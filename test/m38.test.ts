import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { OperationCancelledError } from "../src/progress.js";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";

function document(root: string, filename: string, content: string, heading = "標題"): DocumentRecord {
  return {
    path: path.join(root, filename), filename, extension: path.extname(filename), sizeBytes: Buffer.byteLength(content), modifiedAtMs: 1000,
    status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading, content, locationKind: "line", locationValue: "第 1 行" }],
  };
}

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { count: number }).count);
}

test("FTS5 unigram/trigram postings preserve exact, phrase, all-terms, filename, snippet and stable references", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m38-search-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "index.db");
  await mkdir(root);
  const store = new IndexStore(databasePath);
  store.registerRoot(root);
  try {
    store.upsert(document(root, "rare-name.txt", "common common rare-token-919 two word phrase three word phrase"), root);
    store.upsert(document(root, "ordinary.txt", "common only"), root);
    const exact = search(store, "rare-token-919");
    assert.equal(exact.length, 1);
    assert.match(exact[0]!.snippet, /rare-token-919/u);
    assert.deepEqual(search(store, "two word phrase").map(item => item.path), [path.join(root, "rare-name.txt")]);
    assert.equal(search(store, "rare-token-919 common", 20, undefined, undefined, "all-terms").length, 1);
    assert.equal(search(store, "rare-name")[0]?.filenameOnly, true);
    const reference = exact[0]!.reference;
    const firstId = store.getDocument(path.join(root, "rare-name.txt"))!.id;
    assert.equal(store.formatStatus().ngramIndexVersion, "1");
    assert.equal(store.formatStatus().ngramCompletedDocuments, 2);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(db, "SELECT count(*) AS count FROM search_unigrams"), 2);
      assert.equal(count(db, "SELECT count(*) AS count FROM search_trigrams"), 2);
    } finally { db.close(); }

    store.upsert(document(root, "rare-name.txt", "replacement-token-321"));
    assert.equal(store.getDocument(path.join(root, "rare-name.txt"))!.id, firstId);
    assert.equal(search(store, "rare-token-919").length, 0);
    const replacement = search(store, "replacement-token-321");
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0]!.reference, reference);
    const replaced = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(replaced, "SELECT count(*) AS count FROM search_unigrams"), 2);
      assert.equal(count(replaced, "SELECT count(*) AS count FROM search_trigrams"), 2);
    } finally { replaced.close(); }

    assert.equal(store.removeDocument(path.join(root, "rare-name.txt")), true);
    assert.equal(search(store, "replacement-token-321").length, 0);
    const deleted = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(deleted, "SELECT count(*) AS count FROM search_unigrams"), 1);
      assert.equal(count(deleted, "SELECT count(*) AS count FROM search_trigrams"), 1);
    } finally { deleted.close(); }

    assert.deepEqual(store.removeMissing(new Set(), root), { removed: 1, protected: 0 });
    const missing = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(missing, "SELECT count(*) AS count FROM search_unigrams"), 0);
      assert.equal(count(missing, "SELECT count(*) AS count FROM search_trigrams"), 0);
    } finally { missing.close(); }
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("FTS5 postings retain matches across the 64 KiB payload boundary", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m38-boundary-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    const content = `${"前".repeat(65_535)}跨 payload 邊界 phrase${"後".repeat(65_535)}`;
    store.upsert(document(temp, "boundary.txt", content));
    assert.equal(search(store, "跨 payload 邊界 phrase").length, 1);
    assert.equal(search(store, "前跨").length, 1);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("payload Bloom ordinals expand through owning blocks without posting payload hits", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m38-payload-trace-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    store.upsert(document(temp, "ordinal.txt", `target${"x".repeat(65_535)}`));
    assert.equal(search(store, "target").length, 1);
    const trace = store.lastSearchTrace();
    assert.ok(trace);
    assert.equal(trace.counts.postingPayloadHits, 0);
    assert.ok(trace.counts.payloadsConsidered >= 2);
    assert.ok(trace.counts.payloadsAfterPruning < trace.counts.payloadsConsidered);
    assert.ok(trace.counts.expandedPayloads > 0);
    assert.ok(trace.counts.blockExpansionRatio > 1);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

test("FTS5 migration is writer-only, cancellable, resumable and preserves payload bytes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m38-migration-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "index.db");
  await mkdir(root);
  const initial = new IndexStore(databasePath);
  initial.upsert(document(root, "one.txt", "migration-one-rare"));
  initial.upsert(document(root, "two.txt", "migration-two-rare"));
  initial.upsert(document(root, "three.txt", "migration-three-rare"));
  initial.close();
  const before = new DatabaseSync(databasePath);
  const payloadBefore = (before.prepare("SELECT document_id, ordinal, hex(payload) AS payload FROM document_payloads ORDER BY document_id, ordinal").all() as { document_id: number; ordinal: number; payload: string }[]);
  before.prepare("UPDATE metadata SET value = '0' WHERE key = 'ngram_index_version'").run();
  before.exec("DELETE FROM search_unigrams; DELETE FROM search_trigrams; DELETE FROM index_migration_documents WHERE version = 'ngram_1'");
  before.close();

  const readOnly = new IndexStore(databasePath, { readOnly: true });
  const readOnlyBefore = readOnly.formatStatus();
  assert.equal(readOnlyBefore.needsUpgrade, true);
  assert.equal(search(readOnly, "migration-two-rare").length, 1);
  readOnly.close();
  const afterRead = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal((afterRead.prepare("SELECT value FROM metadata WHERE key = 'ngram_index_version'").get() as { value: string }).value, "0");
    assert.equal(count(afterRead, "SELECT count(*) AS count FROM index_migration_documents WHERE version = 'ngram_1'"), 0);
  } finally { afterRead.close(); }

  const store = new IndexStore(databasePath);
  try {
    const controller = new AbortController();
    await assert.rejects(() => store.upgrade({
      signal: controller.signal,
      onProgress: progress => {
        if (progress.message.includes("unigram") && progress.current === 1) controller.abort();
      },
    }), (error: unknown) => error instanceof OperationCancelledError);
    const interrupted = store.formatStatus();
    assert.equal(interrupted.ngramIndexVersion, "0");
    assert.equal(interrupted.ngramCompletedDocuments, 1);
    const payloadInterrupted = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(payloadInterrupted.prepare("SELECT document_id, ordinal, hex(payload) AS payload FROM document_payloads ORDER BY document_id, ordinal").all(), payloadBefore);
    } finally { payloadInterrupted.close(); }

    await store.upgrade();
    const complete = store.formatStatus();
    assert.equal(complete.ngramIndexVersion, "1");
    assert.equal(complete.ngramCompletedDocuments, 3);
    assert.equal(search(store, "migration-three-rare").length, 1);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});

