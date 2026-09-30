import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { formatExclusionExplanation, formatExclusionPolicyLines, formatZeroResultExclusionHint, type ExclusionPathResult } from "../src/describe-exclusion.js";
import { explainPathSync } from "../src/exclusion-visibility.js";
import { indexStatus, explainPath } from "../src/mcp-tools.js";
import { MCP_TOOL_NAMES } from "../src/mcp.js";
import { runTui } from "../src/tui.js";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { createWorkbench } from "../src/workbench.js";

interface Fixture {
  temp: string;
  root: string;
  databasePath: string;
  indexed: string;
  excluded: string;
  userExcluded: string;
  filenameOnly: string;
  failed: string;
  unindexed: string;
  outside: string;
}

async function fixture(): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m67-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "data", "index.db");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(path.join(root, "private"), { recursive: true });
  const indexed = path.join(root, "indexed.txt");
  const excluded = path.join(root, "node_modules", "hidden.txt");
  const userExcluded = path.join(root, "private", "secret.txt");
  const filenameOnly = path.join(root, "legacy.class");
  const failed = path.join(root, "failed.txt");
  const unindexed = path.join(root, "after-sync.txt");
  const outside = path.join(temp, "outside.txt");
  await writeFile(path.join(root, ".localdocsearchignore"), "private/\n");
  await writeFile(indexed, "m67-indexed-body");
  await writeFile(excluded, "m67-secret-body");
  await writeFile(userExcluded, "m67-private-body");
  await writeFile(filenameOnly, "m67-class-body");
  await writeFile(failed, "m67-failed-source");
  await writeFile(outside, "m67-outside-body");
  const store = new IndexStore(databasePath);
  try {
    await sync(root, store);
    store.upsert({ path: filenameOnly, filename: "legacy.class", extension: ".class", sizeBytes: 1, modifiedAtMs: 1,
      status: "unsupported", errorCode: null, errorMessage: null, blocks: [] }, root);
    store.upsert({ path: failed, filename: "failed.txt", extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
      status: "error", errorCode: "M67_PARSE_FAILED", errorMessage: "不應輸出這段錯誤原文", blocks: [] }, root);
  } finally { store.close(); }
  return { temp, root, databasePath, indexed, excluded, userExcluded, filenameOnly, failed, unindexed, outside };
}

async function closeFixture(item: Fixture): Promise<void> {
  await rm(item.temp, { recursive: true, force: true });
}

function result(state: ExclusionPathResult["state"], extra: Partial<ExclusionPathResult> = {}): ExclusionPathResult {
  return {
    path: "C:/docs/example.txt", root: "C:/docs", state, exists: true,
    source: null, ruleId: null, matchedRule: null, matchedPath: null, base: null,
    documentStatus: null, errorCode: null, ...extra,
  };
}

test("M67 shared exclusion explanation covers every current path state and never emits content", () => {
  const cases: Array<[ExclusionPathResult, RegExp]> = [
    [result("excluded", { source: "builtin", ruleId: "builtin:node-modules", matchedRule: "**/node_modules/**", matchedPath: "C:/docs/node_modules" }), /已排除.*node_modules/u],
    [result("excluded", { source: "volume-default", ruleId: "volume-default:windows", matchedRule: "Windows/**", matchedPath: "C:/Windows" }), /若真的需要索引.*窄根目錄/u],
    [result("excluded", { source: "user-rule", base: "C:/docs", matchedRule: "private/", matchedPath: "C:/docs/private" }), /user|\.localdocsearchignore/u],
    [result("excluded", { source: "link", matchedRule: "link", matchedPath: "C:/docs/link" }), /連結/u],
    [result("excluded", { source: "index-artifact", matchedRule: "index-artifact", matchedPath: "C:/docs/.work.sqlite" }), /索引內部/u],
    [result("indexed", { documentStatus: "indexed" }), /已索引/u],
    [result("unindexed", { exists: true }), /尚未索引/u],
    [result("parse-failed", { documentStatus: "error", errorCode: "XML_BAD" }), /解析失敗.*XML_BAD/u],
    [result("filename-only", { documentStatus: "unsupported" }), /僅檔名.*不支援格式/u],
    [result("filename-only", { documentStatus: "too_large" }), /僅檔名.*檔案太大/u],
    [result("filename-only", { documentStatus: "encrypted" }), /僅檔名.*檔案加密/u],
    [result("outside-root", { root: null }), /不在任何已登錄根目錄/u],
  ];
  for (const [item, pattern] of cases) {
    const text = formatExclusionExplanation(item);
    assert.match(text, pattern);
    assert.doesNotMatch(text, /m67-secret-body|不應輸出這段錯誤原文/u);
  }
  assert.match(formatZeroResultExclusionHint("cli"), /seekah explain <路徑>.*docsearch explain <路徑>/u);
  assert.doesNotMatch(formatZeroResultExclusionHint("cli"), /\/explain/u);
  assert.match(formatZeroResultExclusionHint("tui"), /\/explain <路徑>/u);
  assert.doesNotMatch(formatZeroResultExclusionHint("tui"), /seekah explain/u);
  assert.match(formatZeroResultExclusionHint("workbench"), /下方輸入檔案路徑/u);
  const policyText = formatExclusionPolicyLines({
    root: "C:/docs",
    rules: [{ id: "builtin:test", pattern: "test/**", name: "測試規則", reason: "測試理由", warning: "測試警告", source: "builtin" }],
    ignoreFiles: [],
  }).join("\n");
  assert.match(policyText, /最近略過：未提供/u);
  assert.match(policyText, /排除清理：未提供/u);
  assert.doesNotMatch(policyText, /最近略過：0/u);
});

