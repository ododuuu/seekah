import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setupCodex, runDoctor, type CommandResult } from "../src/host-setup.js";
import { MCP_APP_HTML, MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_URI } from "../src/mcp-app.js";
import { defaultDatabasePath, IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { productVersion } from "../src/version.js";

test("0.34 MCP App is self-contained and uses the portable bridge", () => {
  assert.match(MCP_APP_RESOURCE_URI, /^ui:\/\//u);
  assert.equal(MCP_APP_MIME_TYPE, "text/html;profile=mcp-app");
  assert.match(MCP_APP_HTML, /tools\/call/u);
  assert.match(MCP_APP_HTML, /ui\/initialize/u);
  assert.match(MCP_APP_HTML, /ui\/notifications\/initialized/u);
  assert.match(MCP_APP_HTML, /appInfo: \{ name: 'localdocsearch-search-app'/u);
  assert.match(MCP_APP_HTML, /ui\/update-model-context/u);
  assert.match(MCP_APP_HTML, /ui\/message/u);
  assert.match(MCP_APP_HTML, /content: \[\{ type: 'text', text: questionEl\.value\.trim\(\) \}\]/u);
  assert.match(MCP_APP_HTML, /MAX_SELECTIONS = 20/u);
  assert.match(MCP_APP_HTML, /搜尋模式已變更，既有選取已清空；請重新搜尋/u);
  assert.match(MCP_APP_HTML, /query: String\(data\.query/u);
  assert.match(MCP_APP_HTML, /maybeSearchInitialQuery\(\)/u);
  assert.doesNotMatch(MCP_APP_HTML, /https?:\/\//iu);
  assert.doesNotMatch(MCP_APP_HTML, /\bfetch\s*\(/iu);
  assert.doesNotMatch(MCP_APP_HTML, /WebSocket|innerHTML/iu);
});

test("0.34 stdio publishes one UI resource and five decoupled tools", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m34-protocol-"));
  const root = path.join(temp, "文件");
  const data = path.join(temp, "data");
  await mkdir(root);
  await writeFile(path.join(root, "介面.txt"), "mcp-app-protocol-needle");
  const oldData = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = data;
  const store = new IndexStore(defaultDatabasePath());
  try {
    await sync(root, store);
    store.close();
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: MCP_APP_RESOURCE_URI } },
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "open_search_app", arguments: { query: "mcp-app-protocol-needle", mode: "phrase" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_documents", arguments: { query: "mcp-app-protocol-needle" } } },
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
    const resources = responses.find(item => item.id === 2)?.result?.resources as Array<Record<string, unknown>>;
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.uri, MCP_APP_RESOURCE_URI);
    assert.equal(resources[0]?.mimeType, MCP_APP_MIME_TYPE);
    const contents = responses.find(item => item.id === 3)?.result?.contents as Array<Record<string, unknown>>;
    assert.equal(contents[0]?.mimeType, MCP_APP_MIME_TYPE);
    assert.match(String(contents[0]?.text), /Seekah 搜尋工作台/u);
    const tools = responses.find(item => item.id === 4)?.result?.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    assert.deepEqual(tools.map(tool => tool.name), ["search_documents", "prepare_context", "index_status", "explain_path", "open_search_app"]);
    const renderTool = tools.find(tool => tool.name === "open_search_app");
    assert.equal((renderTool?._meta?.ui as { resourceUri?: string })?.resourceUri, MCP_APP_RESOURCE_URI);
    assert.equal(renderTool?._meta?.["openai/outputTemplate"], MCP_APP_RESOURCE_URI);
    assert.match(JSON.stringify(responses.find(item => item.id === 5)), /selectionLimit/u);
    assert.match(JSON.stringify(responses.find(item => item.id === 6)), /mcp-app-protocol-needle/u);
    assert.ok(lines.every(line => line.startsWith("{")), child.stdout);
    assert.match(child.stderr, new RegExp(`${productVersion.replaceAll(".", "\\.")} running on stdio`, "u"));
  } finally {
    try { store.close(); } catch {}
    if (oldData === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = oldData;
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.34 setup codex dry-run is mutation-free and preserves special paths as argv", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds setup (測試)-"));
  const cliPath = path.join(temp, "中文 CLI (1).js");
  await writeFile(cliPath, "");
  const output: string[] = [];
  let calls = 0;
  try {
    const status = setupCodex({
      cliPath,
      nodePath: path.join(temp, "Node (測試)", "node"),
      dryRun: true,
      runner: () => { calls++; throw new Error("dry-run 不可執行"); },
      write: text => output.push(text),
    });
    assert.equal(status, 0);
    assert.equal(calls, 0);
    assert.match(output.join("\n"), /中文 CLI \(1\)\.js/u);
    assert.match(output.join("\n"), /"mcp"/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.34 setup codex adds once and treats the same registration as idempotent", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m34-setup-"));
  const cliPath = path.join(temp, "cli.js");
  const nodePath = path.join(temp, "node");
  await writeFile(cliPath, "");
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  try {
    const responses: CommandResult[] = [
      { status: 1, stdout: "", stderr: "Error: No MCP server named 'localdocsearch' found." },
      { status: 0, stdout: "Added", stderr: "" },
    ];
    const added = setupCodex({ cliPath, nodePath, runner: (command, args) => {
      calls.push({ command, args });
      return responses.shift()!;
    }, write: () => {}, writeError: () => {} });
    assert.equal(added, 0);
    assert.deepEqual(calls[1], { command: "codex", args: ["mcp", "add", "localdocsearch", "--", path.resolve(nodePath), path.resolve(cliPath), "mcp"] });

    const existing = JSON.stringify({ name: "localdocsearch", transport: { type: "stdio", command: path.resolve(nodePath), args: [path.resolve(cliPath), "mcp"] } });
    let idempotentCalls = 0;
    const idempotent = setupCodex({ cliPath, nodePath, runner: () => {
      idempotentCalls++;
      return { status: 0, stdout: existing, stderr: "" };
    }, write: () => {}, writeError: () => {} });
    assert.equal(idempotent, 0);
    assert.equal(idempotentCalls, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.34 setup codex refuses conflicts and missing Codex without overwriting", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m34-conflict-"));
  const cliPath = path.join(temp, "cli.js");
  await writeFile(cliPath, "");
  try {
    let calls = 0;
    const conflict = setupCodex({ cliPath, runner: () => {
      calls++;
      return { status: 0, stdout: JSON.stringify({ transport: { type: "stdio", command: "/other/node", args: ["/other/cli.js", "mcp"] } }), stderr: "" };
    }, write: () => {}, writeError: () => {} });
    assert.equal(conflict, 3);
    assert.equal(calls, 1);
    const missing = setupCodex({ cliPath, runner: () => ({ status: null, stdout: "", stderr: "", errorCode: "ENOENT" }), write: () => {}, writeError: () => {} });
    assert.equal(missing, 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.34 doctor is read-only and distinguishes missing prerequisites from a healthy index", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m34-doctor-"));
  const root = path.join(temp, "docs");
  const cliPath = path.join(temp, "dist", "src", "cli.js");
  const databasePath = path.join(temp, "data", "index.db");
  await mkdir(root);
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "");
  const missingOutput: string[] = [];
  try {
    assert.equal(runDoctor({ databasePath, cliPath, nodeVersion: "22.16.9", write: text => missingOutput.push(text) }), 3);
    assert.match(missingOutput.join("\n"), /\[失敗\] Node\.js/u);
    assert.match(missingOutput.join("\n"), /\[失敗\] 本機索引/u);
    await writeFile(path.join(root, "健康.txt"), "doctor-health-needle");
    const store = new IndexStore(databasePath);
    await sync(root, store);
    store.close();
    const before = await stat(databasePath);
    const output: string[] = [];
    assert.equal(runDoctor({ databasePath, cliPath, nodeVersion: "22.17.0", write: text => output.push(text) }), 0);
    const after = await stat(databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.match(output.join("\n"), /\[通過\] MCP／App：5 個工具與 1 個本機 UI resource 可註冊/u);
    assert.match(output.at(-1) ?? "", /全部通過/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
