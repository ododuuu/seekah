import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sync } from "../src/sync.js";
import { collectIndexStorage, IndexStore } from "../src/store.js";
import { workbenchHtml } from "../src/workbench-app.js";
import { createWorkbench } from "../src/workbench.js";

interface StorageFile {
  suffix: string;
  bytes: number | null;
  missing: boolean;
  unknown: boolean;
}

interface StatusPayload {
  state: string;
  storage: {
    files: StorageFile[];
    totalBytes: number | null;
    incomplete: boolean;
    approximate: boolean;
  } | null;
}

async function seed(databasePath: string, root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "m99.txt"), "m99-indexed");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
}

test("M99 Workbench index-status reuses CLI storage footprint and displays SQLite sidecars", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m99-storage-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  await seed(databasePath, root);
  const createIndexStore = (target: string, options?: { readOnly?: boolean }) => {
    const store = new IndexStore(target, options);
    store.storageFootprint = () => collectIndexStorage(target, filePath => {
      if (filePath === `${target}-wal`) return { size: 7 };
      if (filePath === `${target}-shm`) return { size: 11 };
      return { size: statSync(filePath).size };
    });
    return store;
  };
  const handle = await createWorkbench({
    databasePath,
    token: "m99-token",
    secret: Buffer.alloc(32, 9),
    environment: {},
    tempParent: temp,
    createIndexStore,
  });
  const origin = handle.url.split("/#")[0]!;
  try {
    const response = await fetch(origin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": "m99-token" } });
    assert.equal(response.status, 200);
    const payload = await response.json() as StatusPayload;
    assert.equal(payload.state, "available", JSON.stringify(payload));
    assert.ok(payload.storage);
    const storage = payload.storage;
    const main = storage.files.find(file => file.suffix === "");
    const wal = storage.files.find(file => file.suffix === "-wal");
    const shm = storage.files.find(file => file.suffix === "-shm");
    assert.ok(main && main.bytes !== null && main.bytes > 0);
    assert.equal(wal?.bytes, 7);
    assert.equal(shm?.bytes, 11);
    assert.equal(storage.incomplete, false);
    assert.equal(storage.approximate, true);
    const expectedTotal = storage.files.filter(file => !file.missing).reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    assert.equal(storage.totalBytes, expectedTotal);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }

  const html = workbenchHtml("m99-nonce");
  assert.match(html, /settings-index-storage/u);
  assert.match(html, /settings-index-storage-summary/u);
  assert.match(html, /索引容量/u);
  assert.match(html, /WAL／SHM／journal/u);
});