test("M67 CLI exclusions, explain and status expose policy without document content", async () => {
  const item = await fixture();
  try {
    const cli = path.resolve("dist/src/cli.js");
    const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(item.temp, "cli-data") };
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, timeout: 30_000 });
    const indexed = run("index", item.root);
    assert.equal(indexed.status, 0, indexed.stderr);
    const exclusions = run("exclusions");
    assert.equal(exclusions.status, 0, exclusions.stderr);
    assert.match(exclusions.stdout, /預設排除規則/u);
    assert.match(exclusions.stdout, /node_modules 套件資料/u);
    assert.match(exclusions.stdout, /\.localdocsearchignore/u);
    assert.match(exclusions.stdout, /最近略過/u);
    assert.doesNotMatch(exclusions.stdout, /m67-secret-body|m67-private-body/u);
    const excluded = run("explain", item.excluded);
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.match(excluded.stdout, /已排除/u);
    assert.match(excluded.stdout, /若真的需要索引/u);
    const indexedExplain = run("explain", item.indexed);
    assert.match(indexedExplain.stdout, /已索引/u);
    const outside = run("explain", item.outside);
    assert.match(outside.stdout, /不在任何已登錄根目錄/u);
    const status = run("status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /排除摘要/u);
    assert.match(status.stdout, /最近逐規則略過/u);
    const help = run("--help");
    assert.match(help.stdout, /exclusions \[--root <path>\]/u);
    assert.match(help.stdout, /explain <path>/u);
  } finally { await closeFixture(item); }
});

