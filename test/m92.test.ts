import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { documentReference } from "../src/document-reference.js";
import { LibraryStore } from "../src/library.js";
import { createWorkbench } from "../src/workbench.js";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

interface SearchResult { reference: string; path: string }
interface SearchPayload { results: SearchResult[] }

async function seed(): Promise<{ temp: string; root: string; dataHome: string; databasePath: string }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m92-"));
  const root = path.join(temp, "docs");
  const dataHome = path.join(temp, "data");
  const databasePath = path.join(dataHome, "LocalDocSearch", "index.db");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "alpha.txt"), "m92-alpha-needle\n內容 A");
  await writeFile(path.join(root, "beta.txt"), "m92-beta-needle\n內容 B");
  const store = new IndexStore(databasePath, { onWarning: () => {} });
  try { await sync(root, store); }
  finally { store.close(); }
  return { temp, root, dataHome, databasePath };
}

function headers(origin: string, token: string): Record<string, string> {
  return { "X-LocalDocSearch-Token": token, origin, "content-type": "application/json" };
}

async function jsonRequest(origin: string, token: string, pathname: string, method: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const response = await fetch(origin + pathname, {
    method,
    headers: headers(origin, token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

test("M92 loopback 文件庫驗證 token／Origin、四種最近事件、CRUD 與 path 防偽", async () => {
  const fixture = await seed();
  const handle = await createWorkbench({ databasePath: fixture.databasePath, token: "m92-token", secret: Buffer.alloc(32, 9), environment: {}, tempParent: fixture.temp });
  const origin = new URL(handle.url).origin;
  try {
    assert.equal((await fetch(origin + "/api/library/recent")).status, 403);
    assert.equal((await fetch(origin + "/api/library/recent", {
      method: "POST", headers: { "X-LocalDocSearch-Token": handle.token, "content-type": "application/json" },
      body: JSON.stringify({}),
    })).status, 403);

    const searchResponse = await fetch(origin + "/api/search", {
      method: "POST", headers: headers(origin, handle.token),
      body: JSON.stringify({ query: "m92", mode: "phrase", page: 1, pageSize: 20, field: "all", sort: "relevance" }),
    });
    assert.equal(searchResponse.status, 200);
    const searchData = await searchResponse.json() as SearchPayload;
    assert.equal(searchData.results.length, 2);
    const first = searchData.results.find(item => item.path.endsWith("alpha.txt"))!;
    const second = searchData.results.find(item => item.path.endsWith("beta.txt"))!;

    const forged = await jsonRequest(origin, handle.token, "/api/library/recent", "POST", {
      action: "select", path: path.join(fixture.temp, "outside.txt"), reference: first.reference, name: "outside.txt",
    });
    assert.equal(forged.status, 400);
    assert.deepEqual((await jsonRequest(origin, handle.token, "/api/library/recent", "GET")).data, { items: [] });

    for (const action of ["open", "select", "context", "mcp"] as const) {
      const result = await jsonRequest(origin, handle.token, "/api/library/recent", "POST", { action, path: first.path, reference: first.reference, name: "alpha.txt" });
      assert.equal(result.status, 200);
    }
    const recent = await jsonRequest(origin, handle.token, "/api/library/recent", "GET");
    const recentData = recent.data as { items: Array<{ path: string; lastAction: string }> };
    assert.equal(recentData.items.length, 1);
    assert.equal(recentData.items[0]?.lastAction, "mcp");

    const pinned = await jsonRequest(origin, handle.token, "/api/library/pinned", "PUT", { path: first.path, reference: first.reference, name: "alpha.txt" });
    assert.equal(pinned.status, 200);
    const group = await jsonRequest(origin, handle.token, "/api/library/groups", "POST", { name: "M92 分類" });
    assert.equal(group.status, 201);
    const groupId = (group.data as { group: { id: number } }).group.id;
    const groupItem = await jsonRequest(origin, handle.token, `/api/library/groups/${groupId}/items`, "POST", { path: second.path, reference: second.reference, name: "beta.txt" });
    assert.equal(groupItem.status, 200);
    assert.equal(((groupItem.data as { group: { items: unknown[] } }).group.items).length, 1);

    const saved = await jsonRequest(origin, handle.token, "/api/library/saved-searches", "POST", {
      name: "M92 儲存", query: "m92", root: fixture.root, types: [".txt"], sort: "modified", field: "content", mode: "phrase",
    });
    assert.equal(saved.status, 201);
    const savedId = (saved.data as { item: { id: number } }).item.id;
    const changed = await jsonRequest(origin, handle.token, `/api/library/saved-searches/${savedId}`, "PATCH", { name: "M92 更新", query: "m92-beta" });
    assert.equal(changed.status, 200);
    assert.equal((changed.data as { item: { query: string; root: string | null; types: string[]; sort: string } }).item.query, "m92-beta");
    assert.equal((changed.data as { item: { root: string | null } }).item.root, fixture.root);
    assert.deepEqual((changed.data as { item: { types: string[] } }).item.types, [".txt"]);
    assert.equal((await jsonRequest(origin, handle.token, `/api/library/saved-searches/${savedId}`, "DELETE")).status, 200);

    const preview = await jsonRequest(origin, handle.token, "/api/preview", "POST", {
      provider: "openai", model: "gpt-5.6-terra", question: "問題", mode: "phrase",
      selections: [{ query: "m92-beta-needle", reference: second.reference }], fileIds: [],
    });
    assert.equal(preview.status, 200);
    const afterContext = (await jsonRequest(origin, handle.token, "/api/library/recent", "GET")).data as { items: Array<{ path: string; lastAction: string }> };
    assert.equal(afterContext.items.find(item => item.path === second.path)?.lastAction, "context");
  } finally {
    await handle.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("M92 MCP prepare_context 成功後只記錄實際選取文件", async () => {
  const fixture = await seed();
  try {
    const searchStore = new IndexStore(fixture.databasePath, { readOnly: true, onWarning: () => {} });
    let reference = "";
    let selectedPath = "";
    try {
      const row = searchStore.getDocument(path.join(fixture.root, "alpha.txt"));
      assert.ok(row);
      reference = documentReference(row.id, row.path);
      selectedPath = row.path;
    } finally { searchStore.close(); }
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m92", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prepare_context", arguments: { selections: [{ query: "m92-alpha-needle", reference }] } } },
    ];
    const child = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "mcp"], {
      encoding: "utf8", env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: fixture.dataHome },
      input: `${messages.map(message => JSON.stringify(message)).join("\n")}\n`, timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const library = new LibraryStore(fixture.databasePath);
    try {
      const recent = library.listRecent();
      assert.equal(recent.length, 1);
      assert.equal(recent[0]?.path, selectedPath);
      assert.equal(recent[0]?.lastAction, "mcp");
    } finally { library.close(); }
  } finally { await rm(fixture.temp, { recursive: true, force: true }); }
});
