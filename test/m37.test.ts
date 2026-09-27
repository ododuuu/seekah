import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { workbenchHtml } from "../src/workbench-app.js";
import { createWorkbench } from "../src/workbench.js";
import { acquireWriteLock } from "../src/write-lock.js";
import { writeIndexingState } from "../src/indexing-state.js";
interface IndexingPayload {
  state: string;
  message: string;
  roots: string[];
}

interface StatusPayload {
  state: string;
  counts?: Record<string, number>;
  roots: Array<{ path: string; documentCount: number }>;
  trash?: Array<{ path: string; documentCount: number }>;
  deleteConfirmation?: boolean;
  indexing: IndexingPayload;
}

async function withWorkbench(
  run: (origin: string, headers: { "X-LocalDocSearch-Token": string }, postHeaders: Record<string, string>, handle: Awaited<ReturnType<typeof createWorkbench>>, temp: string) => Promise<void>,
  options: { indexHold?: () => Promise<void> } = {},
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-"));
  const handle = await createWorkbench({
    databasePath: path.join(temp, "data", "index.db"),
    token: "test-token",
    secret: Buffer.alloc(32, 5),
    environment: {},
    tempParent: temp,
    ...(options.indexHold ? { indexHold: options.indexHold } : {}),
  });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try { await run(origin, headers, postHeaders, handle, temp); }
  finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
}

async function seedRoot(databasePath: string, root: string, filename: string, text: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, filename), text);
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
}

test("0.37.0 workbench exposes real root, trash and confirmation controls", () => {
  const html = workbenchHtml("fixed-nonce");
  for (const page of ["roots", "trash"]) assert.match(html, new RegExp(`dataset\\.page = "${page}"`, "u"));
  for (const control of ["root-select-all", "root-delete-selected", "trash-select-all", "trash-restore-selected", "trash-purge-selected",
    "roots-stop", "top-stop", "delete-dialog", "delete-dont-remind", "settings-delete-confirmation", "settings-autoupdate",
    "query-field", "scope-root", "scope-format", "scope-parse", "document-search-button"]) {
    assert.match(html, new RegExp(control, "u"));
  }
  for (const endpoint of ["/api/index", "/api/index/stop", "/api/index-roots/trash", "/api/trash", "/api/settings"]) {
    assert.match(html, new RegExp(endpoint.replace("/", "\\/"), "u"));
  }
  assert.match(html, /選擇資料夾/u);
  assert.match(html, /確認並建立索引/u);
  assert.match(html, /移至垃圾桶/u);
  assert.match(html, /永久刪除所選/u);
  assert.match(html, /還原並重新索引/u);
  assert.match(html, /showModal/u);
  assert.match(html, /aria-labelledby/u);
  assert.match(html, /inert/u);
  assert.doesNotMatch(html, /innerHTML|delete-details|confirmAndStartIndex/u);
});

