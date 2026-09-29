import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DocumentRecord } from "../src/model.js";
import { IndexStore } from "../src/store.js";

function scalar(database: string, sql: string, ...parameters: (string | number)[]): unknown {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return Object.values(db.prepare(sql).get(...parameters) ?? {})[0]; }
  finally { db.close(); }
}

function document(root: string, filename: string): DocumentRecord {
  return {
    path: path.join(root, filename), filename, extension: ".txt", sizeBytes: 6, modifiedAtMs: 1,
    status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: null, content: "needle", locationKind: "line", locationValue: "第 1 行" }],
  };
}
function spyPathDetection(): { readonly calls: number; restore: () => void } {
  type PathDetectionProbe = { detectPathOrder(this: IndexStore): string };
  const prototype = IndexStore.prototype as unknown as PathDetectionProbe;
  const original = prototype.detectPathOrder;
  let calls = 0;
  prototype.detectPathOrder = function(this: IndexStore): string {
    calls++;
    return original.call(this);
  };
  return {
    get calls() { return calls; },
    restore: () => { prototype.detectPathOrder = original; },
  };
}

async function createMissingPathOrderDatabase(database: string, root: string): Promise<void> {
  const store = new IndexStore(database);
  try { store.upsert(document(root, "plain.txt")); }
  finally { store.close(); }
  const db = new DatabaseSync(database);
  try { db.exec("DELETE FROM metadata WHERE key = 'path_order'"); }
  finally { db.close(); }
}

test("path_order persists utf16 on supplementary upsert and never downgrades after deletion", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m54-path-order-"));
  const database = path.join(temp, "index.db");
  const filename = "order-😀.txt";
  try {
    const store = new IndexStore(database);
    try {
      assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "native");
      store.upsert(document(temp, filename));
    } finally { store.close(); }
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
    const reopened = new IndexStore(database);
    try { assert.equal(reopened.removeDocument(path.join(temp, filename)), true); }
    finally { reopened.close(); }
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("touchMetadata upgrades path_order for supplementary paths", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m54-path-order-metadata-"));
  const database = path.join(temp, "index.db");
  try {
    const store = new IndexStore(database);
    try { store.touchMetadata(document(temp, "metadata-😀.txt")); }
    finally { store.close(); }
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("writable opening backfills path_order once for an older index", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m54-path-order-legacy-"));
  const database = path.join(temp, "index.db");
  try {
    const initial = new IndexStore(database);
    initial.upsert(document(temp, "legacy-😀.txt"));
    initial.close();
    const db = new DatabaseSync(database);
    db.exec("DELETE FROM metadata WHERE key = 'path_order'");
    db.close();
    const upgraded = new IndexStore(database);
    upgraded.close();
    assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), "utf16");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("read-only opening without path_order does not invoke path detection", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m54-path-order-open-"));
  const database = path.join(temp, "index.db");
  try {
    await createMissingPathOrderDatabase(database, temp);
    const probe = spyPathDetection();
    try {
      const store = new IndexStore(database, { readOnly: true });
      store.close();
      assert.equal(probe.calls, 0);
      assert.equal(scalar(database, "SELECT value FROM metadata WHERE key = 'path_order'"), undefined);
    } finally { probe.restore(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
