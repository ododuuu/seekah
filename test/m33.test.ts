import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSelectedContext } from "../src/context.js";
import { indexStatus, prepareContextTool, searchDocuments } from "../src/mcp-tools.js";
import { search } from "../src/search.js";
import { defaultDatabasePath, IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { runTui } from "../src/tui.js";

async function fixture(run: (root: string, store: IndexStore, temp: string) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m33-"));
  const root = path.join(temp, "文件");
  await mkdir(root);
  const store = new IndexStore(path.join(temp, "index.db"));
  try {
    await writeFile(path.join(root, "甲.txt"), "共同詞 已選片段 第一段\n共同詞 已選片段 第二段");
    await writeFile(path.join(root, "乙.md"), "共同詞 未選取私密內容");
    await sync(root, store);
    await run(root, store, temp);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
}

test("0.33 MCP tools search bounded pages and prepare only selected context", () => fixture(async (root, store) => {
  const page = searchDocuments(store, { query: "共同詞", page: 1, pageSize: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.results.length, 1);
  assert.equal(page.pageCount, 2);
  assert.throws(() => searchDocuments(store, { query: "共同詞", page: 51, pageSize: 10 }), { code: "MCP_PAGE_INVALID" });
  assert.throws(() => searchDocuments(store, { query: "共同詞", root: path.join(path.dirname(root), "索引外") }), { code: "MCP_ROOT_NOT_INDEXED" });

  const chosen = search(store, "共同詞", 20).find(result => result.path.endsWith("甲.txt"))!;
  const prepared = await prepareContextTool(store, {
    selections: [{ query: "共同詞", reference: chosen.reference }], passages: 2,
  });
  assert.match(prepared.text, /已選片段/u);
  assert.doesNotMatch(prepared.text, /未選取私密內容|乙\.md/u);
  assert.equal(prepared.data.documents.length, 1);
  assert.equal(prepared.data.documents[0]!.passages.length, 2);

  const status = indexStatus(store);
  assert.equal(status.readOnly, true);
  assert.equal(status.roots[0]?.path, root);
  assert.equal(status.counts.indexed, 2);
}));

test("0.33 selected context rejects duplicate, stale and oversized selections", () => fixture(async (_root, store) => {
  const result = search(store, "共同詞", 20)[0]!;
  await assert.rejects(prepareSelectedContext(store, [
    { query: "共同詞", reference: result.reference },
    { query: "共同詞", reference: result.reference },
  ]), { code: "CONTEXT_SELECTION_INVALID" });
  await assert.rejects(prepareSelectedContext(store, [{ query: "不再命中", reference: result.reference }]), { code: "CONTEXT_REFERENCE_MISSING" });
  await assert.rejects(prepareSelectedContext(store, [{ query: "共同詞", reference: result.reference }], { passages: 11 }), { code: "CONTEXT_OPTIONS_INVALID" });
}));

test("0.33 TUI selection requires explicit yes and rejects mixed search modes", () => fixture(async (_root, store) => {
  const answers: Array<string | null> = [
    "共同詞", "/select 1", "/all 共同詞", "/select 1", "/clear", "/select 1",
    "/context 2", "no", "/context 2", "yes", "/selected", "/quit",
  ];
  const output: string[] = [];
  const clipboard: string[] = [];
  assert.equal(await runTui(store, {
    ansi: false,
    write: value => output.push(value),
    ask: async () => answers.shift() ?? null,
  }, 10, async value => { clipboard.push(value); }), 0);
  const rendered = output.join("\n");
  assert.match(rendered, /\[x\]/u);
  assert.match(rendered, /不可混用片語與全部詞模式/u);
  assert.match(rendered, /已取消，未改動剪貼簿/u);
  assert.equal(clipboard.length, 1);
  assert.match(clipboard[0]!, /Seekah 上下文|共同詞/u);
}));

test("0.33 stdio MCP initializes, lists tools and calls search without stdout noise", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m33-protocol-"));
  const root = path.join(temp, "docs");
  const data = path.join(temp, "data");
  await mkdir(root);
  await writeFile(path.join(root, "協定.txt"), "mcp-protocol-needle");
  const oldData = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = data;
  const databasePath = defaultDatabasePath();
  const store = new IndexStore(databasePath);
  try {
    await sync(root, store);
    store.close();
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_documents", arguments: { query: "mcp-protocol-needle" } } },
    ];
    const child = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "mcp"], {
      encoding: "utf8",
      env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: data },
      input: `${messages.map(message => JSON.stringify(message)).join("\n")}\n`,
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const lines = child.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const responses = lines.map(line => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });
    const tools = responses.find(item => item.id === 2)?.result?.tools as Array<{ name: string }>;
    assert.deepEqual(tools.map(tool => tool.name), ["search_documents", "prepare_context", "index_status", "explain_path", "open_search_app"]);
    assert.match(JSON.stringify(responses.find(item => item.id === 3)), /mcp-protocol-needle/u);
    assert.ok(lines.every(line => line.startsWith("{")), child.stdout);
    assert.match(child.stderr, /running on stdio/u);
  } finally {
    try { store.close(); } catch {}
    if (oldData === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = oldData;
    await rm(temp, { recursive: true, force: true });
  }
});
