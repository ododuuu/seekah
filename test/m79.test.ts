import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbench } from "../src/workbench.js";
import { WorkbenchSearchManager, searchClientId } from "../src/workbench-search.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
async function seedIndex(temp: string): Promise<{ databasePath: string; root: string }> {
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "documents");
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "one.txt"), "m79-shared needle one\n"),
    writeFile(path.join(root, "two.txt"), "m79-shared needle two\n"),
    writeFile(path.join(root, "three.txt"), "m79-shared needle three\n"),
  ]);
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  return { databasePath, root };
}

function body(query: string, page = 1, pageSize = 20, mode: "phrase" | "all-terms" = "phrase"): string {
  return JSON.stringify({ query, mode, page, pageSize, field: "all", sort: "relevance" });
}

function headers(token: string, origin: string, client: string): Record<string, string> {
  return {
    "X-LocalDocSearch-Token": token,
    "X-LocalDocSearch-Client": client,
    origin,
    "content-type": "application/json",
  };
}

function wait(milliseconds: number): Promise<void> {
  // 這兩個整合測試必須讓真實 HTTP request 進入 slow worker；虛擬時間無法驅動 fetch／worker thread。
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function startManagerHarness(databasePath: string, idleMs: number): Promise<{
  origin: string;
  manager: WorkbenchSearchManager;
  close: () => Promise<void>;
}> {
  const manager = new WorkbenchSearchManager(databasePath, 0, idleMs);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const page = Number(url.searchParams.get("page") ?? "1");
      const execution = await manager.run(searchClientId(request), {
        query: "m79-shared",
        mode: "phrase",
        page: Number.isSafeInteger(page) && page > 0 ? page : 1,
        pageSize: 1,
        field: "all",
        sort: "relevance",
      }, request, response);
      if (execution.kind === "cancelled") {
        response.writeHead(499);
        response.end();
        return;
      }
      const body = JSON.stringify(execution.result);
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    } catch (error) {
      if (response.writableEnded) return;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("M79 manager test server 未取得 port。");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    manager,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await manager.close();
    },
  };
}

async function managerSearch(origin: string, client: string, page = 1, rawClient = client): Promise<Response> {
  return fetch(`${origin}/search?page=${page}`, { headers: { "X-LocalDocSearch-Client": rawClient } });
}

test("M79 搜尋 worker 不阻塞工作台狀態路由，且同 client 新搜尋取消舊工作", { timeout: 20_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m79-worker-"));
  const { databasePath } = await seedIndex(temp);
  const handle = await createWorkbench({
    databasePath,
    token: "m79-worker",
    secret: Buffer.alloc(32, 79),
    environment: {},
    tempParent: temp,
    searchDelayMs: 1_500,
  });
  t.after(async () => {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  });
  const origin = handle.url.split("/#")[0]!;
  const client = "m79-browser-client";
  const requestHeaders = headers(handle.token, origin, client);
  const slow = fetch(origin + "/api/search", {
    method: "POST", headers: requestHeaders, body: body("m79-shared"),
  });
  await wait(100);
  const statusStarted = performance.now();
  const status = await fetch(origin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": handle.token, origin } });
  const statusElapsed = performance.now() - statusStarted;
  assert.equal(status.status, 200);
  assert.ok(statusElapsed < 1_000, `狀態路由被搜尋拖慢：${statusElapsed.toFixed(1)}ms`);

  const replacement = fetch(origin + "/api/search", {
    method: "POST", headers: requestHeaders, body: body("m79-shared", 1, 1, "all-terms"),
  });
  const slowResponse = await slow;
  assert.equal(slowResponse.status, 499);
  assert.deepEqual(await slowResponse.json(), { code: "SEARCH_CANCELLED", error: "搜尋已取消。" });
  const replacementResponse = await replacement;
  assert.equal(replacementResponse.status, 200);
  const replacementData = await replacementResponse.json() as { results: unknown[] };
  assert.equal(replacementData.results.length, 1);
});

test("M79 不同搜尋 client 互不取消彼此的 worker", { timeout: 20_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m79-clients-"));
  const { databasePath } = await seedIndex(temp);
  const handle = await createWorkbench({
    databasePath,
    token: "m79-clients",
    secret: Buffer.alloc(32, 82),
    environment: {},
    tempParent: temp,
    searchDelayMs: 1_500,
  });
  t.after(async () => {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  });
  const origin = handle.url.split("/#")[0]!;
  const request = (client: string) => fetch(origin + "/api/search", {
    method: "POST",
    headers: headers(handle.token, origin, client),
    body: body("m79-shared"),
  });
  const [first, second] = await Promise.all([request("m79-client-a"), request("m79-client-b")]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json() as { results: unknown[] }).results.length, 3);
  assert.equal((await second.json() as { results: unknown[] }).results.length, 3);
});