test("0.37.0 adding a sibling root reuses POST /api/index and appears in status", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-sibling-"));
  const databasePath = path.join(temp, "data", "index.db");
  const rootA = path.join(temp, "alpha");
  const rootB = path.join(temp, "beta");
  await seedRoot(databasePath, rootA, "a.txt", "alpha-root-needle");
  await mkdir(rootB);
  await writeFile(path.join(rootB, "b.txt"), "beta-root-needle");
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const added = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: rootB }) });
    assert.equal(added.status, 202);
    await handle.waitForIndex();
    const status = await fetch(origin + "/api/index-status", { headers });
    const data = await status.json() as StatusPayload;
    assert.equal(data.state, "available");
    assert.equal(data.indexing.state, "complete");
    assert.deepEqual(data.roots.map(root => root.path).sort(), [rootA, rootB].map(item => path.resolve(item)).sort());
    const search = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "beta-root-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal((await search.json() as { results: unknown[] }).results.length, 1);
    const store = new IndexStore(databasePath, { readOnly: true });
    try { assert.deepEqual(store.roots().sort(), [rootA, rootB].map(item => path.resolve(item)).sort()); }
    finally { store.close(); }
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 adding a covering parent merges child roots and keeps document ids", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-merge-"));
  const databasePath = path.join(temp, "data", "index.db");
  const parent = path.join(temp, "library");
  const child = path.join(parent, "chapter");
  await seedRoot(databasePath, child, "kept.txt", "merge-keep-needle");
  await writeFile(path.join(parent, "cover.txt"), "parent-cover-needle");
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const before = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "merge-keep-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    const beforeData = await before.json() as { results: Array<{ reference: string }> };
    assert.equal(beforeData.results.length, 1);
    const reference = beforeData.results[0]!.reference;
    const added = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: parent }) });
    assert.equal(added.status, 202);
    await handle.waitForIndex();
    const status = await fetch(origin + "/api/index-status", { headers });
    const data = await status.json() as StatusPayload;
    assert.deepEqual(data.roots.map(root => root.path), [path.resolve(parent)]);
    const after = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "merge-keep-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    const afterData = await after.json() as { results: Array<{ reference: string }> };
    assert.equal(afterData.results[0]?.reference, reference);
    const cover = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "parent-cover-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal((await cover.json() as { results: unknown[] }).results.length, 1);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 invalid add-root paths fail visibly and leave registered roots unchanged", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-invalid-"));
  const databasePath = path.join(temp, "data", "index.db");
  const rootA = path.join(temp, "keep");
  await seedRoot(databasePath, rootA, "keep.txt", "keep-root-needle");
  await writeFile(path.join(temp, "not-a-dir.txt"), "file-not-root");
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const blank = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: "   " }) });
    assert.equal(blank.status, 400);
    assert.match((await blank.json() as { error: string }).error, /索引根目錄無效/u);

    const missing = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: path.join(temp, "no-such-folder") }) });
    assert.equal(missing.status, 202);
    await handle.waitForIndex();
    const missingStatus = await fetch(origin + "/api/index-status", { headers });
    const missingData = await missingStatus.json() as StatusPayload;
    assert.equal(missingData.indexing.state, "failed");
    assert.match(missingData.indexing.message, /找不到根目錄/u);
    assert.deepEqual(missingData.roots.map(root => root.path), [path.resolve(rootA)]);

    const fileRoot = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: path.join(temp, "not-a-dir.txt") }) });
    assert.equal(fileRoot.status, 202);
    await handle.waitForIndex();
    const fileStatus = await fetch(origin + "/api/index-status", { headers });
    const fileData = await fileStatus.json() as StatusPayload;
    assert.equal(fileData.indexing.state, "failed");
    assert.match(fileData.indexing.message, /不是目錄/u);
    assert.deepEqual(fileData.roots.map(root => root.path), [path.resolve(rootA)]);

    const literal = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: "%USERPROFILE%" }) });
    assert.equal(literal.status, 202);
    await handle.waitForIndex();
    const literalStatus = await fetch(origin + "/api/index-status", { headers });
    const literalData = await literalStatus.json() as StatusPayload;
    assert.equal(literalData.indexing.state, "failed");
    assert.doesNotMatch(literalData.indexing.message, /stack|Error:/u);
    assert.deepEqual(literalData.roots.map(root => root.path), [path.resolve(rootA)]);

    if (process.platform === "win32") {
      const system = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: "C:\\$RECYCLE.BIN" }) });
      assert.equal(system.status, 202);
      await handle.waitForIndex();
      const systemStatus = await fetch(origin + "/api/index-status", { headers });
      const systemData = await systemStatus.json() as StatusPayload;
      assert.equal(systemData.indexing.state, "failed");
      assert.match(systemData.indexing.message, /系統目錄/u);
      assert.deepEqual(systemData.roots.map(root => root.path), [path.resolve(rootA)]);
    }
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 a second add-root while indexing is visibly rejected and does not register the path", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-busy-"));
  const databasePath = path.join(temp, "data", "index.db");
  const rootA = path.join(temp, "alpha");
  const rootB = path.join(temp, "beta");
  await seedRoot(databasePath, rootA, "a.txt", "busy-alpha-needle");
  await mkdir(rootB);
  await writeFile(path.join(rootB, "b.txt"), "busy-beta-needle");
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const handle = await createWorkbench({
    databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp, indexHold: () => hold,
  });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const first = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({}) });
    assert.equal(first.status, 202);
    assert.equal((await first.json() as { indexing: IndexingPayload }).indexing.state, "running");
    const second = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: rootB }) });
    assert.equal(second.status, 409);
    assert.match((await second.json() as { error: string }).error, /索引進行中，請完成後再加入/u);
    const during = await fetch(origin + "/api/index-status", { headers });
    const duringData = await during.json() as StatusPayload;
    assert.equal(duringData.indexing.state, "running");
    assert.deepEqual(duringData.roots.map(root => root.path), [path.resolve(rootA)]);
    release();
    await handle.waitForIndex();
    const after = await fetch(origin + "/api/index-status", { headers });
    const afterData = await after.json() as StatusPayload;
    assert.equal(afterData.indexing.state, "complete");
    assert.deepEqual(afterData.roots.map(root => root.path), [path.resolve(rootA)]);
    const store = new IndexStore(databasePath, { readOnly: true });
    try { assert.deepEqual(store.roots(), [path.resolve(rootA)]); }
    finally { store.close(); }
  } finally {
    release();
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.38.0 running index can be stopped before removing its root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m38-stop-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  await seedRoot(databasePath, root, "a.txt", "stop-index-needle");
  const hold = new Promise<void>(() => {});
  const handle = await createWorkbench({
    databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp,
    indexHold: () => hold,
  });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    assert.equal((await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: "{}" })).status, 202);
    const blocked = await fetch(origin + "/api/index-roots/trash", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ roots: [root] }) });
    assert.equal(blocked.status, 409);
    const stopped = await fetch(origin + "/api/index/stop", { method: "POST", headers: postHeaders, body: "{}" });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json() as { indexing: IndexingPayload }).indexing.state, "stopped");
    const removed = await fetch(origin + "/api/index-roots/trash", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ roots: [root] }) });
    assert.equal(removed.status, 200);
    const status = await fetch(origin + "/api/index-status", { headers });
    assert.deepEqual((await status.json() as StatusPayload).roots, []);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.38.0 workbench settings start and stop background autoupdate for its exact index", async () => {
  await withWorkbench(async (origin, headers, postHeaders, handle, temp) => {
    const root = path.join(temp, "watched");
    await mkdir(root);
    await writeFile(path.join(root, "a.txt"), "autoupdate-setting-needle");
    assert.equal((await fetch(origin + "/api/index", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ root }) })).status, 202);
    await handle.waitForIndex();

    const started = await fetch(origin + "/api/settings", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ autoupdateEnabled: true }) });
    assert.equal(started.status, 200);
    assert.equal((await started.json() as { autoupdate: { enabled: boolean } }).autoupdate.enabled, true);
    const status = await fetch(origin + "/api/index-status", { headers });
    assert.equal((await status.json() as { autoupdate: { enabled: boolean } }).autoupdate.enabled, true);
    const stopped = await fetch(origin + "/api/settings", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ autoupdateEnabled: false }) });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json() as { autoupdate: { enabled: boolean } }).autoupdate.enabled, false);
  });
});