test("M67 workbench exclusions and explain validate token, origin, length and current state", async () => {
  const item = await fixture();
  const handle = await createWorkbench({ databasePath: item.databasePath, token: "m67-token", secret: Buffer.alloc(32, 7), environment: {}, tempParent: item.temp });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "m67-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const exclusions = await fetch(origin + "/api/exclusions", { headers });
    assert.equal(exclusions.status, 200);
    const exclusionData = await exclusions.json() as { roots: Array<{ root: string; rules: Array<{ name: string }>; summary: string }>; };
    assert.equal(exclusionData.roots[0]?.root, path.resolve(item.root));
    assert.ok(exclusionData.roots[0]?.rules.some(rule => rule.name.includes("node_modules")));
    assert.match(exclusionData.roots[0]!.summary, /預設排除/u);
    const preview = await fetch(origin + "/api/exclusions?root=" + encodeURIComponent(item.root), { headers });
    assert.equal(preview.status, 200);
    const registeredPreview = await preview.json() as { requested: { root: string; ignoreFiles: Array<{ patterns: string[] }> } };
    assert.equal(registeredPreview.requested.root, path.resolve(item.root));
    assert.ok(registeredPreview.requested.ignoreFiles.some(file => file.patterns.includes("private/")));
    const unregisteredRoot = path.join(item.temp, "unregistered-preview");
    await mkdir(unregisteredRoot, { recursive: true });
    await writeFile(path.join(unregisteredRoot, ".localdocsearchignore"), "m67-preview-secret/**\n");
    const unregisteredPreview = await fetch(origin + "/api/exclusions?root=" + encodeURIComponent(unregisteredRoot), { headers });
    assert.equal(unregisteredPreview.status, 200);
    const unregisteredData = await unregisteredPreview.json() as { requested: { root: string; ignoreFiles: Array<{ patterns: string[] }> } };
    assert.equal(unregisteredData.requested.root, path.resolve(unregisteredRoot));
    assert.deepEqual(unregisteredData.requested.ignoreFiles, []);
    assert.doesNotMatch(JSON.stringify(unregisteredData), /m67-preview-secret/u);
    const excluded = await fetch(origin + "/api/explain", { method: "POST", headers: postHeaders, body: JSON.stringify({ path: item.excluded, state: "indexed" }) });
    assert.equal(excluded.status, 200);
    const excludedData = await excluded.json() as { state: string; message: string; errorMessage?: string };
    assert.equal(excludedData.state, "excluded");
    assert.match(excludedData.message, /若真的需要索引/u);
    assert.equal("errorMessage" in excludedData, false);
    const unindexed = await fetch(origin + "/api/explain", { method: "POST", headers: postHeaders, body: JSON.stringify({ path: item.unindexed }) });
    assert.equal((await unindexed.json() as { state: string }).state, "unindexed");
    const outside = await fetch(origin + "/api/explain", { method: "POST", headers: postHeaders, body: JSON.stringify({ path: item.outside }) });
    assert.equal(outside.status, 200);
    const outsideData = await outside.json() as { state: string; message: string; exists?: boolean };
    assert.equal(outsideData.state, "outside-root");
    assert.match(outsideData.message, /不在任何已登錄根目錄內/u);
    assert.equal("exists" in outsideData, false);
    const wrongToken = await fetch(origin + "/api/exclusions");
    assert.equal(wrongToken.status, 403);
    const wrongOrigin = await fetch(origin + "/api/explain", { method: "POST", headers: { ...headers, origin: "http://127.0.0.1:1", "content-type": "application/json" }, body: JSON.stringify({ path: item.indexed }) });
    assert.equal(wrongOrigin.status, 403);
    const wrongType = await fetch(origin + "/api/explain", { method: "POST", headers: postHeaders, body: JSON.stringify({ path: 42 }) });
    assert.equal(wrongType.status, 400);
    const tooLong = await fetch(origin + "/api/explain", { method: "POST", headers: postHeaders, body: JSON.stringify({ path: "x".repeat(16_385) }) });
    assert.equal(tooLong.status, 400);
  } finally { await handle.close(); await closeFixture(item); }
});

test("M67 Windows explain matches indexed paths case-insensitively", { skip: process.platform === "win32" ? false : "Windows-only path semantics" }, async () => {
  const item = await fixture();
  const store = new IndexStore(item.databasePath);
  try {
    const explained = explainPathSync(store, item.indexed.toLowerCase());
    assert.equal(explained.state, "indexed");
    assert.equal(explained.documentStatus, "indexed");
  } finally {
    store.close();
    await closeFixture(item);
  }
});

test("M67 TUI status and explain show the shared current explanation and zero-result hint", async () => {
  const item = await fixture();
  const store = new IndexStore(item.databasePath);
  try {
    const output: string[] = [];
    const answers = ["not-found-m67", "/status", `/explain ${item.excluded}`, "/quit"];
    assert.equal(await runTui(store, { ansi: false, write: value => output.push(value), ask: async () => answers.shift() ?? null }, 1), 0);
    const text = output.join("\n");
    assert.match(text, /\/explain/u);
    assert.match(text, /預設排除摘要/u);
    assert.match(text, /已排除/u);
    assert.doesNotMatch(text, /m67-secret-body/u);
  } finally { store.close(); await closeFixture(item); }
});

test("M67 MCP index_status adds exclusion policy and explain_path stays read-only", async () => {
  const item = await fixture();
  const store = new IndexStore(item.databasePath, { readOnly: true });
  try {
    const status = indexStatus(store) as { exclusions: Array<{ root: string; summary: string }>; roots: unknown[] };
    assert.equal(status.roots.length, 1);
    assert.equal(status.exclusions[0]?.root, path.resolve(item.root));
    assert.match(status.exclusions[0]?.summary ?? "", /預設排除/u);
    const explained = explainPath(store, item.userExcluded);
    assert.equal(explained.state, "excluded");
    assert.match(explained.message, /\.localdocsearchignore|使用者/u);
    assert.doesNotMatch(JSON.stringify(explained), /m67-private-body|errorMessage/u);
    const outside = explainPath(store, item.outside);
    assert.equal(outside.state, "outside-root");
    assert.equal("exists" in outside, false);
    assert.match(outside.message, /不在任何已登錄根目錄內/u);
    assert.ok(MCP_TOOL_NAMES.includes("explain_path"));
  } finally { store.close(); await closeFixture(item); }
});