test("M79 request close 會終止搜尋 worker，後續搜尋可重新建立連線", { timeout: 20_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m79-close-"));
  const { databasePath } = await seedIndex(temp);
  const handle = await createWorkbench({
    databasePath,
    token: "m79-close",
    secret: Buffer.alloc(32, 80),
    environment: {},
    tempParent: temp,
    searchDelayMs: 1_500,
  });
  t.after(async () => {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  });
  const origin = handle.url.split("/#")[0]!;
  const client = "m79-abort-client";
  const controller = new AbortController();
  const aborted = fetch(origin + "/api/search", {
    method: "POST", headers: headers(handle.token, origin, client), body: body("m79-shared"), signal: controller.signal,
  });
  await wait(100);
  controller.abort();
  await assert.rejects(aborted, error => error instanceof Error && error.name === "AbortError");
  const followUp = await fetch(origin + "/api/search", {
    method: "POST", headers: headers(handle.token, origin, client), body: body("m79-shared"),
  });
  assert.equal(followUp.status, 200);
  assert.equal((await followUp.json() as { results: unknown[] }).results.length, 3);
});

test("M79 search page 後 exact count 重用同一 session 並保留分頁結果", { timeout: 20_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m79-count-"));
  const { databasePath } = await seedIndex(temp);
  const handle = await createWorkbench({ databasePath, token: "m79-count", secret: Buffer.alloc(32, 81), environment: {}, tempParent: temp });
  t.after(async () => {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  });
  const origin = handle.url.split("/#")[0]!;
  const requestHeaders = headers(handle.token, origin, "m79-count-client");
  const first = await fetch(origin + "/api/search", { method: "POST", headers: requestHeaders, body: body("m79-shared", 1, 1) });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { results: unknown[] }).results.length, 1);
  const count = await fetch(origin + "/api/search/count", { method: "POST", headers: requestHeaders, body: body("m79-shared", 1, 1) });
  assert.equal(count.status, 200);
  assert.deepEqual(await count.json(), { total: 3, totalRelation: "eq" });
  const second = await fetch(origin + "/api/search", { method: "POST", headers: requestHeaders, body: body("m79-shared", 2, 1) });
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { page: number; results: unknown[] }).page, 2);
});

test("M79 搜尋 worker 有全域上限、LRU／閒置回收與回收後 session 重建", { timeout: 30_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m79-worker-cap-"));
  const { databasePath } = await seedIndex(temp);
  const harness = await startManagerHarness(databasePath, 1_000);
  t.after(async () => {
    await harness.close();
    await rm(temp, { recursive: true, force: true });
  });

  const firstPage = await managerSearch(harness.origin, "m79-cap-0", 1);
  assert.equal(firstPage.status, 200);
  const firstPageData = await firstPage.json() as { page: number; results: unknown[] };
  assert.equal(firstPageData.page, 1);
  const beforeEviction = await managerSearch(harness.origin, "m79-cap-0", 2);
  assert.equal(beforeEviction.status, 200);
  const beforeEvictionData = await beforeEviction.json() as { page: number; results: unknown[] };
  assert.equal(beforeEvictionData.page, 2);

  for (let index = 1; index <= 4; index += 1) {
    const response = await managerSearch(harness.origin, `m79-cap-${index}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { results: unknown[] }).results.length, 1);
  }
  assert.equal(harness.manager.stats().workerCount, 4);
  assert.equal(harness.manager.stats().clientCount, 4);

  const afterEviction = await managerSearch(harness.origin, "m79-cap-0", 2);
  assert.equal(afterEviction.status, 200);
  const afterEvictionData = await afterEviction.json() as { page: number; results: unknown[] };
  assert.deepEqual(afterEvictionData.results, beforeEvictionData.results);
  assert.equal(harness.manager.stats().workerCount, 4);

  const invalidHeader = await managerSearch(harness.origin, "m79-invalid", 1, "x".repeat(65));
  assert.equal(invalidHeader.status, 200);
  assert.equal(harness.manager.stats().workerCount <= 4, true);
  assert.equal(harness.manager.stats().clientCount <= 4, true);
  const invalidFormat = await managerSearch(harness.origin, "m79-invalid-format", 1, "bad space");
  assert.equal(invalidFormat.status, 200);
  for (let index = 0; index < 8; index += 1) {
    const response = await managerSearch(harness.origin, `m79-flood-${index}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(harness.manager.stats().workerCount <= 4, true);
  }

  await wait(1_400);
  assert.equal(harness.manager.stats().workerCount, 0);
  assert.equal(harness.manager.stats().clientCount, 0);

  const afterIdle = await managerSearch(harness.origin, "m79-cap-0", 2);
  assert.equal(afterIdle.status, 200);
  const afterIdleData = await afterIdle.json() as { page: number; results: unknown[] };
  assert.deepEqual(afterIdleData.results, beforeEvictionData.results);
  assert.equal(harness.manager.stats().workerCount, 1);
});