test("0.37.0 opening the workbench only syncs registered roots and leaves temporary files unindexed", async () => {
  await withWorkbench(async (origin, headers, postHeaders, handle, temp) => {
    const rootA = path.join(temp, "docs");
    await mkdir(rootA);
    await writeFile(path.join(rootA, "indexed.txt"), "registered-root-needle");
    const first = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: rootA }) });
    assert.equal(first.status, 202);
    await handle.waitForIndex();

    const typedButUnconfirmed = path.join(temp, "unconfirmed");
    await mkdir(typedButUnconfirmed);
    await writeFile(path.join(typedButUnconfirmed, "secret.txt"), "unconfirmed-root-needle");
    const refresh = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({}) });
    assert.equal(refresh.status, 202);
    await handle.waitForIndex();
    const status = await fetch(origin + "/api/index-status", { headers });
    const data = await status.json() as StatusPayload;
    assert.deepEqual(data.roots.map(root => root.path), [path.resolve(rootA)]);
    const leaked = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "unconfirmed-root-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal((await leaked.json() as { results: unknown[] }).results.length, 0);

    const upload = await fetch(origin + "/api/files", {
      method: "POST",
      headers: { ...headers, origin, "X-File-Name": encodeURIComponent("temp-only.txt"), "content-type": "application/octet-stream" },
      body: "temporary-session-needle",
    });
    assert.equal(upload.status, 201);

    const rootB = path.join(temp, "other");
    await mkdir(rootB);
    await writeFile(path.join(rootB, "other.txt"), "other-root-needle");
    const added = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: rootB }) });
    assert.equal(added.status, 202);
    await handle.waitForIndex();
    const tempSearch = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "temporary-session-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal((await tempSearch.json() as { results: unknown[] }).results.length, 0);
    const otherSearch = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "other-root-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal((await otherSearch.json() as { results: unknown[] }).results.length, 1);

    assert.equal((await fetch(origin + "/api/index", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ root: rootB }) })).status, 403);
    assert.equal((await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: rootB }) })).status, 202);
    await handle.waitForIndex();
  });
});

