import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { createWorkbench } from "../src/workbench.js";

type JsonRecord = Record<string, any>;

type RequestResult = { response: Response; data: JsonRecord };

async function requestJson(origin: string, endpoint: string, headers: Record<string, string>, init: RequestInit = {}): Promise<RequestResult> {
  const response = await fetch(origin + endpoint, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const data = await response.json() as JsonRecord;
  return { response, data };
}

async function seedTree(databasePath: string, root: string): Promise<{ selected: string; sibling: string; removed: string; selectedFile: string; newFile: string; siblingFile: string }> {
  const selected = path.join(root, "selected");
  const sibling = path.join(root, "sibling");
  const removed = path.join(selected, "removed.txt");
  const selectedFile = path.join(selected, "changed.txt");
  const newFile = path.join(selected, "new.txt");
  const siblingFile = path.join(sibling, "sibling.txt");
  await mkdir(selected, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(removed, "subtree-remove-old-needle");
  await writeFile(selectedFile, "subtree-old-needle");
  await writeFile(siblingFile, "sibling-stable-needle");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  return { selected, sibling, removed, selectedFile, newFile, siblingFile };
}

async function search(origin: string, headers: Record<string, string>, query: string): Promise<Array<{ path: string; reference: string }>> {
  const result = await requestJson(origin, "/api/search", headers, {
    method: "POST",
    body: JSON.stringify({ query, mode: "phrase", page: 1, pageSize: 20 }),
  });
  assert.equal(result.response.status, 200);
  return result.data.results as Array<{ path: string; reference: string }>;
}

test("0.44.0 workbench subtree refresh isolates siblings and reports counts", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m66-subtree-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  const tree = await seedTree(databasePath, root);
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 66), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const siblingBefore = await search(origin, postHeaders, "sibling-stable-needle");
    assert.equal(siblingBefore.length, 1);
    await writeFile(tree.selectedFile, "subtree-new-needle");
    await writeFile(tree.newFile, "subtree-added-needle");
    await unlink(tree.removed);

    const refreshed = await requestJson(origin, "/api/index", postHeaders, {
      method: "POST",
      body: JSON.stringify({ root: tree.selected, scope: "subtree" }),
    });
    assert.equal(refreshed.response.status, 202);
    await handle.waitForIndex();

    const status = await requestJson(origin, "/api/index-status", headers);
    assert.equal(status.response.status, 200);
    assert.equal(status.data.indexing.state, "complete");
    const report = status.data.indexing.reports[0] as { root: string; added: number; updated: number; removed: number; skipped: number };
    assert.equal(report.root, path.resolve(root));
    assert.equal(report.added, 1);
    assert.equal(report.updated, 2);
    assert.equal(report.removed, 1);
    assert.equal(typeof report.skipped, "number");
    assert.match(status.data.indexing.message, /新增 1、更新 2、移除 1、略過 \d+/u);

    assert.equal((await search(origin, postHeaders, "subtree-old-needle")).length, 0);
    assert.equal((await search(origin, postHeaders, "subtree-new-needle"))[0]?.path, tree.selectedFile);
    assert.equal((await search(origin, postHeaders, "subtree-added-needle"))[0]?.path, tree.newFile);
    const siblingAfter = await search(origin, postHeaders, "sibling-stable-needle");
    assert.equal(siblingAfter[0]?.path, tree.siblingFile);
    assert.equal(siblingAfter[0]?.reference, siblingBefore[0]?.reference);
    assert.deepEqual(status.data.roots.map((item: { path: string }) => item.path), [path.resolve(root)]);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.44.0 workbench subtree refresh rejects an unregistered path before indexing", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m66-boundary-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  const outside = path.join(temp, "outside");
  await mkdir(outside, { recursive: true });
  await seedTree(databasePath, root);
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 66), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const rejected = await requestJson(origin, "/api/index", postHeaders, {
      method: "POST",
      body: JSON.stringify({ root: outside, scope: "subtree" }),
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.data.error, /已登錄根目錄/u);
    const status = await requestJson(origin, "/api/index-status", headers);
    assert.equal(status.data.indexing.state, "idle");
    assert.deepEqual(status.data.roots.map((item: { path: string }) => item.path), [path.resolve(root)]);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.44.0 duplicate manual subtree refresh returns 409 while indexing", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m66-busy-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  const tree = await seedTree(databasePath, root);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 66), environment: {}, tempParent: temp, indexHold: () => hold });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const first = await requestJson(origin, "/api/index", postHeaders, {
      method: "POST",
      body: JSON.stringify({ root: tree.selected, scope: "subtree" }),
    });
    assert.equal(first.response.status, 202);
    assert.equal(first.data.indexing.state, "running");
    const duplicate = await requestJson(origin, "/api/index", postHeaders, {
      method: "POST",
      body: JSON.stringify({ root: tree.selected, scope: "subtree" }),
    });
    assert.equal(duplicate.response.status, 409);
    assert.match(duplicate.data.error, /重新檢查/u);
    release();
    await handle.waitForIndex();
  } finally {
    release();
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});