test("0.37.0 cross-process writer busy is reported as INDEX_BUSY without adding a root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-lock-"));
  const databasePath = path.join(temp, "data", "index.db");
  const rootA = path.join(temp, "alpha");
  const rootB = path.join(temp, "beta");
  await seedRoot(databasePath, rootA, "a.txt", "lock-alpha-needle");
  await mkdir(rootB);
  await writeFile(path.join(rootB, "b.txt"), "lock-beta-needle");
  const release = acquireWriteLock(databasePath);
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const added = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root: rootB }) });
    assert.equal(added.status, 409);
    assert.match((await added.json() as { error: string }).error, /INDEX_BUSY：索引目前由另一個程序使用，請稍後重試/u);
    const status = await fetch(origin + "/api/index-status", { headers });
    const data = await status.json() as StatusPayload;
    assert.notEqual(data.indexing.state, "complete");
    assert.deepEqual(data.roots.map(root => root.path), [path.resolve(rootA)]);
    const store = new IndexStore(databasePath, { readOnly: true });
    try { assert.deepEqual(store.roots(), [path.resolve(rootA)]); }
    finally { store.close(); }
  } finally {
    release();
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 indexed roots move to trash, preserve source files, and restore by reindexing", async () => {
  await withWorkbench(async (origin, headers, postHeaders, handle, temp) => {
    const root = path.join(temp, "trashable");
    await mkdir(root);
    const file = path.join(root, "keep.txt");
    await writeFile(file, "trash-flow-needle");
    const added = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root }) });
    assert.equal(added.status, 202);
    await handle.waitForIndex();

    const initial = await fetch(origin + "/api/index-status", { headers });
    const initialData = await initial.json() as StatusPayload;
    assert.equal(initialData.deleteConfirmation, true);
    assert.deepEqual(initialData.trash, []);

    const moved = await fetch(origin + "/api/index-roots/trash", { method: "POST", headers: postHeaders, body: JSON.stringify({ roots: [path.resolve(root)] }) });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json() as { removed: Array<{ path: string; documentCount: number }> }).removed[0]?.documentCount, 1);
    assert.equal(await readFile(file, "utf8"), "trash-flow-needle");
    const trashed = await fetch(origin + "/api/index-status", { headers });
    const trashedData = await trashed.json() as StatusPayload;
    assert.deepEqual(trashedData.roots, []);
    assert.deepEqual(trashedData.trash?.map(item => item.path), [path.resolve(root)]);

    const disabled = await fetch(origin + "/api/settings", { method: "POST", headers: postHeaders, body: JSON.stringify({ deleteConfirmation: false }) });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json() as { deleteConfirmation: boolean }).deleteConfirmation, false);

    const restored = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({ root }) });
    assert.equal(restored.status, 202);
    await handle.waitForIndex();
    const restoredStatus = await fetch(origin + "/api/index-status", { headers });
    const restoredData = await restoredStatus.json() as StatusPayload;
    assert.deepEqual(restoredData.roots.map(item => item.path), [path.resolve(root)]);
    assert.deepEqual(restoredData.trash, []);

    const movedAgain = await fetch(origin + "/api/index-roots/trash", { method: "POST", headers: postHeaders, body: JSON.stringify({ roots: [path.resolve(root)] }) });
    assert.equal(movedAgain.status, 200);
    const purged = await fetch(origin + "/api/trash", { method: "DELETE", headers: postHeaders, body: JSON.stringify({ roots: [path.resolve(root)] }) });
    assert.equal(purged.status, 200);
    assert.equal((await purged.json() as { removed: number }).removed, 1);
  });
});

test("0.37.0 workbench recovers interrupted index progress and resumes incrementally", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-resume-"));
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "docs");
  await seedRoot(databasePath, root, "kept.txt", "resume-kept-needle");
  writeIndexingState({
    schemaVersion: 1,
    databasePath,
    instanceId: "interrupted-instance",
    pid: 2_147_000_000,
    state: "running",
    message: "檢查文件：85／100（85.00%）",
    roots: [path.resolve(root)],
    reports: [],
    progress: { stage: "read", message: "檢查文件", current: 85, total: 100, path: path.join(root, "stuck.docx") },
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    updatedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 5), environment: {}, tempParent: temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const recovered = await fetch(origin + "/api/index-status", { headers });
    assert.equal(recovered.status, 200);
    const recoveredData = await recovered.json() as { indexing: { state: string; message: string; progress: { current: number } | null } };
    assert.equal(recoveredData.indexing.state, "stopped");
    assert.match(recoveredData.indexing.message, /中斷/u);
    assert.equal(recoveredData.indexing.progress?.current, 85);

    const resumed = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: "{}" });
    assert.equal(resumed.status, 202);
    await handle.waitForIndex();
    const completed = await fetch(origin + "/api/index-status", { headers });
    const completedData = await completed.json() as { indexing: { state: string }; counts: { indexed: number } };
    assert.equal(completedData.indexing.state, "complete");
    assert.equal(completedData.counts.indexed, 1);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});
